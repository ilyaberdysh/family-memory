import { readFileSync } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { BackupStatus } from '../shared/types.js';
import { createBackup, formatBytes, IN_PROGRESS_MARKER, problemFileCount, readManifest, STATUS_FILE, type BackupStatusFile } from '../scripts/backup.mjs';

export interface BackupSchedulerOptions { dataDir: string; backupDir?: string; intervalHours?: number; keep?: number; firstDelayMs?: number; log?: (message: string) => void }
export interface BackupScheduler { status(): BackupStatus; runNow(): Promise<void>; close(): Promise<void> }

const HOUR = 3_600_000;
const MAX_TIMER = 2_147_483_647;
const INCOMPLETE_AGE = 24 * HOUR;
/** Snapshot directory names this scheduler creates; nothing else in BACKUP_DIR is ever deleted. */
export const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d{1,3})?$/;
export const snapshotName = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function readStatusFile(dataDir: string): Partial<BackupStatusFile> {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, STATUS_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<BackupStatusFile> : {};
  } catch { return {}; }
}

interface Snapshot { name: string; path: string; complete: boolean }

async function listSnapshots(backupDir: string): Promise<Snapshot[]> {
  let entries;
  try { entries = await readdir(backupDir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const snapshots: Snapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SNAPSHOT_NAME.test(entry.name)) continue;
    const path = join(backupDir, entry.name);
    const manifest = await lstat(join(path, 'manifest.json')).catch(() => null);
    snapshots.push({ name: entry.name, path, complete: Boolean(manifest?.isFile()) });
  }
  return snapshots.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0); // Newest first by UTC name.
}

