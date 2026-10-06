import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { SNAPSHOT_NAME, startBackupScheduler, type BackupSchedulerOptions } from '../server/backups.js';
import { createBackup } from '../scripts/backup.mjs';

// Synthetic archive only.
const photo = { path: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: Buffer.alloc(6000, 'synthetic scheduler photo ') };

async function archive(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'family-backup-scheduler-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const store = new Store(data);
  try {
    await writeFile(join(data, 'files', photo.path), photo.bytes);
    store.put('files', { id: 'photo', name: 'Синтетический снимок', mime: 'image/jpeg', size: photo.bytes.length, url: '/api/files/photo', createdBy: 'admin', path: photo.path, sha256: createHash('sha256').update(photo.bytes).digest('hex') });
  } finally { store.close(); }
  const logs: string[] = [];
  const start = (options: Partial<BackupSchedulerOptions> = {}) => {
    const scheduler = startBackupScheduler({ dataDir: data, backupDir: join(root, 'backups'), firstDelayMs: 3_600_000, log: line => logs.push(line), ...options });
    t.after(() => scheduler.close());
    return scheduler;
  };
  return { root, data, backups: join(root, 'backups'), logs, start };
}

const snapshots = async (directory: string) => (await readdir(directory).catch(() => [] as string[])).filter(name => SNAPSHOT_NAME.test(name)).sort();
async function until(condition: () => Promise<boolean>, timeout = 10_000) {
  for (const started = Date.now(); Date.now() - started < timeout; await delay(20)) if (await condition()) return;
  assert.fail('condition was not met in time');
}

test('runNow never overlaps, links unchanged files to the previous snapshot and rotation keeps N', async t => {
  const f = await archive(t);
  const scheduler = f.start({ keep: 2 });
  assert.deepEqual({ ...scheduler.status(), lastAttemptAt: null }, { automatic: true, intervalHours: 24, running: false, lastAttemptAt: null, lastSuccessAt: null, lastResult: null, lastError: null, problemFiles: 0, stale: true });
  const first = scheduler.runNow();
  assert.equal(scheduler.runNow(), first, 'a second request joins the running backup');
  assert.equal(scheduler.status().running, true);
  await first;
  assert.equal((await snapshots(f.backups)).length, 1);
  await scheduler.runNow();
  await scheduler.runNow();
  const kept = await snapshots(f.backups);
  assert.equal(kept.length, 2);
  assert.equal((await stat(join(f.backups, kept[0], 'files', photo.path))).ino, (await stat(join(f.backups, kept[1], 'files', photo.path))).ino);
  const status = scheduler.status();
  assert.equal(status.lastResult, 'ok');
  assert.equal(status.stale, false);
  assert.equal(status.running, false);
  assert.ok(f.logs.some(line => /removed by rotation/.test(line)));
  assert.ok(f.logs.every(line => !line.includes('Синтетический')), 'logs carry no archive content');
});

test('rotation never touches foreign, unreadable or recent incomplete directories, and clears stale interrupted ones', async t => {
  const f = await archive(t);
  await mkdir(f.backups, { recursive: true });
  const old = new Date(Date.now() - 3 * 86_400_000);
  const interrupted = join(f.backups, '2020-01-01T00-00-00Z');
  await mkdir(interrupted); await writeFile(join(interrupted, '.backup-in-progress'), ''); await utimes(join(interrupted, '.backup-in-progress'), old, old);
  const recent = join(f.backups, '2020-01-02T00-00-00Z');
  await mkdir(recent); await writeFile(join(recent, '.backup-in-progress'), '');
  const unmarked = join(f.backups, '2020-01-03T00-00-00Z');
  await mkdir(unmarked);
  const foreignManifest = join(f.backups, '2020-01-04T00-00-00Z');
  await mkdir(foreignManifest); await writeFile(join(foreignManifest, 'manifest.json'), '{"format":"something-else"}');
  const operatorCopy = join(f.backups, 'before-upgrade');
  await mkdir(operatorCopy);
  const scheduler = f.start({ keep: 1 });
  await scheduler.runNow();
  await scheduler.runNow();
  const left = await readdir(f.backups);
  assert.ok(!left.includes('2020-01-01T00-00-00Z'), 'an interrupted snapshot older than a day is removed');
  for (const name of ['2020-01-02T00-00-00Z', '2020-01-03T00-00-00Z', '2020-01-04T00-00-00Z', 'before-upgrade']) assert.ok(left.includes(name), `${name} is left in place`);
  assert.equal((await snapshots(f.backups)).filter(name => !name.startsWith('2020')).length, 1);
});

test('close() aborts a running backup and leaves no partial snapshot', async t => {
  const f = await archive(t);
  const scheduler = f.start();
  const running = scheduler.runNow();
  await scheduler.close();
  await assert.rejects(running);
  assert.deepEqual(await snapshots(f.backups), []);
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.status().lastResult, 'failed');
  await assert.rejects(() => scheduler.runNow(), /остановлено/);
});

test('the first automatic run happens only when the last success is older than the interval', async t => {
  const f = await archive(t);
  await createBackup(f.data, join(f.root, 'manual'));
  const recent = f.start({ firstDelayMs: 0 });
  await delay(300);
  assert.deepEqual(await snapshots(f.backups), [], 'a recent manual backup counts');
  assert.equal(recent.status().stale, false);
  await recent.close();

  await writeFile(join(f.data, 'backup-status.json'), JSON.stringify({ lastSuccessAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastResult: 'ok' }));
  const due = f.start({ firstDelayMs: 0 });
  assert.equal(due.status().stale, true, 'older than max(2 × interval, 48 h)');
  await until(async () => (await snapshots(f.backups)).length === 1 && due.status().lastResult === 'ok' && !due.status().running);
  assert.equal(due.status().stale, false);
});

test('without BACKUP_DIR the scheduler is manual-only but still reports CLI backups', async t => {
  const f = await archive(t);
  const scheduler = f.start({ backupDir: undefined, firstDelayMs: 0 });
  assert.deepEqual(scheduler.status(), { automatic: false, intervalHours: null, running: false, lastAttemptAt: null, lastSuccessAt: null, lastResult: null, lastError: null, problemFiles: 0, stale: true });
  await assert.rejects(() => scheduler.runNow(), /BACKUP_DIR/);
  await rm(join(f.data, 'files', photo.path));
  await createBackup(f.data, join(f.root, 'manual'));
  const status = scheduler.status();
  assert.equal(status.lastResult, 'degraded');
  assert.equal(status.problemFiles, 1);
  assert.equal(status.stale, false);
  await writeFile(join(f.data, 'backup-status.json'), JSON.stringify({ lastSuccessAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
  assert.equal(scheduler.status().stale, true, 'manual backups go stale after 7 days');
  await assert.rejects(() => lstat(f.backups), { code: 'ENOENT' });
});
