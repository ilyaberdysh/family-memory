import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store } from '../server/store.js';
import { createBackup, readManifest, type BackupManifest } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore.mjs';
import { verifyBackup, verifyDataDir } from '../scripts/verify.mjs';

// Synthetic archive only: plain bytes with matching `files` rows, no real family content.
const runFile = promisify(execFile);
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = (label: string, size = 4096) => Buffer.alloc(size, `synthetic ${label} `);
type Failure = Error & { code?: number; stdout?: string; stderr?: string };

const originals = {
  photo: { path: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('photo') },
  voice: { path: 'b1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('voice', 9000) },
  video: { path: 'c1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('video', 12000) },
  legacy: { path: 'd1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('legacy scan', 3000) },
};
const preview = { path: `${originals.video.path}.preview.mp4`, bytes: bytes('video preview', 5000) };

async function archive(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'family-backup-integrity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const store = new Store(data);
  try {
    store.put('users', { id: 'admin', name: 'Администратор', email: 'admin@local.invalid', role: 'admin' });
    for (const [id, file] of Object.entries(originals)) {
      await writeFile(join(data, 'files', file.path), file.bytes);
      store.put('files', {
        id, name: `Синтетический файл ${id}`, mime: 'application/octet-stream', size: file.bytes.length, url: `/api/files/${id}`, createdBy: 'admin', path: file.path,
        ...(id === 'legacy' ? {} : { sha256: sha(file.bytes) }),
        ...(id === 'video' ? { previewStatus: 'ready', previewPath: preview.path, previewMime: 'video/mp4', previewSize: preview.bytes.length, previewSha256: sha(preview.bytes) } : {}),
      });
    }
    await writeFile(join(data, 'files', preview.path), preview.bytes);
  } finally { store.close(); }
  const cli = (name: string, args: string[]) => runFile(process.execPath, [script(name), ...args], { cwd: root, env: {}, timeout: 30_000, maxBuffer: 1_000_000 });
  return { root, data, files: join(data, 'files'), cli };
}

async function cliFailure(run: Promise<unknown>) {
  try { await run; } catch (error) { return error as Failure; }
  assert.fail('the command was expected to exit with a non-zero code');
}

const manifestOf = async (directory: string) => JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;

test('a missing, truncated or altered file degrades the backup instead of aborting it', async t => {
  const f = await archive(t);
  await unlink(join(f.files, originals.photo.path));
  await truncate(join(f.files, originals.voice.path), 100);
  const altered = Buffer.from(originals.video.bytes); altered[10] ^= 0xff;
  await writeFile(join(f.files, originals.video.path), altered);
  await unlink(join(f.files, preview.path));
  const snapshot = join(f.root, 'snapshot');

  const failure = await cliFailure(f.cli('backup.mjs', ['--data-dir', f.data, '--out', snapshot]));
  assert.equal(failure.code, 2);
  for (const path of [originals.photo.path, originals.voice.path, originals.video.path, preview.path]) assert.match(failure.stderr ?? '', new RegExp(`files/${path.replaceAll('.', '\\.')}`));

  const manifest = await manifestOf(snapshot);
  assert.equal(manifest.version, 2);
  const byPath = new Map(manifest.problems.map(problem => [problem.path, problem]));
  assert.equal(byPath.get(originals.photo.path)?.kind, 'missing');
  assert.deepEqual({ ...byPath.get(originals.voice.path) }, { path: originals.voice.path, kind: 'size', actualSize: 100, actualSha256: byPath.get(originals.voice.path)?.actualSha256, expectedSize: 9000, expectedSha256: sha(originals.voice.bytes) });
  assert.equal(byPath.get(originals.video.path)?.kind, 'checksum');
  assert.equal(byPath.get(originals.video.path)?.actualSha256, sha(altered));
  assert.deepEqual([byPath.get(preview.path)?.kind, byPath.get(preview.path)?.preview], ['missing', true]);
  // Everything that could be copied is kept, including the damaged bytes; the intact legacy file is complete.
  assert.deepEqual(manifest.files.map(entry => entry.path).sort(), [originals.voice.path, originals.video.path, originals.legacy.path].sort());
  assert.equal((await stat(join(snapshot, 'files', originals.voice.path))).size, 100);
  assert.deepEqual(await readFile(join(snapshot, 'files', originals.video.path)), altered);
  assert.deepEqual(await readFile(join(snapshot, 'files', originals.legacy.path)), originals.legacy.bytes);
  await assert.rejects(() => lstat(join(snapshot, '.backup-in-progress')), { code: 'ENOENT' });

  const status = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(status.lastResult, 'degraded');
  assert.equal(status.problemFiles, 4);
  assert.equal(status.files, 3);
  assert.ok(status.lastSuccessAt);

  // Restore refuses a degraded copy unless the operator explicitly accepts the gaps.
  const restored = join(f.root, 'restored');
  const refused = await cliFailure(f.cli('restore.mjs', ['--from', snapshot, '--to', restored, '--app-stopped']));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr ?? '', /--allow-problems/);
  await assert.rejects(() => lstat(restored), { code: 'ENOENT' });
  const accepted = await f.cli('restore.mjs', ['--from', snapshot, '--to', restored, '--app-stopped', '--allow-problems']);
  assert.match(accepted.stderr, new RegExp(originals.photo.path));
  assert.deepEqual((await readdir(join(restored, 'files'))).sort(), [originals.voice.path, originals.video.path, originals.legacy.path].sort());
  assert.deepEqual(await readFile(join(restored, 'files', originals.legacy.path)), originals.legacy.bytes);
  const db = new DatabaseSync(join(restored, 'family.sqlite'), { readOnly: true });
  try { assert.equal((db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, 4, 'rows of lost files stay so they can be repaired'); } finally { db.close(); }
});

test('backup-status.json keeps the last success after a failure and an unreadable status file never breaks a backup', async t => {
  const f = await archive(t);
  await createBackup(f.data, join(f.root, 'first'));
  const first = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(first.lastResult, 'ok');
  await assert.rejects(() => createBackup(f.data, join(f.root, 'first')), /уже существует/);
  const failed = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(failed.lastResult, 'failed');
  assert.equal(failed.lastSuccessAt, first.lastSuccessAt);
  assert.equal(failed.lastDestination, first.lastDestination);
  await writeFile(join(f.data, 'backup-status.json'), '{ not json');
  const result = await createBackup(f.data, join(f.root, 'second'));
  assert.equal(result.problems.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8')).lastResult, 'ok');
  assert.deepEqual((await readdir(f.data)).filter(name => name.endsWith('.tmp')), []);
});

test('--link-dest hard-links unchanged files, copies new ones and carries forward files lost from DATA_DIR', async t => {
  const f = await archive(t);
  const first = join(f.root, 'first');
  const second = join(f.root, 'second');
  const firstResult = await createBackup(f.data, first, { statusFile: false });
  assert.equal(firstResult.bytesLinked, 0);
  const added = { path: 'e1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: bytes('new upload', 2000) };
  await writeFile(join(f.files, added.path), added.bytes);
  const store = new Store(f.data);
  try { store.put('files', { id: 'added', name: 'Новый синтетический файл', mime: 'image/jpeg', size: added.bytes.length, url: '/api/files/added', createdBy: 'admin', path: added.path, sha256: sha(added.bytes) }); } finally { store.close(); }

  const result = await f.cli('backup.mjs', ['--data-dir', f.data, '--out', second, '--link-dest', first]);
  assert.match(result.stdout, /Копия создана/);
  for (const path of [...Object.values(originals).map(file => file.path), preview.path]) {
    assert.equal((await stat(join(second, 'files', path))).ino, (await stat(join(first, 'files', path))).ino, `${path} is hard-linked`);
  }
  assert.equal((await stat(join(second, 'files', added.path))).nlink, 1, 'the new file is copied');
  const manifest = await manifestOf(second);
  assert.equal(manifest.files.length, 6);
  assert.ok(manifest.files.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(manifest.files.find(entry => entry.path === originals.legacy.path)?.sha256, sha(originals.legacy.bytes));
  assert.notEqual((await stat(join(second, 'family.sqlite'))).ino, (await stat(join(first, 'family.sqlite'))).ino, 'the database is always copied fresh');
  assert.equal((await verifyBackup(second)).ok, true);

  // A file that vanishes from DATA_DIR keeps its last intact version in every new snapshot.
  await unlink(join(f.files, originals.photo.path));
  await truncate(join(f.files, originals.legacy.path), 10);
  const third = join(f.root, 'third');
  const carried = await createBackup(f.data, third, { linkDest: second, statusFile: false });
  assert.deepEqual(carried.problems.map(problem => [problem.path, problem.kind, problem.recovered]).sort(), [[originals.photo.path, 'missing', true], [originals.legacy.path, 'size', true]].sort());
  assert.equal(carried.bytesLinked > 0, true);
  assert.deepEqual(await readFile(join(third, 'files', originals.photo.path)), originals.photo.bytes);
  assert.deepEqual(await readFile(join(third, 'files', originals.legacy.path)), originals.legacy.bytes);
  const restored = join(f.root, 'restored');
  const outcome = await restoreBackup(third, restored, true);
  assert.equal(outcome.problems.length, 0, 'recovered files do not block restore');
  assert.deepEqual(await readFile(join(restored, 'files', originals.photo.path)), originals.photo.bytes);
});

test('restore accepts version 1 manifests', async t => {
  const f = await archive(t);
  const snapshot = join(f.root, 'snapshot');
  await createBackup(f.data, snapshot, { statusFile: false });
  const { problems, ...manifest } = await manifestOf(snapshot);
  assert.deepEqual(problems, []);
  await writeFile(join(snapshot, 'manifest.json'), JSON.stringify({ ...manifest, version: 1 }));
  const result = await restoreBackup(snapshot, join(f.root, 'restored'), true);
  assert.equal(result.files, 5);
});

test('an aborted backup leaves no partial directory', async t => {
  const f = await archive(t);
  const destination = join(f.root, 'aborted');
  let checks = 0;
  // Aborts deterministically after the database and two files have been copied.
  const fake = { aborted: false, throwIfAborted() { if (++checks > 3) { fake.aborted = true; throw new DOMException('Aborted', 'AbortError'); } } };
  const signal = fake as unknown as AbortSignal;
  await assert.rejects(() => createBackup(f.data, destination, { signal }), { name: 'AbortError' });
  assert.ok(checks > 3);
  await assert.rejects(() => lstat(destination), { code: 'ENOENT' });
  const status = JSON.parse(await readFile(join(f.data, 'backup-status.json'), 'utf8'));
  assert.equal(status.lastResult, 'failed');
  assert.match(status.lastError, /прервано/);
});

test('verify passes on clean data and a clean backup, and detects missing, resized, altered and orphan files', async t => {
  const f = await archive(t);
  await mkdir(join(f.files, '.incoming'));
  await writeFile(join(f.files, '.incoming', 'partial-upload'), 'synthetic partial');
  await mkdir(join(f.files, '.heic-preview-abc'));
  const clean = await f.cli('verify.mjs', ['--data-dir', f.data]);
  assert.match(clean.stdout, /проблем не найдено/);
  assert.match(clean.stdout, /без контрольной суммы: 1/);
  const snapshot = join(f.root, 'snapshot');
  await createBackup(f.data, snapshot, { statusFile: false });
  assert.match((await f.cli('verify.mjs', ['--backup', snapshot])).stdout, /копия цела/);

  await unlink(join(f.files, originals.photo.path));
  await truncate(join(f.files, originals.voice.path), 10);
  const altered = Buffer.from(preview.bytes); altered[0] ^= 1;
  await writeFile(join(f.files, preview.path), altered);
  await writeFile(join(f.files, 'f1b2c3d4e5f60718293a4b5c6d7e8f90'), 'synthetic stray bytes');
  const result = await verifyDataDir(f.data);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(problem => [problem.path, problem.kind]).sort(), [[originals.photo.path, 'missing'], [originals.voice.path, 'size'], [preview.path, 'checksum']].sort());
  assert.deepEqual(result.orphans.map(orphan => orphan.path), ['f1b2c3d4e5f60718293a4b5c6d7e8f90']);
  assert.equal(result.legacyWithoutHash, 1);
  const quick = await verifyDataDir(f.data, { quick: true });
  assert.deepEqual(quick.problems.map(problem => problem.kind).sort(), ['missing', 'size'], '--quick skips hashing');
  const failure = await cliFailure(f.cli('verify.mjs', ['--data-dir', f.data]));
  assert.equal(failure.code, 2);
  assert.match(failure.stdout ?? '', /НАЙДЕНЫ ПРОБЛЕМЫ/);

  // Bit rot inside the backup itself is found without restoring, and nothing is modified.
  const rotten = await readFile(join(snapshot, 'files', originals.legacy.path)); rotten[5] ^= 1;
  await writeFile(join(snapshot, 'files', originals.legacy.path), rotten);
  const before = await readFile(join(snapshot, 'manifest.json'), 'utf8');
  const broken = await verifyBackup(snapshot);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems.map(problem => [problem.path, problem.kind]), [[originals.legacy.path, 'checksum']]);
  assert.equal(await readFile(join(snapshot, 'manifest.json'), 'utf8'), before);
  assert.equal((await cliFailure(f.cli('verify.mjs', ['--backup', join(f.root, 'missing-copy')]))).code, 1);
  await assert.rejects(() => readManifest(join(f.root, 'missing-copy')));
});