export function startBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const log = options.log ?? ((line: string) => console.log(line));
  const dataDir = resolve(options.dataDir);
  const backupDir = options.backupDir?.trim() ? resolve(options.backupDir.trim()) : null;
  const automatic = backupDir !== null;
  const intervalHours = Number.isFinite(options.intervalHours) && options.intervalHours! > 0 ? Math.max(1, options.intervalHours!) : 24;
  const keep = Number.isFinite(options.keep) && options.keep! >= 1 ? Math.floor(options.keep!) : 7;
  const firstDelayMs = Number.isFinite(options.firstDelayMs) && options.firstDelayMs! >= 0 ? options.firstDelayMs! : 10 * 60_000;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const lastSuccess = () => {
    const value = timestamp(readStatusFile(dataDir).lastSuccessAt);
    return value ? Date.parse(value) : null;
  };

  // Prune complete snapshots beyond `keep` and interrupted ones older than a day. Only our snapshot names with a
  // family-space manifest (or our in-progress marker) qualify, and never the live DATA_DIR or the snapshot just made.
  async function prune(directory: string, current: string) {
    const realData = await realpath(dataDir).catch(() => dataDir);
    const realCurrent = await realpath(current).catch(() => current);
    let kept = 1; // The snapshot just made always counts, wherever a clock change sorts it.
    for (const snapshot of await listSnapshots(directory)) {
      const real = await realpath(snapshot.path).catch(() => null);
      if (!real || real === realCurrent || real === realData || realData.startsWith(`${real}${sep}`)) continue;
      if (snapshot.complete) {
        try { await readManifest(real); } catch { log(`Backup ${snapshot.name}: unreadable manifest, left in place.`); continue; }
        if (kept < keep) { kept++; continue; }
        await rm(real, { recursive: true, force: true });
        log(`Backup ${snapshot.name}: removed by rotation (keep ${keep}).`);
      } else {
        const marker = await lstat(join(real, IN_PROGRESS_MARKER)).catch(() => null);
        if (!marker?.isFile()) { log(`Backup ${snapshot.name}: incomplete without marker, left in place.`); continue; }
        if (Date.now() - marker.mtimeMs < INCOMPLETE_AGE) continue;
        await rm(real, { recursive: true, force: true });
        log(`Backup ${snapshot.name}: removed incomplete snapshot.`);
      }
    }
  }

  async function newestComplete(directory: string) {
    for (const snapshot of await listSnapshots(directory)) {
      if (!snapshot.complete) continue;
      try { await readManifest(snapshot.path); return snapshot.path; } catch { log(`Backup ${snapshot.name}: unreadable manifest, not used as a base.`); }
    }
    return undefined;
  }

  async function freeDestination(directory: string) {
    const base = snapshotName();
    for (let suffix = 0; suffix < 1000; suffix++) {
      const path = join(directory, suffix ? `${base}-${suffix}` : base);
      try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path; throw error; }
    }
    throw new Error('Не удалось подобрать имя для новой копии.');
  }

  async function perform(directory: string) {
    const abort = new AbortController();
    controller = abort;
    const started = Date.now();
    try {
      const linkDest = await newestComplete(directory);
      const result = await createBackup(dataDir, await freeDestination(directory), { linkDest, signal: abort.signal, warn: log });
      const problems = problemFileCount(result.problems);
      const name = result.destination.split(sep).pop();
      log(`Backup ${problems ? 'DEGRADED' : 'complete'}: ${name}, ${result.files} files, copied ${formatBytes(result.bytesCopied)}, linked ${formatBytes(result.bytesLinked)}, ${Math.round((Date.now() - started) / 1000)} s${problems ? `; ${problems} file(s) missing or damaged in DATA_DIR, see manifest.json` : ''}.`);
      try { await prune(directory, result.destination); } catch (error) { log(`Backup rotation failed: ${message(error)}`); }
    } catch (error) {
      log(abort.signal.aborted ? 'Backup interrupted by shutdown; the incomplete snapshot was removed.' : `Backup FAILED: ${message(error)}`);
      throw error;
    } finally { controller = null; }
  }

  function runNow(): Promise<void> {
    if (closed) return Promise.reject(new Error('Резервное копирование остановлено вместе с приложением.'));
    if (!backupDir) return Promise.reject(new Error('Автоматические копии выключены: задайте BACKUP_DIR.'));
    // Never two backups at once: a second request joins the running one.
    running ??= perform(backupDir).finally(() => { running = null; });
    return running;
  }

  function schedule(delay: number) {
    if (closed) return;
    timer = setTimeout(() => { void tick(); }, Math.min(Math.max(0, delay), MAX_TIMER));
    timer.unref();
  }

  async function tick() {
    timer = null;
    const success = lastSuccess();
    // A success in the far future means a wrong clock; do not let it suppress backups.
    const due = success === null || success > Date.now() + HOUR ? 0 : success + intervalHours * HOUR - Date.now();
    if (due > 0) return schedule(due);
    await runNow().catch(() => {}); // Already logged and recorded in backup-status.json.
    schedule(intervalHours * HOUR);
  }

  if (automatic) {
    schedule(firstDelayMs);
    log(`Automatic backups: every ${intervalHours} h, keeping ${keep} snapshots.`);
  }

  return {
    status() {
      const file = readStatusFile(dataDir);
      const lastSuccessAt = timestamp(file.lastSuccessAt);
      const limit = automatic ? Math.max(2 * intervalHours, 48) * HOUR : 7 * 24 * HOUR;
      const lastResult = file.lastResult === 'ok' || file.lastResult === 'degraded' || file.lastResult === 'failed' ? file.lastResult : null;
      return {
        automatic,
        intervalHours: automatic ? intervalHours : null,
        running: running !== null,
        lastAttemptAt: timestamp(file.lastAttemptAt),
        lastSuccessAt,
        lastResult,
        lastError: typeof file.lastError === 'string' ? file.lastError : null,
        problemFiles: Number.isSafeInteger(file.problemFiles) && file.problemFiles! > 0 ? file.problemFiles! : 0,
        stale: !lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > limit,
      };
    },
    runNow,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      await running?.catch(() => {});
    },
  };
}
