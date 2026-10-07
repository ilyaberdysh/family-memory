import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../shared/types.js';

/**
 * Multi-family storage on PostgreSQL.
 *
 * Every family-owned row carries `family_id`. Isolation is enforced twice:
 * 1. FamilyStore adds `family_id = <current family>` to every statement it builds;
 * 2. Row-Level Security in the database hides and refuses rows of any other family,
 *    so a forgotten filter in application code still cannot read or write another family's data.
 * Transactions always run as the restricted role `family_app` (RLS applies even when the
 * connection user is a superuser). Cross-family maintenance must say so explicitly via `system()`.
 *
 * Documents stay JSONB (`data`) with promoted, indexed key columns; ordering uses `seq`.
 */

export const GLOBAL_TABLES = ['families', 'users', 'memberships', 'sessions', 'auth_flows', 'codes', 'invitation_links'] as const;
export const FAMILY_TABLES = ['people', 'facts', 'relations', 'materials', 'history', 'conversations', 'files', 'jobs', 'invitations'] as const;
export type GlobalTable = typeof GLOBAL_TABLES[number];
export type FamilyTable = typeof FAMILY_TABLES[number];
type Param = string | number | boolean | null;
type Row = { id: string; family_id?: string; data: unknown };

interface Connection { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
interface Driver { connect<T>(fn: (connection: Connection) => Promise<T>): Promise<T>; close(): Promise<void> }

const MIGRATIONS: string[] = [
  // 1: multi-family schema
  `
  DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'family_app') THEN CREATE ROLE family_app NOLOGIN; END IF; END $$;
  CREATE TABLE families (id uuid PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
  CREATE TABLE users (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
  CREATE UNIQUE INDEX users_telegram_id ON users ((data->>'telegramId')) WHERE coalesce(data->>'telegramId', '') <> '';
  CREATE UNIQUE INDEX users_telegram_subject ON users ((data->>'telegramSubject')) WHERE coalesce(data->>'telegramSubject', '') <> '';
  CREATE UNIQUE INDEX users_email ON users (lower(data->>'email')) WHERE coalesce(data->>'email', '') <> '';
  CREATE TABLE memberships (id text PRIMARY KEY, family_id uuid NOT NULL REFERENCES families(id), user_id text NOT NULL REFERENCES users(id), data jsonb NOT NULL, seq bigserial, UNIQUE (family_id, user_id));
  CREATE INDEX memberships_user ON memberships (user_id);
  CREATE TABLE sessions (id text PRIMARY KEY, user_id text NOT NULL, data jsonb NOT NULL, seq bigserial);
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE TABLE auth_flows (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
  CREATE TABLE codes (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
  CREATE TABLE invitation_links (id text PRIMARY KEY, family_id uuid NOT NULL REFERENCES families(id), data jsonb NOT NULL, seq bigserial);
  CREATE UNIQUE INDEX invitation_links_token ON invitation_links ((data->>'tokenHash'));
  ${FAMILY_TABLES.map(table => `
  CREATE TABLE ${table} (id text PRIMARY KEY, family_id uuid NOT NULL REFERENCES families(id), data jsonb NOT NULL, seq bigserial);
  CREATE INDEX ${table}_family ON ${table} (family_id, seq);
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY ${table}_isolation ON ${table}
    USING (current_setting('app.system', true) = 'on' OR family_id = nullif(current_setting('app.family_id', true), '')::uuid)
    WITH CHECK (current_setting('app.system', true) = 'on' OR family_id = nullif(current_setting('app.family_id', true), '')::uuid);`).join('\n')}
  CREATE UNIQUE INDEX facts_unique ON facts (family_id, (data->>'personId'), (data->>'key'));
  CREATE INDEX history_entity ON history (family_id, (data->>'entityType'), (data->>'entityId'), seq);
  CREATE INDEX materials_file ON materials (family_id, (data->'file'->>'id'));
  CREATE INDEX people_avatar ON people (family_id, (data->>'avatarFileId'));
  CREATE INDEX jobs_status ON jobs ((data->>'status'), seq);
  CREATE INDEX files_preview ON files ((data->>'previewStatus'), seq);
  GRANT USAGE ON SCHEMA public TO family_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO family_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO family_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO family_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO family_app;
  `,
  // 2: a non-superuser application user (managed PostgreSQL, PG16+) needs explicit membership to SET ROLE family_app
  `GRANT family_app TO CURRENT_USER;`,
];

function pgDriver(url: string): Driver {
  let pool: import('pg').Pool | undefined;
  const ready = import('pg').then(({ default: pg }) => { pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE) || 10 });
    // A dropped idle connection (database restart, network blip) must not crash the process; the pool reconnects.
    pool.on('error', error => console.error('PostgreSQL idle connection error:', error.message));
    return pool; });
  return {
    async connect(fn) { const client = await (await ready).connect(); try { return await fn(client); } finally { client.release(); } },
    async close() { await (await ready).end(); void pool; },
  };
}

