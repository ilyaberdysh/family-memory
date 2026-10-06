#!/usr/bin/env node
// Read-only integrity check of a live DATA_DIR or of a backup snapshot. It never modifies, moves or deletes anything.
import { DatabaseSync } from 'node:sqlite';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { collectReferences, describeProblem, digest, formatBytes, readManifest, regularFile, unexplainedDifferences } from './backup.mjs';

/** Temporary upload and conversion areas, not user data. */
const transient = name => name === '.incoming' || name.startsWith('.heic-preview-');

async function inspect(path, expected, quick) {
  let info;
  try { info = await lstat(path); } catch (error) { return { kind: 'missing', ...(error.code === 'ENOENT' ? {} : { error: error.code }) }; }
  if (!info.isFile()) return { kind: 'missing', error: 'not-a-file' };
  if (expected.size !== null && info.size !== expected.size) return { kind: 'size', actualSize: info.size };
  if (quick || !expected.sha256) return null;
  let actualSha256;
  try { actualSha256 = await digest(path); } catch (error) { return { kind: 'missing', error: error.code ?? 'read' }; }
  return actualSha256 === expected.sha256 ? null : { kind: 'checksum', actualSha256 };
}

function quickCheck(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    const references = collectReferences(db);
    const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
    return { references, databaseOk: integrity === 'ok', databaseError: integrity === 'ok' ? null : String(integrity).slice(0, 300) };
  } finally { db?.close(); }
}

export async function verifyDataDir(dataDirectory, { quick = false } = {}) {
  const root = await realpath(resolve(dataDirectory)).catch(() => { throw new Error('Каталог DATA_DIR не найден.'); });
  await regularFile(join(root, 'family.sqlite')).catch(() => { throw new Error('В DATA_DIR нет обычного файла family.sqlite.'); });
  // List first, then read the database: a file uploaded in between is then referenced rather than reported as an orphan.
  const listing = await readdir(join(root, 'files'), { withFileTypes: true }).catch(() => { throw new Error('В DATA_DIR нет каталога files.'); });
  const { references, databaseOk, databaseError } = quickCheck(join(root, 'family.sqlite'));
  const problems = references.invalid.map(item => ({ path: item.path, kind: 'invalid', fileId: item.fileId, reason: item.reason, ...(item.preview ? { preview: true } : {}) }));
  let hashed = 0, legacyWithoutHash = 0, previews = 0;
  for (const reference of references.files.values()) {
    if (reference.preview) previews++;
    if (!reference.sha256) legacyWithoutHash++;
    else if (!quick) hashed++;
    const found = await inspect(join(root, 'files', reference.path), reference, quick);
    if (found) problems.push({ path: reference.path, ...found, expectedSize: reference.size, ...(reference.sha256 ? { expectedSha256: reference.sha256 } : {}), ...(reference.preview ? { preview: true } : {}) });
  }
  const orphans = [];
  for (const entry of listing) {
    if (transient(entry.name) || references.files.has(entry.name)) continue;
    const info = await lstat(join(root, 'files', entry.name)).catch(() => null);
    if (!info) continue; // Removed while listing.
    orphans.push({ path: entry.name, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.isFile() ? info.size : null });
  }
  return { ok: databaseOk && !problems.length, databaseOk, databaseError, files: references.files.size, previews, hashed, legacyWithoutHash, quick, problems, orphans };
}

export async function verifyBackup(backupDirectory, { quick = false } = {}) {
  const root = await realpath(resolve(backupDirectory)).catch(() => { throw new Error('Каталог копии не найден.'); });
  const manifest = await readManifest(root);
  const folder = await lstat(join(root, 'files')).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) throw new Error('Некорректный каталог файлов копии.');
  const problems = [];
  for (const entry of [manifest.database, ...manifest.files]) {
    const relativePath = entry === manifest.database ? entry.path : join('files', entry.path);
    const found = await inspect(join(root, relativePath), entry, quick);
    if (found) problems.push({ path: entry.path, ...found, expectedSize: entry.size, expectedSha256: entry.sha256, ...(entry === manifest.database ? { database: true } : {}) });
  }
  let databaseOk = false, databaseError = null, differences = [];
  if (!problems.some(problem => problem.database)) {
    try {
      const checked = quickCheck(join(root, 'family.sqlite'));
      ({ databaseOk, databaseError } = checked);
      differences = unexplainedDifferences(checked.references, manifest);
    } catch (error) { databaseError = error.message; }
  } else databaseError = 'файл базы в копии повреждён';
  const recorded = manifest.problems.filter(problem => !problem.recovered);
  const recovered = manifest.problems.filter(problem => problem.recovered);
  return {
    ok: databaseOk && !problems.length && !differences.length && !recorded.length,
    version: manifest.version, createdAt: manifest.createdAt ?? null, files: manifest.files.length, quick,
    databaseOk, databaseError, problems, differences, recorded, recovered,
  };
}

