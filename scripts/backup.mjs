#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const STATUS_FILE = 'backup-status.json';
/** Present while a snapshot is being written; lets the scheduler tell an interrupted backup from anything else. */
export const IN_PROGRESS_MARKER = '.backup-in-progress';
const PROBLEM_KINDS = new Set(['missing', 'size', 'checksum', 'invalid']);
const SHA256 = /^[a-f0-9]{64}$/;
const FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

export function safeFilename(value) {
  if (typeof value !== 'string' || !FILENAME.test(value)) throw new Error('Некорректное имя файла в снимке.');
  return value;
}

export async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ожидался обычный файл без символической ссылки.');
  return info;
}

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function formatBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

/** Every file the database references. Damaged metadata is reported, not thrown, so one bad row cannot block every future backup. */
export function collectReferences(db) {
  const files = new Map();
  const invalid = [];
  const include = (fileId, path, size, sha256, preview) => {
    if (typeof path !== 'string' || !FILENAME.test(path)) { invalid.push({ fileId, path: null, preview, reason: 'name' }); return; }
    const knownSize = Number.isSafeInteger(size) && size >= 0 ? size : null;
    const hash = typeof sha256 === 'string' && SHA256.test(sha256.toLowerCase()) ? sha256.toLowerCase() : null;
    if (knownSize === null) invalid.push({ fileId, path, preview, reason: 'size' });
    if (sha256 !== undefined && sha256 !== null && !hash) invalid.push({ fileId, path, preview, reason: 'sha256' });
    const existing = files.get(path);
    if (!existing) { files.set(path, { path, size: knownSize, sha256: hash, preview }); return; }
    if (existing.size !== knownSize || (hash && existing.sha256 && existing.sha256 !== hash)) invalid.push({ fileId, path, preview, reason: 'duplicate' });
    existing.preview &&= preview;
    existing.sha256 ??= hash;
  };
  for (const row of db.prepare('SELECT id, data FROM files').all()) {
    const fileId = String(row.id);
    let record = null;
    try { record = JSON.parse(row.data); } catch { /* reported below */ }
    if (!record || typeof record !== 'object') { invalid.push({ fileId, path: null, preview: false, reason: 'record' }); continue; }
    include(fileId, record.path, record.size, record.sha256, false);
    if (record.previewPath !== undefined && record.previewPath !== null) include(fileId, record.previewPath, record.previewSize, record.previewSha256, true);
  }
  return { files, invalid };
}

/** Paths where the database and a manifest disagree without a recorded problem explaining it. */
export function unexplainedDifferences(references, manifest) {
  const listed = new Map(manifest.files.map(entry => [entry.path, entry]));
  const explained = new Set(manifest.problems.filter(problem => !problem.recovered && problem.path).map(problem => problem.path));
  const differences = [];
  for (const reference of references.files.values()) {
    const entry = listed.get(reference.path);
    const consistent = entry && reference.size !== null && entry.size === reference.size && (!reference.sha256 || entry.sha256 === reference.sha256);
    if (!consistent && !explained.has(reference.path)) differences.push(`files/${reference.path}`);
  }
  for (const entry of manifest.files) if (!references.files.has(entry.path)) differences.push(`files/${entry.path}`);
  const unnamed = references.invalid.filter(item => item.path === null).length;
  if (unnamed !== manifest.problems.filter(problem => problem.kind === 'invalid' && problem.path === null).length) differences.push('запись файла без имени');
  return differences;
}

export function checkDatabase(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite не прошёл проверку целостности.');
}

