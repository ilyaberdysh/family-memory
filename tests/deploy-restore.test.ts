import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../server/db.js';
import { createBackup } from '../scripts/backup.mts';
import { restoreBackup } from '../scripts/restore.mts';
import { FAMILY_A, FAMILY_B, addFile, cli, cliFailure, dump, openDb, seedFamily, sha, workspace } from './backup-fixtures.ts';

const localAdmin = { id: 'admin-preserved-id', name: 'Администратор', email: 'admin@local.invalid' };
// Synthetic media: one original with a recorded checksum and a browser preview, one legacy original without a checksum.
const media = {
  original: { path: '0123456789abcdef0123456789abcdef', bytes: Buffer.alloc(70_000, 'synthetic recording ') },
  preview: { path: '0123456789abcdef0123456789abcdef.preview.mp3', bytes: Buffer.alloc(20_000, 'synthetic preview ') },
  legacy: { path: 'fedcba9876543210fedcba9876543210', bytes: Buffer.alloc(5_000, 'synthetic scan ') },
};

async function seedArchive(db: Database, data: string, familyId: string, owner: typeof localAdmin) {
  await seedFamily(db, familyId, `Синтетическая семья ${familyId.slice(0, 1)}`, owner);
  const p = familyId.slice(0, 4);
  await db.system(store => store.put('invitation_links', { id: `${p}-guest-link`, familyId, tokenHash: sha(`${p} synthetic link`), role: 'member', revokedAt: null, uses: 0 }));
  await db.family(familyId, async store => {
    await store.put('people', { id: `${p}-person`, name: 'Проверяемое имя', avatarFileId: null, createdBy: owner.id, createdAt: '2026-09-01T00:00:00Z' });
    await store.put('facts', { id: `${p}-fact`, personId: `${p}-person`, key: 'name', value: 'Проверяемое имя', createdBy: owner.id, updatedBy: owner.id, version: 3, status: 'unconfirmed' });
    await store.put('materials', { id: `${p}-material`, kind: 'story', title: 'Проверяемая история', body: 'Синтетический текст.', createdBy: owner.id, personIds: [`${p}-person`], file: null, transcriptionStatus: 'processing', extractionStatus: 'done' });
    await store.put('jobs', { id: `${p}-job`, materialId: `${p}-material`, status: 'queued' });
    await store.put('conversations', { id: `${p}-chat`, status: 'responding', messages: [{ id: 'm1', role: 'user', text: 'Синтетический вопрос' }, { id: 'm2', role: 'assistant', text: 'Частичный' }] });
    await store.history('facts', `${p}-fact`, owner.id, 'create', null, { value: 'Проверяемое имя' });
  });
  await addFile(db, data, familyId, `${p}-recording`, media.original, { preview: media.preview });
  await addFile(db, data, familyId, `${p}-scan`, media.legacy, { legacy: true });
}

async function fixture(t: TestContext) {
  const root = await workspace(t, 'deploy-restore');
  const data = join(root, 'source');
  const { db } = await openDb(t);
  await seedArchive(db, data, FAMILY_A, localAdmin);
  await seedArchive(db, data, FAMILY_B, { id: 'second-owner', name: 'Второй владелец', email: 'second@example.test' });
  await db.system(store => store.put('sessions', { id: 'old-session', userId: localAdmin.id, expires: 9_999_999_999_999 }));
  const snapshot = join(root, 'snapshot');
  await createBackup({ db, dataDir: data, destination: snapshot, statusFile: false });
  return { root, data, db, snapshot, original: await dump(db) };
}

