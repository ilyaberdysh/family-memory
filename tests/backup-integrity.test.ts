import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { lstat, mkdir, readFile, readdir, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackup, readManifest, type BackupManifest } from '../scripts/backup.mts';
import { restoreBackup } from '../scripts/restore.mts';
import { verifyBackup, verifyLive } from '../scripts/verify.mts';
import { FAMILY_A, FAMILY_B, addFile, bytes, cli, cliFailure, dump, openDb, seedFamily, sha, workspace } from './backup-fixtures.ts';

// Synthetic two-family archive: plain bytes with matching `files` rows, no real family content.
const originals = {
  photo: { path: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('photo') },
  voice: { path: 'b1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('voice', 9000) },
  video: { path: 'c1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('video', 12000) },
  legacy: { path: 'd1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('legacy scan', 3000) },
};
const preview = { path: `${originals.video.path}.preview.mp4`, bytes: bytes('video preview', 5000) };
const other = { path: 'e1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('other family photo', 2500) };

async function archive(t: TestContext, persistent = false) {
  const root = await workspace(t, 'backup-integrity');
  const data = join(root, 'data');
  await mkdir(join(data, 'files'), { recursive: true });
  const handle = await openDb(t, persistent ? data : undefined);
  const { db } = handle;
  await seedFamily(db, FAMILY_A, 'Синтетическая семья А', { id: 'admin', name: 'Администратор' });
  await seedFamily(db, FAMILY_B, 'Синтетическая семья Б', { id: 'other-admin', name: 'Другой администратор' });
  for (const [id, file] of Object.entries(originals)) await addFile(db, data, FAMILY_A, id, file, { legacy: id === 'legacy', ...(id === 'video' ? { preview } : {}) });
  await addFile(db, data, FAMILY_B, 'other', other);
  const files = (name: string, family = FAMILY_A) => join(data, 'files', family, name);
  return { root, data, db, close: handle.close, files, cli: cli(root) };
}
const manifestOf = async (directory: string) => JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
const stored = (name: string, family = FAMILY_A) => `${family}/${name}`;

test('a missing, truncated or altered file degrades the backup instead of aborting it (CLI on PGlite)', async t => {
  const f = await archive(t, true);
  await unlink(f.files(originals.photo.path));
  await truncate(f.files(originals.voice.path), 100);
  const altered = Buffer.from(originals.video.bytes); altered[10] ^= 0xff;
  await writeFile(f.files(originals.video.path), altered);
  await unlink(f.files(preview.path));
  await f.close();
  const snapshot = join(f.root, 'snapshot');

  const pgliteGuard = await cliFailure(f.cli('backup.mts', ['--data-dir', f.data, '--out', snapshot]));
  assert.equal(pgliteGuard.code, 1);
  assert.match(pgliteGuard.stderr ?? '', /--app-stopped/);
  const failure = await cliFailure(f.cli('backup.mts', ['--data-dir', f.data, '--out', snapshot, '--app-stopped']));
  assert.equal(failure.code, 2);
  for (const path of [originals.photo.path, originals.voice.path, originals.video.path, preview.path]) assert.match(failure.stderr ?? '', new RegExp(`files/${FAMILY_A}/${path.replaceAll('.', '\\.')}`));

  const manifest = await manifestOf(snapshot);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.engine, 'pglite');
  assert.deepEqual(Object.keys(manifest.families ?? {}).sort(), [FAMILY_A, FAMILY_B]);
  assert.equal(manifest.families?.[FAMILY_A].rows.files, 4);
  assert.equal(manifest.counts?.users, 2);
  assert.equal(manifest.counts?.sessions, undefined, 'login state is never copied');
  const byPath = new Map(manifest.problems.map(problem => [problem.path, problem]));
  assert.equal(byPath.get(stored(originals.photo.path))?.kind, 'missing');
  assert.equal(byPath.get(stored(originals.voice.path))?.kind, 'size');
  assert.equal(byPath.get(stored(originals.voice.path))?.actualSize, 100);
  assert.equal(byPath.get(stored(originals.video.path))?.kind, 'checksum');
  assert.equal(byPath.get(stored(originals.video.path))?.actualSha256, sha(altered));
  assert.deepEqual([byPath.get(stored(preview.path))?.kind, byPath.get(stored(preview.path))?.preview], ['missing', true]);
  // Everything that could be copied is kept, including the damaged bytes.
  assert.deepEqual(manifest.files.map(entry => entry.path).sort(), [stored(originals.voice.path), stored(originals.video.path), stored(originals.legacy.path), stored(other.path, FAMILY_B)].sort());
  assert.equal((await stat(join(snapshot, 'files', FAMILY_A, originals.voice.path))).size, 100);
  assert.deepEqual(await readFile(join(snapshot, 'files', FAMILY_A, originals.video.path)), altered);
  await assert.rejects(() => lstat(join(snapshot, '.backup-in-progress')), { code: 'ENOENT' });

  const status = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(status.lastResult, 'degraded');
  assert.equal(status.problemFiles, 4);
  assert.equal(status.files, 4);

  // Restore refuses a degraded copy unless the operator explicitly accepts the gaps.
  const restored = join(f.root, 'restored');
  const refused = await cliFailure(f.cli('restore.mts', ['--from', snapshot, '--data-dir', restored, '--app-stopped']));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr ?? '', /--allow-problems/);
  await assert.rejects(() => lstat(join(restored, 'files')), { code: 'ENOENT' });
  const accepted = await f.cli('restore.mts', ['--from', snapshot, '--data-dir', restored, '--app-stopped', '--allow-problems']);
  assert.match(accepted.stderr, new RegExp(originals.photo.path));
  assert.deepEqual((await readdir(join(restored, 'files', FAMILY_A))).sort(), [originals.voice.path, originals.video.path, originals.legacy.path].sort());
  assert.deepEqual(await readFile(join(restored, 'files', FAMILY_B, other.path)), other.bytes);
  const { db } = await openDb(t, restored);
  const rows = await dump(db);
  assert.equal(rows.files.length, 5, 'rows of lost files stay so they can be repaired');
  assert.equal(rows.families.length, 2);
});

test('backup-status.json keeps the last success after a failure and an unreadable status file never breaks a backup', async t => {
  const f = await archive(t);
  await createBackup({ db: f.db, dataDir: f.data, destination: join(f.root, 'first') });
  const first = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(first.lastResult, 'ok');
  await assert.rejects(() => createBackup({ db: f.db, dataDir: f.data, destination: join(f.root, 'first') }), /уже существует/);
  const failed = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(failed.lastResult, 'failed');
  assert.equal(failed.lastSuccessAt, first.lastSuccessAt);
  assert.equal(failed.lastDestination, first.lastDestination);
  await writeFile(join(f.data, 'backup-status.json'), '{ not json');
  const result = await createBackup({ db: f.db, dataDir: f.data, destination: join(f.root, 'second') });
  assert.equal(result.problems.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8')).lastResult, 'ok');
  assert.deepEqual((await readdir(f.data)).filter(name => name.endsWith('.tmp')), []);
  await assert.rejects(() => createBackup({ db: f.db, dataDir: f.data, destination: join(f.data, 'inside') }), /вне активного DATA_DIR/);
});

test('--link-dest hard-links unchanged files, copies new ones and carries forward files lost from DATA_DIR', async t => {
  const f = await archive(t);
  const first = join(f.root, 'first'), second = join(f.root, 'second');
  assert.equal((await createBackup({ db: f.db, dataDir: f.data, destination: first, statusFile: false })).bytesLinked, 0);
  const added = { path: 'f1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('new upload', 2000) };
  await addFile(f.db, f.data, FAMILY_A, 'added', added);
  await createBackup({ db: f.db, dataDir: f.data, destination: second, linkDest: first, statusFile: false });
  for (const path of [...Object.values(originals).map(file => file.path), preview.path]) {
    assert.equal((await stat(join(second, 'files', FAMILY_A, path))).ino, (await stat(join(first, 'files', FAMILY_A, path))).ino, `${path} is hard-linked`);
  }
  assert.equal((await stat(join(second, 'files', FAMILY_A, added.path))).nlink, 1, 'the new file is copied');
  const manifest = await manifestOf(second);
  assert.equal(manifest.files.length, 7);
  assert.equal(manifest.files.find(entry => entry.path === stored(originals.legacy.path))?.sha256, sha(originals.legacy.bytes));
  assert.equal((await verifyBackup(second)).ok, true);

  await unlink(f.files(originals.photo.path));
  await truncate(f.files(originals.legacy.path), 10);
  const third = join(f.root, 'third');
  const carried = await createBackup({ db: f.db, dataDir: f.data, destination: third, linkDest: second, statusFile: false });
  assert.deepEqual(carried.problems.map(problem => [problem.path, problem.kind, problem.recovered]).sort(), [[stored(originals.photo.path), 'missing', true], [stored(originals.legacy.path), 'size', true]].sort());
  assert.deepEqual(await readFile(join(third, 'files', FAMILY_A, originals.photo.path)), originals.photo.bytes);
  assert.deepEqual(await readFile(join(third, 'files', FAMILY_A, originals.legacy.path)), originals.legacy.bytes);
  const { db: target } = await openDb(t);
  const outcome = await restoreBackup({ from: third, db: target, dataDir: join(f.root, 'restored'), appStopped: true });
  assert.equal(outcome.problems.length, 0, 'recovered files do not block restore');
  assert.deepEqual(await readFile(join(f.root, 'restored', 'files', FAMILY_A, originals.photo.path)), originals.photo.bytes);
});

test('an older flat (v2) snapshot still serves as --link-dest by content and is refused by restore', async t => {
  const f = await archive(t);
  const old = join(f.root, 'old');
  await mkdir(join(old, 'files'), { recursive: true });
  await writeFile(join(old, 'family.sqlite'), 'synthetic legacy database');
  await writeFile(join(old, 'files', originals.photo.path), originals.photo.bytes);
  await writeFile(join(old, 'manifest.json'), JSON.stringify({ format: 'family-space-backup', version: 2, createdAt: '2026-09-01T00:00:00.000Z',
    database: { path: 'family.sqlite', size: 25, sha256: sha('synthetic legacy database') }, files: [{ path: originals.photo.path, size: originals.photo.bytes.length, sha256: sha(originals.photo.bytes) }], problems: [] }));
  const next = join(f.root, 'next');
  const result = await createBackup({ db: f.db, dataDir: f.data, destination: next, linkDest: old, statusFile: false });
  assert.equal(result.bytesLinked, originals.photo.bytes.length);
  assert.equal((await stat(join(next, 'files', FAMILY_A, originals.photo.path))).ino, (await stat(join(old, 'files', originals.photo.path))).ino);
  const legacy = await verifyBackup(old);
  assert.equal(legacy.version, 2);
  assert.match(legacy.databaseError ?? '', /import-sqlite/);
  const { db: target } = await openDb(t);
  await assert.rejects(() => restoreBackup({ from: old, db: target, dataDir: join(f.root, 'restored'), appStopped: true }), /import-sqlite/);
});

test('an aborted backup leaves no partial directory', async t => {
  const f = await archive(t);
  const destination = join(f.root, 'aborted');
  let checks = 0;
  // Aborts deterministically after the database and a couple of files have been written.
  const fake = { aborted: false, throwIfAborted() { if (++checks > 4) { fake.aborted = true; throw new DOMException('Aborted', 'AbortError'); } } };
  await assert.rejects(() => createBackup({ db: f.db, dataDir: f.data, destination, signal: fake as unknown as AbortSignal }), { name: 'AbortError' });
  await assert.rejects(() => lstat(destination), { code: 'ENOENT' });
  const status = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(status.lastResult, 'failed');
  assert.match(status.lastError, /прервано/);
});

test('verify passes on clean data and a clean backup, and detects missing, resized, altered and orphan files', async t => {
  const f = await archive(t);
  await mkdir(join(f.data, 'files', '.incoming'));
  await writeFile(join(f.data, 'files', '.incoming', 'partial-upload'), 'synthetic partial');
  await mkdir(join(f.data, 'files', FAMILY_A, '.heic-preview-abc'));
  const clean = await verifyLive({ db: f.db, dataDir: f.data });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.orphans, []);
  assert.equal(clean.legacyWithoutHash, 1);
  assert.equal(clean.families.length, 2);
  const snapshot = join(f.root, 'snapshot');
  await createBackup({ db: f.db, dataDir: f.data, destination: snapshot, statusFile: false });
  assert.match((await f.cli('verify.mts', ['--backup', snapshot])).stdout, /копия цела/);

  await unlink(f.files(originals.photo.path));
  await truncate(f.files(originals.voice.path), 10);
  const altered = Buffer.from(preview.bytes); altered[0] ^= 1;
  await writeFile(f.files(preview.path), altered);
  await writeFile(f.files('0f1b2c3d4e5f60718293a4b5c6d7e8f9', FAMILY_B), 'synthetic stray bytes');
  await writeFile(join(f.data, 'files', 'flat-legacy-file'), 'synthetic flat file');
  const result = await verifyLive({ db: f.db, dataDir: f.data });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(problem => [problem.path, problem.kind]).sort(), [[stored(originals.photo.path), 'missing'], [stored(originals.voice.path), 'size'], [stored(preview.path), 'checksum']].sort());
  assert.deepEqual(result.orphans.map(item => item.path).sort(), ['flat-legacy-file', stored('0f1b2c3d4e5f60718293a4b5c6d7e8f9', FAMILY_B)].sort());
  const onlyB = await verifyLive({ db: f.db, dataDir: f.data, family: FAMILY_B });
  assert.equal(onlyB.ok, true, 'one family is checked on its own');
  assert.deepEqual(onlyB.orphans.map(item => item.path), [stored('0f1b2c3d4e5f60718293a4b5c6d7e8f9', FAMILY_B)]);
  const quick = await verifyLive({ db: f.db, dataDir: f.data, quick: true });
  assert.deepEqual(quick.problems.map(problem => problem.kind).sort(), ['missing', 'size'], '--quick skips hashing');

  // Bit rot inside the backup itself is found without restoring, and nothing is modified.
  const rotten = await readFile(join(snapshot, 'files', FAMILY_A, originals.legacy.path)); rotten[5] ^= 1;
  await unlink(join(snapshot, 'files', FAMILY_A, originals.legacy.path));
  await writeFile(join(snapshot, 'files', FAMILY_A, originals.legacy.path), rotten);
  const before = await readFile(join(snapshot, 'manifest.json'), 'utf8');
  const broken = await verifyBackup(snapshot);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems.map(problem => [problem.path, problem.kind]), [[stored(originals.legacy.path), 'checksum']]);
  assert.equal(await readFile(join(snapshot, 'manifest.json'), 'utf8'), before);
  const failure = await cliFailure(f.cli('verify.mts', ['--backup', snapshot]));
  assert.equal(failure.code, 2);
  assert.equal((await cliFailure(f.cli('verify.mts', ['--backup', join(f.root, 'missing-copy')]))).code, 1);
  await assert.rejects(() => readManifest(join(f.root, 'missing-copy')));
});