export function describeProblem(problem) {
  const name = problem.path ? `files/${problem.path}` : `запись файла ${problem.fileId ?? 'без идентификатора'}`;
  const role = problem.preview ? ' (версия для браузера)' : '';
  const detail = {
    missing: `отсутствует или не читается${problem.error ? ` (${problem.error})` : ''}`,
    size: `размер ${problem.actualSize ?? '?'} Б вместо ${problem.expectedSize ?? '?'} Б`,
    checksum: problem.expectedFrom === 'previous-backup' ? 'содержимое изменилось по сравнению с прежней копией' : 'содержимое не совпадает с записанной контрольной суммой',
    invalid: `некорректные сведения в базе (${problem.reason ?? 'запись'})`,
  }[problem.kind] ?? problem.kind;
  const outcome = problem.recovered ? '; в копию перенесена прежняя целая версия' : problem.kind === 'size' || problem.kind === 'checksum' ? '; сохранено то, что есть' : '';
  return `${name}${role}: ${detail}${outcome}`;
}

async function syncPath(path) {
  // Directory fsync is unsupported on some platforms; the data files themselves are always synced.
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); } catch (error) { if (!(await lstat(path)).isDirectory()) throw error; } finally { await handle?.close(); }
}

function outside(source, target) {
  const inside = relative(source, target);
  return Boolean(inside) && (inside.startsWith(`..${sep}`) || inside === '..');
}

async function loadPrevious(directory) {
  let root, manifest;
  try {
    root = await realpath(resolve(directory));
    manifest = await readManifest(root);
  } catch (error) { throw new Error(`Каталог --link-dest не является завершённой копией: ${error.message}`); }
  return {
    root, files: new Map(manifest.files.map(entry => [entry.path, entry])),
    damaged: new Set(manifest.problems.filter(problem => !problem.recovered && problem.path).map(problem => problem.path)),
  };
}

/** Hard-links (or, across filesystems, copies) a verified file from the previous snapshot. Returns null when it cannot be reused. */
async function reuse(previous, earlier, targetPath) {
  const earlierPath = join(previous.root, 'files', earlier.path);
  try { if ((await regularFile(earlierPath)).size !== earlier.size) return null; } catch { return null; }
  // EXDEV/EPERM/EMLINK and similar: copy the verified earlier file instead; any further failure falls back to the live file.
  try { await link(earlierPath, targetPath); return { linked: earlier.size, copied: 0 }; } catch { await rm(targetPath, { force: true }); }
  try {
    await copyFile(earlierPath, targetPath, constants.COPYFILE_EXCL);
    await chmod(targetPath, 0o600);
    if (await digest(targetPath) === earlier.sha256) { await syncPath(targetPath); return { linked: 0, copied: earlier.size }; }
  } catch { /* fall back to the live file */ }
  await rm(targetPath, { force: true });
  return null;
}

