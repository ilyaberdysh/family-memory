import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store, TABLES, type Table } from '../server/store.js';

const runFile = promisify(execFile);
const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
const restoreScript = fileURLToPath(new URL('../scripts/restore.mjs', import.meta.url));
const localAdmin = { id: 'admin-preserved-id', name: 'Администратор', email: 'admin@local.invalid', role: 'admin' };
const readState = (directory: string) => {
  const db = new DatabaseSync(join(directory, 'family.sqlite'), { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.data as string))])) as Record<Table, unknown[]>;
  } finally { db.close(); }
};

async function fixture(t: TestContext, occupiedEmail?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'family-deploy-restore-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const snapshot = join(directory, 'snapshot');
  const target = join(directory, 'restored');
  const store = new Store(source);
  try {
    store.put('users', localAdmin);
    if (occupiedEmail) store.put('users', { id: 'other-user', name: 'Другой участник', email: occupiedEmail, role: 'member' });
    store.put('people', { id: 'person', name: 'Проверяемое имя', avatarFileId: null, createdBy: localAdmin.id, createdAt: '2026-09-01T00:00:00Z' });
    store.put('facts', { id: 'fact', personId: 'person', key: 'name', value: 'Проверяемое имя', createdBy: localAdmin.id, updatedBy: localAdmin.id, version: 3, status: 'unconfirmed' });
    store.put('materials', { id: 'material', kind: 'story', title: 'Проверяемая история', body: 'Синтетический текст для проверки восстановления.', createdBy: localAdmin.id, personIds: ['person'], file: null, transcriptionStatus: 'idle', extractionStatus: 'done' });
    store.history('facts', 'fact', localAdmin.id, 'create', null, { value: 'Проверяемое имя' });
    store.put('sessions', { id: 'old-session', userId: localAdmin.id, expires: 9_999_999_999_999 });
    store.put('codes', { id: localAdmin.email, name: localAdmin.name, hash: 'synthetic-code-hash', role: 'admin', expires: 9_999_999_999_999, attempts: 0, sentAt: 0 });
    store.put('auth_flows', { id: 'old-flow-hash', state: 'old-state', verifier: 'old-verifier', expires: 9_999_999_999_999 });
    store.put('invitation_links', { id: 'old-guest-link', tokenHash: 'synthetic-link-hash', role: 'member', revokedAt: null, uses: 0 });
  } finally { store.close(); }
  // No .env loader, inherited NODE_OPTIONS, live DATA_DIR, or provider credentials reach either CLI.
  const cli = (script: string, args: string[]) => runFile(process.execPath, [script, ...args], {
    cwd: directory, env: {}, timeout: 15_000, maxBuffer: 128_000,
  });
  const original = readState(source);
  await cli(backupScript, ['--data-dir', source, '--out', snapshot]);
  return { source, snapshot, target, original, cli };
}

test('deployment restore changes only the copied admin email, preserves identity/authorship and clears login authority', async t => {
  const f = await fixture(t);
  await f.cli(restoreScript, ['--from', f.snapshot, '--to', f.target, '--app-stopped', '--admin-email', ' Owner@Example.test ']);
  const restored = readState(f.target);
  assert.deepEqual(restored.users, [{ ...localAdmin, email: 'owner@example.test' }]);
  assert.deepEqual(restored.sessions, []);
  assert.deepEqual(restored.codes, []);
  assert.deepEqual(restored.auth_flows, []);
  const restoredLink = restored.invitation_links[0] as { revokedAt: string };
  assert.ok(Number.isFinite(Date.parse(restoredLink.revokedAt)), 'old guest links are revoked');
  assert.deepEqual(restored.invitation_links, [{ ...(f.original.invitation_links[0] as object), revokedAt: restoredLink.revokedAt }]);
  for (const table of TABLES.filter(table => !['users', 'sessions', 'codes', 'auth_flows', 'invitation_links'].includes(table))) {
    assert.deepEqual(restored[table], f.original[table], `${table} must preserve its existing IDs, author references and values`);
  }
  assert.deepEqual(readState(f.source), f.original, 'the original database, including its email and login records, stays untouched');
  assert.deepEqual(readState(f.snapshot), f.original, 'the portable snapshot retains its original email and records');
});

test('deployment restore refuses an email belonging to another user before creating the destination', async t => {
  const f = await fixture(t, 'occupied@example.test');
  await assert.rejects(() => f.cli(restoreScript, ['--from', f.snapshot, '--to', f.target, '--app-stopped', '--admin-email', 'OCCUPIED@example.test']), error => {
    const failure = error as Error & { code?: number; stderr?: string };
    return failure.code === 1 && /email уже занят другим аккаунтом/.test(failure.stderr ?? '');
  });
  await assert.rejects(() => lstat(f.target), { code: 'ENOENT' });
  assert.deepEqual(readState(f.source), f.original);
  assert.deepEqual(readState(f.snapshot), f.original);
});
