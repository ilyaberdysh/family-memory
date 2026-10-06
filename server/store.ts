import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryEntry } from '../shared/types.js';

export const TABLES = ['users', 'invitations', 'invitation_links', 'people', 'facts', 'relations', 'files', 'materials', 'history', 'sessions', 'codes', 'auth_flows', 'jobs', 'conversations'] as const;
export type Table = typeof TABLES[number];
export class Store {
  readonly db: DatabaseSync;
  readonly filesDir: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filesDir = join(directory, 'files');
    mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'family.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    for (const table of TABLES) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`);
    this.db.exec("DROP INDEX IF EXISTS unique_email; CREATE UNIQUE INDEX IF NOT EXISTS unique_email ON users(json_extract(data, '$.email')) WHERE json_extract(data, '$.email') != ''; CREATE UNIQUE INDEX IF NOT EXISTS unique_telegram_subject ON users(json_extract(data, '$.telegramSubject')) WHERE json_extract(data, '$.telegramSubject') != ''; CREATE UNIQUE INDEX IF NOT EXISTS unique_telegram_id ON users(json_extract(data, '$.telegramId')) WHERE json_extract(data, '$.telegramId') != ''; CREATE UNIQUE INDEX IF NOT EXISTS unique_fact ON facts(json_extract(data, '$.personId'), json_extract(data, '$.key'));");
    // Lookup indexes keep hot paths (media range requests, history, workers) independent of archive size.
    this.db.exec("CREATE INDEX IF NOT EXISTS history_entity ON history(json_extract(data, '$.entityType'), json_extract(data, '$.entityId')); CREATE INDEX IF NOT EXISTS material_file ON materials(json_extract(data, '$.file.id')); CREATE INDEX IF NOT EXISTS person_avatar ON people(json_extract(data, '$.avatarFileId')); CREATE INDEX IF NOT EXISTS job_status ON jobs(json_extract(data, '$.status')); CREATE INDEX IF NOT EXISTS file_preview_status ON files(json_extract(data, '$.previewStatus')); CREATE INDEX IF NOT EXISTS session_user ON sessions(json_extract(data, '$.userId'));");
  }
  /** `projection` is a trusted SQL expression over `data`, e.g. json_remove(data, '$.transcript'). */
  all<T>(table: Table, projection = 'data'): T[] { return this.db.prepare(`SELECT ${projection} AS data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.data as string) as T); }
  /** `condition` is trusted SQL; values are always bound parameters. */
  where<T>(table: Table, condition: string, ...values: (string | number | null)[]): T[] {
    return this.db.prepare(`SELECT data FROM ${table} WHERE ${condition} ORDER BY rowid`).all(...values).map(row => JSON.parse(row.data as string) as T);
  }
  exists(table: Table, condition: string, ...values: (string | number | null)[]): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get(...values);
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data as string) as T : undefined;
  }
  put<T extends { id: string }>(table: Table, value: T): T {
    this.db.prepare(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, JSON.stringify(value));
    return value;
  }
  delete(table: Table, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(entityType: string, entityId: string, actorId: string, action: string, before: unknown, after: unknown) {
    this.put<HistoryEntry>('history', { id: randomUUID(), entityType, entityId, actorId, action, before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after), createdAt: new Date().toISOString() });
  }
  close() { this.db.close(); }
}