test('full restore into an empty database changes only the copied admin email, preserves identity/authorship and clears login authority', async t => {
  const f = await fixture(t);
  const { db: target } = await openDb(t);
  const to = join(f.root, 'restored');
  const result = await restoreBackup({ from: f.snapshot, db: target, dataDir: to, appStopped: true, adminEmail: ' Owner@Example.test ' });
  assert.deepEqual(result.families.sort(), [FAMILY_A, FAMILY_B]);
  const restored = await dump(target);
  assert.deepEqual(restored.users, (f.original.users as { id: string }[]).map(user => user.id === localAdmin.id ? { ...user, email: 'owner@example.test' } : user));
  for (const table of ['sessions', 'codes', 'auth_flows']) assert.deepEqual(restored[table], [], `${table} are not restored`);
  for (const link of restored.invitation_links as { revokedAt: string }[]) assert.ok(Number.isFinite(Date.parse(link.revokedAt)), 'old guest links are revoked');
  assert.deepEqual((restored.jobs as { status: string }[]).map(job => job.status), ['error', 'error']);
  assert.deepEqual((restored.materials as { transcriptionStatus: string; extractionStatus: string }[]).map(item => [item.transcriptionStatus, item.extractionStatus]), [['error', 'done'], ['error', 'done']]);
  const chat = (restored.conversations as { status: string; messages: { interrupted?: boolean }[] }[])[0];
  assert.equal(chat.status, 'error');
  assert.equal(chat.messages[1].interrupted, true);
  for (const table of ['families', 'memberships', 'people', 'facts', 'relations', 'history', 'files', 'invitations']) assert.deepEqual(restored[table], f.original[table], `${table} keeps IDs, authors and values`);
  assert.deepEqual(await dump(f.db), f.original, 'the source database stays untouched');
  for (const family of [FAMILY_A, FAMILY_B]) {
    assert.deepEqual((await readdir(join(to, 'files', family))).sort(), Object.values(media).map(file => file.path).sort());
    for (const file of Object.values(media)) assert.deepEqual(await readFile(join(to, 'files', family, file.path)), file.bytes);
    assert.equal((await lstat(join(to, 'files', family, media.original.path))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(join(to, 'files'))).filter(name => name.startsWith('.')), [], 'no staging left behind');
  // A second full restore into a database that already has families is refused.
  await assert.rejects(() => restoreBackup({ from: f.snapshot, db: target, dataDir: join(f.root, 'again'), appStopped: true }), /пустую базу/);
  await assert.rejects(() => restoreBackup({ from: f.snapshot, db: target, dataDir: join(f.root, 'again') }), /--app-stopped/);
});

test('one family moves into a database with other families: existing accounts are kept, nothing is overwritten', async t => {
  const f = await fixture(t);
  const { db: target } = await openDb(t);
  const to = join(f.root, 'server');
  // The target already has another family and the same owner account (as on a shared service).
  const existingFamily = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await seedFamily(target, existingFamily, 'Уже существующая семья', { id: 'second-owner', name: 'Изменённое имя', email: 'second@example.test' });
  const before = await dump(target);
  // A one-family export contains only that family and its members' accounts.
  const exported = join(f.root, 'export-b');
  await createBackup({ db: f.db, dataDir: f.data, destination: exported, family: FAMILY_B });
  const manifest = JSON.parse(await readFile(join(exported, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.family, Object.keys(manifest.families), manifest.counts.users], [FAMILY_B, [FAMILY_B], 1]);
  assert.ok(manifest.files.every((entry: { path: string }) => entry.path.startsWith(`${FAMILY_B}/`)));
  await assert.rejects(() => lstat(join(f.data, 'backup-status.json')), { code: 'ENOENT' }, 'an export does not count as the service backup');

  const result = await restoreBackup({ from: exported, db: target, dataDir: to, family: FAMILY_B });
  assert.deepEqual(result.users, { created: 0, existing: 1 });
  const after = await dump(target);
  assert.deepEqual(after.users, before.users, 'the existing account is not overwritten');
  assert.equal((after.families as unknown[]).length, 2);
  assert.equal((after.people as { id: string }[]).map(person => person.id).join(), 'bbbb-person');
  assert.deepEqual((await readdir(join(to, 'files', FAMILY_B))).sort(), Object.values(media).map(file => file.path).sort());
  // From a full backup too, but never over an existing family or existing files.
  await assert.rejects(() => restoreBackup({ from: f.snapshot, db: target, dataDir: to, family: FAMILY_B }), /уже есть в базе/);
  await mkdir(join(to, 'files', FAMILY_A));
  await assert.rejects(() => restoreBackup({ from: f.snapshot, db: target, dataDir: to, family: FAMILY_A, appStopped: true }), /уже существует/);
  assert.equal((await dump(target)).families.length, 2);
});

test('restore refuses an email belonging to another user before writing anything (CLI)', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target');
  const failure = await cliFailure(cli(f.root)('restore.mts', ['--from', f.snapshot, '--data-dir', target, '--app-stopped', '--admin-email', 'SECOND@example.test']));
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /email уже занят другим аккаунтом/);
  await assert.rejects(() => lstat(join(target, 'files')), { code: 'ENOENT' });
  const { db } = await openDb(t, target);
  assert.equal((await dump(db)).families.length, 0);
});