async function backupFile(source, target, reference, previous) {
  const { path, size: expectedSize, sha256: expectedSha256, preview } = reference;
  const sourcePath = join(source, 'files', path);
  const targetPath = join(target, 'files', path);
  const problem = details => ({ path, ...details, expectedSize, ...(expectedSha256 ? { expectedSha256 } : {}), ...(preview ? { preview: true } : {}) });
  let damage = null;
  try {
    const info = await lstat(sourcePath);
    if (!info.isFile()) damage = { kind: 'missing', error: 'not-a-file' };
    else if (expectedSize !== null && info.size !== expectedSize) damage = { kind: 'size', actualSize: info.size };
  } catch (error) { damage = { kind: 'missing', ...(error.code === 'ENOENT' ? {} : { error: error.code }) }; }

  const earlier = previous?.files.get(path);
  let reusable = earlier && expectedSize !== null && earlier.size === expectedSize && !previous.damaged.has(path)
    && (!expectedSha256 || earlier.sha256 === expectedSha256) ? earlier : null;
  let changed = null;
  if (reusable && !expectedSha256 && !damage) {
    // Legacy rows have no recorded hash: a fresh source hash (reading is cheaper than writing) proves the earlier copy.
    const current = await digest(sourcePath).catch(error => ({ error: error.code ?? 'read' }));
    if (typeof current !== 'string') damage = { kind: 'missing', error: current.error };
    else if (current !== reusable.sha256) {
      // Originals never change, so different bytes mean damage on one side. Keep the live bytes and flag the original;
      // the earlier snapshot still holds the previous version.
      if (!preview) changed = { kind: 'checksum', expectedFrom: 'previous-backup', expectedSha256: reusable.sha256 };
      reusable = null;
    }
  }
  // If the live file is damaged, the earlier intact copy is carried forward so rotation never drops the last good version.
  if (reusable) {
    const reused = await reuse(previous, reusable, targetPath);
    if (reused) return { entry: { path, size: reusable.size, sha256: reusable.sha256 }, problem: damage ? problem({ ...damage, recovered: true }) : null, ...reused };
  }
  if (damage?.kind === 'missing') return { problem: problem(damage), copied: 0, linked: 0 };

  // Copy whatever the live file holds: damaged bytes are still better than nothing.
  for (let attempt = 0; ; attempt++) {
    try { await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL); }
    catch (error) {
      await rm(targetPath, { force: true });
      // A readable source means the destination failed (for example, no space): that must fail the whole backup.
      if (await digest(sourcePath).then(() => true, () => false)) throw new Error(`Не удалось записать files/${path} в копию: ${error.code ?? error.message}`);
      return { problem: problem({ kind: 'missing', error: error.code ?? 'read' }), copied: 0, linked: 0 };
    }
    await chmod(targetPath, 0o600);
    const copied = await regularFile(targetPath);
    const actualSha256 = await digest(targetPath);
    let found = null;
    if (expectedSize !== null && copied.size !== expectedSize) found = { kind: 'size', actualSize: copied.size, actualSha256 };
    else if (expectedSha256 && actualSha256 !== expectedSha256) {
      // Retry once when the source itself is intact and only the copy came out wrong.
      if (attempt === 0 && await digest(sourcePath).catch(() => null) === expectedSha256) { await rm(targetPath, { force: true }); continue; }
      found = { kind: 'checksum', actualSize: copied.size, actualSha256 };
    } else if (changed && actualSha256 !== changed.expectedSha256) found = { ...changed, actualSize: copied.size, actualSha256 };
    await syncPath(targetPath);
    return { entry: { path, size: copied.size, sha256: actualSha256 }, problem: found && problem(found), copied: copied.size, linked: 0 };
  }
}