/** In-process PostgreSQL (WASM) for local preview and tests: one connection, so access is serialised. */
function pgliteDriver(directory?: string): Driver {
  const ready = import('@electric-sql/pglite').then(({ PGlite }) => PGlite.create(directory ? { dataDir: directory } : undefined));
  let queue: Promise<unknown> = Promise.resolve();
  return {
    connect<T>(fn: (connection: Connection) => Promise<T>) {
      const run = queue.then(async () => fn(await ready as unknown as Connection));
      queue = run.catch(() => {});
      return run;
    },
    async close() { await queue; await (await ready).close(); },
  };
}

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(row: Record<string, unknown>) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as T;

class Statements {
  constructor(protected readonly connection: Connection) {}
  async rows<T>(text: string, params: unknown[] = []): Promise<T[]> { return (await this.connection.query(text, params)).rows.map(row => parse<T>(row)); }
  async raw(text: string, params: unknown[] = []) { return (await this.connection.query(text, params)).rows; }
}

/** Accounts, sessions, families and memberships: shared by the whole service, never family content. */
export class GlobalStore extends Statements {
  async get<T>(table: GlobalTable, id: string) { return (await this.rows<T>(`SELECT data FROM ${table} WHERE id = $1`, [id]))[0]; }
  async where<T>(table: GlobalTable, condition: string, ...values: Param[]) { return this.rows<T>(`SELECT data FROM ${table} WHERE ${condition} ORDER BY seq`, values); }
  async exists(table: GlobalTable, condition: string, ...values: Param[]) { return (await this.raw(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`, values)).length > 0; }
  async delete(table: GlobalTable, condition: string, ...values: Param[]) { await this.raw(`DELETE FROM ${table} WHERE ${condition}`, values); }
  async put<T extends { id: string }>(table: GlobalTable, value: T & { familyId?: string; userId?: string | null }): Promise<T> {
    if (table === 'memberships') await this.raw('INSERT INTO memberships (id, family_id, user_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET data = excluded.data', [value.id, value.familyId, value.userId, json(value)]);
    else if (table === 'invitation_links') await this.raw('INSERT INTO invitation_links (id, family_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = excluded.data WHERE invitation_links.family_id = excluded.family_id', [value.id, value.familyId, json(value)]);
    else if (table === 'sessions') await this.raw('INSERT INTO sessions (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = excluded.data', [value.id, value.userId, json(value)]);
    else await this.raw(`INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data`, [value.id, json(value)]);
    return value;
  }
}

/** All family content goes through this: every statement is bound to one family (and RLS enforces it). */
export class FamilyStore extends Statements {
  readonly global: GlobalStore;
  constructor(connection: Connection, readonly familyId: string) { super(connection); this.global = new GlobalStore(connection); }
  /** `projection` is a trusted SQL expression over `data`, e.g. data - 'transcript'. */
  all<T>(table: FamilyTable, projection = 'data') { return this.rows<T>(`SELECT ${projection} AS data FROM ${table} WHERE family_id = $1 ORDER BY seq`, [this.familyId]); }
  async get<T>(table: FamilyTable, id: string) { return (await this.rows<T>(`SELECT data FROM ${table} WHERE family_id = $1 AND id = $2`, [this.familyId, id]))[0]; }
  /** `condition` is trusted SQL using $2, $3… for values ($1 is the family). */
  where<T>(table: FamilyTable, condition: string, ...values: Param[]) { return this.rows<T>(`SELECT data FROM ${table} WHERE family_id = $1 AND (${condition}) ORDER BY seq`, [this.familyId, ...values]); }
  async exists(table: FamilyTable, condition: string, ...values: Param[]) { return (await this.raw(`SELECT 1 FROM ${table} WHERE family_id = $1 AND (${condition}) LIMIT 1`, [this.familyId, ...values])).length > 0; }
  async count(table: FamilyTable) { return Number((await this.raw(`SELECT count(*) AS n FROM ${table} WHERE family_id = $1`, [this.familyId]))[0].n); }
  async put<T extends { id: string }>(table: FamilyTable, value: T): Promise<T> {
    const result = await this.raw(`INSERT INTO ${table} (id, family_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = excluded.data WHERE ${table}.family_id = excluded.family_id RETURNING id`, [value.id, this.familyId, json(value)]);
    if (!result.length) throw new Error('Запись принадлежит другой семье.');
    return value;
  }
  async history(entityType: string, entityId: string, actorId: string, action: string, before: unknown, after: unknown) {
    await this.put<HistoryEntry>('history', { id: randomUUID(), entityType, entityId, actorId, action, before: before == null ? null : json(before), after: after == null ? null : json(after), createdAt: new Date().toISOString() });
  }
}

export type DatabaseOptions = { url?: string; directory?: string; memory?: boolean };

export class Database {
  private constructor(private readonly driver: Driver, readonly kind: 'postgres' | 'pglite') {}
  /** DATABASE_URL selects PostgreSQL; without it an embedded PGlite database lives in DATA_DIR/pglite. */
  static async open(options: DatabaseOptions = {}): Promise<Database> {
    let driver: Driver; let kind: 'postgres' | 'pglite';
    if (options.url) { driver = pgDriver(options.url); kind = 'postgres'; }
    else {
      const directory = options.memory ? undefined : join(options.directory ?? 'data', 'pglite');
      if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
      driver = pgliteDriver(directory); kind = 'pglite';
    }
    const database = new Database(driver, kind);
    await database.migrate();
    return database;
  }
  private async migrate() {
    await this.driver.connect(async connection => {
      await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      // Serialise migrations across processes starting at the same time.
      await connection.query('SELECT pg_advisory_lock(727001)');
      try {
        const applied = new Set((await connection.query('SELECT version FROM schema_migrations')).rows.map(row => Number(row.version)));
        for (const [index, sql] of MIGRATIONS.entries()) {
          if (applied.has(index + 1)) continue;
          await connection.query('BEGIN');
          try { await exec(connection, sql); await connection.query('INSERT INTO schema_migrations (version) VALUES ($1)', [index + 1]); await connection.query('COMMIT'); }
          catch (error) { await connection.query('ROLLBACK'); throw error; }
        }
      } finally { await connection.query('SELECT pg_advisory_unlock(727001)'); }
    });
  }
  private transaction<T>(setup: (connection: Connection) => Promise<void>, fn: (connection: Connection) => Promise<T>): Promise<T> {
    return this.driver.connect(async connection => {
      await connection.query('BEGIN');
      try {
        await connection.query('SET LOCAL ROLE family_app');
        await setup(connection);
        const result = await fn(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) { await connection.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }
  /** One family's data in one transaction. Writes of a family are serialised, like the former single-file store. */
  family<T>(familyId: string, fn: (store: FamilyStore) => Promise<T>): Promise<T> {
    return this.transaction(async connection => {
      await connection.query("SELECT set_config('app.family_id', $1, true), pg_advisory_xact_lock(hashtextextended($1, 0))", [familyId]);
    }, connection => fn(new FamilyStore(connection, familyId)));
  }
  /** Accounts, sessions and membership lookups; no family content is visible here. */
  global<T>(fn: (store: GlobalStore) => Promise<T>): Promise<T> {
    return this.transaction(async () => {}, connection => fn(new GlobalStore(connection)));
  }
  /** Cross-family maintenance (workers, startup recovery). Every use must be deliberate and reviewed. */
  system<T>(fn: (store: GlobalStore) => Promise<T>): Promise<T> {
    return this.transaction(async connection => { await connection.query("SELECT set_config('app.system', 'on', true)"); }, connection => fn(new GlobalStore(connection)));
  }
  close() { return this.driver.close(); }
}

/** pg accepts one statement per parameterless query only when using the simple protocol; split defensively. */
async function exec(connection: Connection, sql: string) {
  const anyConnection = connection as Connection & { exec?: (sql: string) => Promise<unknown> };
  if (anyConnection.exec) { await anyConnection.exec(sql); return; }
  await connection.query(sql);
}
