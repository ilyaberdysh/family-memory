// Shared synthetic fixtures for backup, restore, verify and import tests. No real family content.
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Database } from '../server/db.js';

export const FAMILY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const FAMILY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const bytes = (label: string, size = 4096) => Buffer.alloc(size, `synthetic ${label} `);
export type Failure = Error & { code?: number; stdout?: string; stderr?: string };

const runFile = promisify(execFile);
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
export const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
/** Runs an operator script exactly as in the container; no .env, DATABASE_URL or credentials are inherited. */
export const cli = (cwd: string) => (name: string, args: string[]) => runFile(process.execPath, [tsx, script(name), ...args], { cwd, env: { TMPDIR: tmpdir() }, timeout: 60_000, maxBuffer: 4_000_000 });

export async function cliFailure(run: Promise<unknown>): Promise<Failure> {
  try { await run; } catch (error) { return error as Failure; }
  throw new Error('the command was expected to exit with a non-zero code');
}

export async function workspace(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `family-${prefix}-test-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** In-memory PGlite, or a PGlite directory in DATA_DIR/pglite when the CLI must open it later. */
export async function openDb(t: TestContext, directory?: string) {
  const db = await Database.open(directory ? { directory } : { memory: true });
  let closed = false;
  t.after(() => closed ? undefined : db.close());
  return { db, close: async () => { if (!closed) { closed = true; await db.close(); } } };
}

export async function seedFamily(db: Database, familyId: string, name: string, owner: { id: string; name: string; email?: string }) {
  await db.system(async store => {
    await store.put('families', { id: familyId, name, surnames: [], createdAt: '2026-09-01T00:00:00.000Z', createdBy: owner.id });
    if (!await store.get('users', owner.id)) await store.put('users', { id: owner.id, name: owner.name, email: owner.email ?? '', status: 'active' });
    await store.put('memberships', { id: `membership-${familyId.slice(0, 4)}-${owner.id}`, familyId, userId: owner.id, role: 'admin', status: 'active', personId: null, createdAt: '2026-09-01T00:00:00.000Z' });
  });
}

/** Writes bytes to DATA_DIR/files/<familyId>/<path> and a matching `files` row. */
export async function addFile(db: Database, dataDir: string, familyId: string, id: string, file: { path: string; bytes: Buffer }, options: { legacy?: boolean; preview?: { path: string; bytes: Buffer }; extra?: Record<string, unknown> } = {}) {
  await mkdir(join(dataDir, 'files', familyId), { recursive: true });
  await writeFile(join(dataDir, 'files', familyId, file.path), file.bytes);
  if (options.preview) await writeFile(join(dataDir, 'files', familyId, options.preview.path), options.preview.bytes);
  await db.family(familyId, store => store.put('files', {
    id, name: `Синтетический файл ${id}`, mime: 'application/octet-stream', size: file.bytes.length, url: `/api/files/${id}`, createdBy: 'admin', path: file.path,
    ...(options.legacy ? {} : { sha256: sha(file.bytes) }),
    ...(options.preview ? { previewStatus: 'ready', previewPath: options.preview.path, previewMime: 'video/mp4', previewSize: options.preview.bytes.length, previewSha256: sha(options.preview.bytes) } : {}),
    ...options.extra,
  }));
}

/** Every row of every table, ordered, for before/after comparisons. */
export async function dump(db: Database) {
  return db.system(async store => {
    const tables = ['families', 'users', 'memberships', 'sessions', 'auth_flows', 'codes', 'invitation_links', 'people', 'facts', 'relations', 'materials', 'history', 'conversations', 'files', 'jobs', 'invitations'];
    const result: Record<string, unknown[]> = {};
    for (const table of tables) result[table] = await store.rows(`SELECT data FROM ${table} ORDER BY seq`);
    return result;
  });
}