async function snapshot(dataDirectory, destination, linkDest, signal) {
  signal?.throwIfAborted();
  let source;
  try { source = await realpath(resolve(dataDirectory)); } catch { throw new Error('Каталог DATA_DIR не найден.'); }
  if (!outside(source, resolve(destination))) throw new Error('Сохраняйте копию вне активного DATA_DIR.');
  await regularFile(join(source, 'family.sqlite')).catch(() => { throw new Error('В DATA_DIR нет обычного файла family.sqlite.'); });
  const sourceFiles = await lstat(join(source, 'files')).catch(() => null);
  if (!sourceFiles?.isDirectory() || sourceFiles.isSymbolicLink()) throw new Error('Некорректный каталог исходных файлов.');
  const previous = linkDest ? await loadPrevious(linkDest) : null;
  await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  // Re-check through the real parent so a symlinked parent cannot place the copy inside DATA_DIR.
  const target = join(await realpath(dirname(resolve(destination))), basename(resolve(destination)));
  if (!outside(source, target)) throw new Error('Сохраняйте копию вне активного DATA_DIR.');
  try { await mkdir(target, { mode: 0o700 }); } // Existing destinations are never overwritten.
  catch (error) { throw new Error(error.code === 'EEXIST' ? 'Каталог копии уже существует; укажите новое имя.' : `Не удалось создать каталог копии: ${error.code ?? error.message}`); }
  let complete = false;
  try {
    await writeFile(join(target, IN_PROGRESS_MARKER), '', { flag: 'wx', mode: 0o600 });
    await mkdir(join(target, 'files'), { mode: 0o700 });
    const databasePath = join(target, 'family.sqlite');
    const sourceDb = new DatabaseSync(join(source, 'family.sqlite'), { readOnly: true, timeout: 5000 });
    // node:sqlite can settle the backup promise only on the next event-loop wake-up; a short timer keeps the loop turning.
    const keepAwake = setInterval(() => {}, 50);
    try { await backup(sourceDb, databasePath); } finally { clearInterval(keepAwake); sourceDb.close(); }
    const snapshotDb = new DatabaseSync(databasePath);
    let references;
    try {
      // The portable snapshot is one database file and does not depend on a WAL sidecar.
      snapshotDb.exec('PRAGMA journal_mode=DELETE;');
      checkDatabase(snapshotDb);
      references = collectReferences(snapshotDb);
    } finally { snapshotDb.close(); }
    await chmod(databasePath, 0o600);
    await syncPath(databasePath);
    const database = { path: 'family.sqlite', size: (await regularFile(databasePath)).size, sha256: await digest(databasePath) };
    let bytesCopied = database.size, bytesLinked = 0;
    const files = [];
    const problems = references.invalid.map(item => ({ path: item.path, kind: 'invalid', fileId: item.fileId, reason: item.reason, ...(item.preview ? { preview: true } : {}) }));
    for (const reference of references.files.values()) {
      signal?.throwIfAborted();
      const outcome = await backupFile(source, target, reference, previous);
      if (outcome.entry) files.push(outcome.entry);
      if (outcome.problem) problems.push(outcome.problem);
      bytesCopied += outcome.copied;
      bytesLinked += outcome.linked;
    }
    signal?.throwIfAborted();
    await syncPath(join(target, 'files'));
    const manifest = { format: 'family-space-backup', version: 2, createdAt: new Date().toISOString(), database, files, problems };
    // Presence of this file marks a completed snapshot; no .env or API keys are copied.
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await syncPath(join(target, 'manifest.json'));
    await rm(join(target, IN_PROGRESS_MARKER), { force: true });
    await syncPath(target);
    complete = true;
    return { destination: target, files: files.length, problems, bytesCopied, bytesLinked };
  } finally {
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

const STATUS_DEFAULTS = { lastAttemptAt: null, lastSuccessAt: null, lastResult: null, lastError: null, lastDestination: null, problemFiles: 0, files: 0, bytesCopied: 0, bytesLinked: 0 };

/** Merges into DATA_DIR/backup-status.json atomically. Never throws: the status file is advisory. */
export async function recordBackupStatus(dataDirectory, patch, warn = console.warn) {
  const directory = resolve(dataDirectory);
  const path = join(directory, STATUS_FILE);
  const temporary = join(directory, `.${STATUS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    let previous = {};
    try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* first attempt or unreadable */ }
    const known = previous && typeof previous === 'object' && !Array.isArray(previous)
      ? Object.fromEntries(Object.keys(STATUS_DEFAULTS).filter(key => key in previous).map(key => [key, previous[key]])) : {};
    await writeFile(temporary, `${JSON.stringify({ ...STATUS_DEFAULTS, ...known, ...patch }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    warn(`Не удалось обновить ${STATUS_FILE}: ${error.code ?? error.message}`);
  }
}

export function problemFileCount(problems) {
  return new Set(problems.map(problem => problem.path ?? `#${problem.fileId}`)).size;
}

export async function createBackup(dataDirectory, destination, options = {}) {
  const { linkDest, signal, statusFile = true, warn = console.warn } = options;
  const lastAttemptAt = new Date().toISOString();
  let result;
  try {
    result = await snapshot(dataDirectory, destination, linkDest, signal);
  } catch (error) {
    const lastError = signal?.aborted ? 'Резервное копирование прервано остановкой.' : error instanceof Error ? error.message : String(error);
    // Counts and destination keep describing the last completed backup.
    if (statusFile !== false) await recordBackupStatus(dataDirectory, { lastAttemptAt, lastResult: 'failed', lastError }, warn);
    throw error;
  }
  if (statusFile !== false) {
    const problemFiles = problemFileCount(result.problems);
    await recordBackupStatus(dataDirectory, {
      lastAttemptAt, lastSuccessAt: new Date().toISOString(), lastResult: problemFiles ? 'degraded' : 'ok',
      lastError: problemFiles ? `Копия создана с проблемами, файлов: ${problemFiles}. Подробности — в manifest.json копии и в выводе scripts/verify.mjs.` : null,
      lastDestination: result.destination, problemFiles, files: result.files, bytesCopied: result.bytesCopied, bytesLinked: result.bytesLinked,
    }, warn);
  }
  return result;
}

export async function readManifest(directory) {
  const path = join(directory, 'manifest.json');
  const info = await regularFile(path).catch(() => { throw new Error('Нет manifest.json: копия не завершена или это не резервная копия.'); });
  if (info.size > 64_000_000) throw new Error('Манифест резервной копии слишком большой.');
  let manifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('manifest.json повреждён.'); }
  if (manifest?.format !== 'family-space-backup' || ![1, 2].includes(manifest.version) || manifest.database?.path !== 'family.sqlite' || !Array.isArray(manifest.files)) {
    throw new Error('Неизвестный формат резервной копии.');
  }
  if (manifest.version === 1 && manifest.problems !== undefined) throw new Error('Неизвестный формат резервной копии.');
  const problems = manifest.version === 2 ? manifest.problems : [];
  if (!Array.isArray(problems)) throw new Error('Неизвестный формат резервной копии.');
  const paths = new Set();
  for (const entry of [manifest.database, ...manifest.files]) {
    safeFilename(entry?.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256)) throw new Error('Некорректная запись в манифесте.');
    if (paths.has(entry.path)) throw new Error('Повторяющееся имя в манифесте.');
    paths.add(entry.path);
  }
  for (const problem of problems) {
    if (!problem || !PROBLEM_KINDS.has(problem.kind)) throw new Error('Некорректная запись о проблеме в манифесте.');
    if (problem.path !== null || problem.kind !== 'invalid') safeFilename(problem.path);
    const stored = paths.has(problem.path);
    if ((problem.kind === 'missing' && !problem.recovered && stored) || ((problem.recovered || problem.kind === 'size' || problem.kind === 'checksum') && !stored)) {
      throw new Error('Запись о проблеме противоречит списку файлов манифеста.');
    }
  }
  return { ...manifest, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, out: { type: 'string' }, 'link-dest': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/backup.mjs --data-dir ./data --out /private/backups/new-copy [--link-dest /private/backups/previous-copy]');
    else {
      if (!values.out) throw new Error('Укажите новый каталог копии: --out /private/backups/new-copy');
      process.umask(0o077);
      const result = await createBackup(values['data-dir'] || process.env.DATA_DIR || './data', values.out, { linkDest: values['link-dest'] });
      const sizes = `скопировано ${formatBytes(result.bytesCopied)}${result.bytesLinked ? `, связано с прежней копией ${formatBytes(result.bytesLinked)}` : ''}`;
      if (!result.problems.length) console.log(`Копия создана: ${result.destination}. Файлов: ${result.files}; ${sizes}.`);
      else {
        console.error(`ВНИМАНИЕ: копия создана (${result.destination}), но файлов с проблемами: ${problemFileCount(result.problems)}.`);
        for (const problem of result.problems) console.error(`  - ${describeProblem(problem)}`);
        console.error(`Файлов в копии: ${result.files}; ${sizes}. Проверьте DATA_DIR: node scripts/verify.mjs --data-dir … и сохраните прежние копии, пока проблема не решена.`);
        process.exitCode = 2;
      }
    }
  } catch (error) { console.error(`Резервная копия не создана: ${error.message}`); process.exitCode = 1; }
}
