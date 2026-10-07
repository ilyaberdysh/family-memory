import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importSqlite } from '../scripts/import-sqlite.mts';
import { verifyLive } from '../scripts/verify.mts';
import { cli, cliFailure, dump, openDb, sha, workspace } from './backup-fixtures.ts';

// A synthetic legacy single-family DATA_DIR in the former Store shape: `(id TEXT PRIMARY KEY, data TEXT)` per table.
const TABLES = ['users', 'invitations', 'invitation_links', 'people', 'facts', 'relations', 'files', 'materials', 'history', 'sessions', 'codes', 'auth_flows', 'jobs', 'conversations'];
const photo = { path: '11112222333344445555666677778888', bytes: Buffer.alloc(8000, 'synthetic legacy photo ') };
const scan = { path: '99990000aaaabbbbccccddddeeeeffff', bytes: Buffer.alloc(3000, 'synthetic legacy scan ') };
const video = { path: 'aaaa0000bbbb1111cccc2222dddd3333', bytes: Buffer.alloc(6000, 'synthetic legacy video ') };

async function legacy(t: TestContext) {
  const root = await workspace(t, 'import-sqlite');
  const from = join(root, 'legacy');
  await mkdir(join(from, 'files'), { recursive: true });
  const db = new DatabaseSync(join(from, 'family.sqlite'));
  const put = (table: string, value: { id: string }) => db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`).run(value.id, JSON.stringify(value));
  try {
    for (const table of TABLES) db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    put('users', { id: 'legacy-admin', name: 'Синтетический админ', email: '', role: 'admin', status: 'active', authProvider: 'telegram', telegramId: '1000001', telegramSubject: 'sub-1', personId: 'person-1' } as never);
    put('users', { id: 'legacy-member', name: 'Синтетический участник', email: '', role: 'member', status: 'active', authProvider: 'guest' } as never);
    put('users', { id: 'legacy-new', name: '', email: '', role: 'viewer', status: 'profile', authProvider: 'telegram', telegramId: '1000003', telegramSubject: 'sub-3' } as never);
    put('people', { id: 'person-1', name: 'Синтетический человек', avatarFileId: 'file-photo', createdBy: 'legacy-admin', createdAt: '2025-01-01T00:00:00Z' } as never);
    put('facts', { id: 'fact-1', personId: 'person-1', key: 'name', value: 'Синтетический человек', status: 'confirmed' } as never);
    put('relations', { id: 'relation-1', fromId: 'person-1', toId: 'person-1', type: 'partner' } as never);
    put('history', { id: 'history-1', entityType: 'facts', entityId: 'fact-1', actorId: 'legacy-admin', action: 'create', before: null, after: '{}', createdAt: '2025-01-01T00:00:00Z' } as never);
    put('invitations', { id: 'invitation-1', email: 'guest@example.test', role: 'member', createdAt: '2025-01-01T00:00:00Z', accepted: false } as never);
    put('invitation_links', { id: 'link-1', tokenHash: sha('synthetic link token'), role: 'member', revokedAt: null, uses: 0 } as never);
    put('files', { id: 'file-photo', name: 'photo.jpg', size: photo.bytes.length, path: photo.path, sha256: sha(photo.bytes) } as never);
    put('files', { id: 'file-scan', name: 'scan.jpg', size: scan.bytes.length, path: scan.path } as never);
    put('files', { id: 'file-video', name: 'video.mov', size: video.bytes.length, path: video.path, sha256: sha(video.bytes), previewStatus: 'processing' } as never);
    put('materials', { id: 'material-1', title: 'Синтетическая запись', kind: 'audio', transcriptionStatus: 'processing', extractionStatus: 'idle' } as never);
    put('jobs', { id: 'job-1', materialId: 'material-1', status: 'processing' } as never);
    put('conversations', { id: 'chat-1', status: 'idle', messages: [] } as never);
    put('sessions', { id: 'session-live', userId: 'legacy-admin', expires: Date.now() + 86_400_000 } as never);
    put('sessions', { id: 'session-old', userId: 'legacy-member', expires: 1 } as never);
    put('codes', { id: 'code-1', hash: 'synthetic' } as never);
    put('auth_flows', { id: 'flow-1', state: 'synthetic' } as never);
  } finally { db.close(); }
  for (const file of [photo, scan, video]) await writeFile(join(from, 'files', file.path), file.bytes);
  await writeFile(join(from, 'files', 'stray-unreferenced-file'), 'synthetic stray');
  const fingerprint = async () => sha(await readFile(join(from, 'family.sqlite')));
  return { root, from, fingerprint };
}

test('a legacy DATA_DIR becomes one new family; accounts, sessions and guest links keep working; the source is untouched', async t => {
  const f = await legacy(t);
  const before = await f.fingerprint();
  const { db } = await openDb(t);
  const to = join(f.root, 'data');
  const result = await importSqlite({ from: f.from, db, filesTo: to, familyName: 'Синтетическая семья', surnames: [' Иванов ', '', 'Петров'] });
  assert.equal(result.files, 3);
  assert.deepEqual(result.users, { created: 3, existing: 0 });
  assert.deepEqual(result.skipped, { codes: 1, auth_flows: 1, expiredSessions: 1, unreferencedFiles: 1 });
  const rows = await dump(db);
  assert.deepEqual(rows.families, [{ id: result.familyId, name: 'Синтетическая семья', surnames: ['Иванов', 'Петров'], createdAt: (rows.families[0] as { createdAt: string }).createdAt, createdBy: 'legacy-admin' }]);
  assert.deepEqual((rows.users as { id: string; status: string }[]).map(user => [user.id, user.status]), [['legacy-admin', 'active'], ['legacy-member', 'active'], ['legacy-new', 'profile']]);
  assert.equal((rows.users[0] as { telegramSubject: string }).telegramSubject, 'sub-1');
  assert.equal((rows.users[0] as { role?: string }).role, undefined, 'roles live in memberships');
  assert.deepEqual((rows.memberships as { userId: string; role: string; status: string; personId: string | null; familyId: string }[]).map(m => [m.userId, m.role, m.status, m.personId, m.familyId]),
    [['legacy-admin', 'admin', 'active', 'person-1', result.familyId], ['legacy-member', 'member', 'active', null, result.familyId], ['legacy-new', 'viewer', 'profile', null, result.familyId]]);
  assert.deepEqual((rows.sessions as { id: string }[]).map(session => session.id), ['session-live']);
  assert.deepEqual([rows.codes, rows.auth_flows], [[], []]);
  assert.deepEqual(rows.invitation_links, [{ id: 'link-1', tokenHash: sha('synthetic link token'), role: 'member', revokedAt: null, uses: 0, familyId: result.familyId }]);
  for (const table of ['people', 'facts', 'relations', 'history', 'invitations', 'conversations']) assert.equal(rows[table].length, 1, table);
  const files = rows.files as { id: string; sha256: string; previewStatus?: string }[];
  assert.equal(files.find(file => file.id === 'file-scan')?.sha256, sha(scan.bytes), 'legacy rows receive the checksum of the moved bytes');
  assert.equal(files.find(file => file.id === 'file-video')?.previewStatus, 'pending');
  assert.equal((rows.jobs[0] as { status: string }).status, 'error');
  assert.equal((rows.materials[0] as { transcriptionStatus: string }).transcriptionStatus, 'error');
  for (const file of [photo, scan, video]) assert.deepEqual(await readFile(join(to, 'files', result.familyId, file.path)), file.bytes);
  assert.equal((await verifyLive({ db, dataDir: to })).ok, true);
  assert.equal(await f.fingerprint(), before, 'family.sqlite is never modified');
  assert.deepEqual((await readdir(join(f.from, 'files'))).sort(), [photo.path, scan.path, video.path, 'stray-unreferenced-file'].sort());

  // Importing the same family again is refused and changes nothing.
  await assert.rejects(() => importSqlite({ from: f.from, db, filesTo: to, familyName: 'Повтор' }), /уже перенесена/);
  assert.deepEqual(await dump(db), rows);
  assert.deepEqual((await readdir(join(to, 'files'))), [result.familyId]);
});

test('missing legacy files block the import unless explicitly accepted; the CLI writes nothing on refusal', async t => {
  const f = await legacy(t);
  await unlink(join(f.from, 'files', scan.path));
  const to = join(f.root, 'data');
  const run = cli(f.root);
  const refused = await cliFailure(run('import-sqlite.mts', ['--from', f.from, '--data-dir', to, '--family-name', 'Синтетическая семья', '--app-stopped']));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr ?? '', /--allow-problems/);
  await assert.rejects(() => lstat(join(to, 'files')), { code: 'ENOENT' });
  const accepted = await cliFailure(run('import-sqlite.mts', ['--from', f.from, '--data-dir', to, '--family-name', 'Синтетическая семья', '--app-stopped', '--allow-problems']));
  assert.equal(accepted.code, 2, 'imported with problems');
  assert.match(accepted.stdout ?? '', /Семья перенесена/);
  assert.match(accepted.stderr ?? '', new RegExp(scan.path));
  const { db } = await openDb(t, to);
  const rows = await dump(db);
  assert.equal(rows.files.length, 3, 'the row of the lost file stays so it can be repaired');
  const family = (rows.families[0] as { id: string }).id;
  assert.deepEqual((await readdir(join(to, 'files', family))).sort(), [photo.path, video.path].sort());
});