function printDataDir(directory, result) {
  console.log(`Проверка DATA_DIR: ${directory}`);
  console.log(result.databaseOk ? 'База данных: проверка целостности пройдена.' : `База данных: ОШИБКА ЦЕЛОСТНОСТИ (${result.databaseError}).`);
  console.log(`Файлов в базе: ${result.files} (версий для браузера: ${result.previews}). ${result.quick ? 'Быстрая проверка: только наличие и размер.' : `С записанной контрольной суммой сверено: ${result.hashed}.`}`);
  if (result.legacyWithoutHash) console.log(`Старых записей без контрольной суммы: ${result.legacyWithoutHash} — для них проверены только наличие и размер.`);
  if (result.problems.length) {
    console.log(`ПРОБЛЕМЫ (${result.problems.length}):`);
    for (const problem of result.problems) console.log(`  - ${describeProblem(problem)}`);
  }
  if (result.orphans.length) {
    console.log(`Файлы без записи в базе (${result.orphans.length}); на код выхода не влияют, ничего не удалено:`);
    for (const orphan of result.orphans.slice(0, 50)) console.log(`  - files/${orphan.path}${orphan.type === 'file' ? ` (${formatBytes(orphan.size)})` : orphan.type === 'directory' ? ' (каталог)' : ''}`);
    if (result.orphans.length > 50) console.log(`  … и ещё ${result.orphans.length - 50}.`);
    console.log('  Свежие файлы могут принадлежать идущей загрузке или подготовке версии для браузера.');
  }
  console.log(result.ok ? 'Итог: проблем не найдено.' : 'Итог: НАЙДЕНЫ ПРОБЛЕМЫ.');
}

function printBackup(directory, result) {
  console.log(`Проверка копии: ${directory} (формат ${result.version}${result.createdAt ? `, создана ${result.createdAt}` : ''})`);
  console.log(`Файлов в манифесте: ${result.files}. ${result.quick ? 'Быстрая проверка: только наличие и размер.' : 'Размеры и контрольные суммы сверены.'}`);
  console.log(result.databaseOk ? 'База данных в копии: проверка целостности пройдена.' : `База данных в копии: ОШИБКА (${result.databaseError}).`);
  for (const problem of result.problems) console.log(`  - повреждено в копии: ${describeProblem(problem)}`);
  for (const path of result.differences) console.log(`  - не соответствует базе копии: ${path}`);
  if (result.recorded.length) {
    console.log(`Проблемы, записанные при создании копии (${result.recorded.length}); восстановление потребует --allow-problems:`);
    for (const problem of result.recorded) console.log(`  - ${describeProblem(problem)}`);
  }
  if (result.recovered.length) console.log(`Файлов, повреждённых в DATA_DIR на момент копии, но сохранённых в копии из прежних целых версий: ${result.recovered.length}.`);
  console.log(result.ok ? 'Итог: копия цела.' : 'Итог: НАЙДЕНЫ ПРОБЛЕМЫ.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, backup: { type: 'string' }, quick: { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/verify.mjs [--data-dir ./data] [--backup /private/backups/copy] [--quick]\nКоды выхода: 0 — проблем нет, 2 — найдены проблемы, 1 — проверка не выполнена.');
    else {
      let ok = true;
      const dataDirectory = values['data-dir'] || (values.backup ? undefined : process.env.DATA_DIR || './data');
      if (dataDirectory) {
        const result = await verifyDataDir(dataDirectory, { quick: values.quick });
        printDataDir(dataDirectory, result);
        ok &&= result.ok;
      }
      if (values.backup) {
        const result = await verifyBackup(values.backup, { quick: values.quick });
        printBackup(values.backup, result);
        ok &&= result.ok;
      }
      process.exitCode = ok ? 0 : 2;
    }
  } catch (error) { console.error(`Проверка не выполнена: ${error.message}`); process.exitCode = 1; }
}
