#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function safeFilename(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)) {
    throw new Error('Некорректное имя файла в снимке.');
  }
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

export function snapshotFiles(db) {
  const files = new Map();
  const include = (filename, size) => {
    const path = safeFilename(filename);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Некорректный размер файла в снимке.');
    if (files.has(path) && files.get(path) !== size) throw new Error('Противоречивые записи файлов в снимке.');
    files.set(path, size);
  };
  for (const row of db.prepare('SELECT data FROM files').all()) {
    const record = JSON.parse(row.data);
    include(record.path, record.size);
    if (record.previewPath !== undefined && record.previewPath !== null) {
      include(record.previewPath, record.previewSize);
    } else if (record.previewSize !== undefined && record.previewSize !== null) {
      throw new Error('В снимке указан размер версии для браузера без имени файла.');
    }
  }
  return files;
}

export function checkDatabase(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite не прошёл проверку целостности.');
}

export async function createBackup(dataDirectory, destination) {
  process.umask(0o077);
  const source = await realpath(resolve(dataDirectory));
  const target = resolve(destination);
  const inside = relative(source, target);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..')) throw new Error('Сохраняйте копию вне активного DATA_DIR.');
  await regularFile(join(source, 'family.sqlite'));
  const sourceFiles = await lstat(join(source, 'files'));
  if (!sourceFiles.isDirectory() || sourceFiles.isSymbolicLink()) throw new Error('Некорректный каталог исходных файлов.');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // Existing destinations are never overwritten.
  let complete = false;
  try {
    await mkdir(join(target, 'files'), { mode: 0o700 });
    const databasePath = join(target, 'family.sqlite');
    const sourceDb = new DatabaseSync(join(source, 'family.sqlite'), { readOnly: true, timeout: 5000 });
    try { await backup(sourceDb, databasePath); } finally { sourceDb.close(); }
    const snapshot = new DatabaseSync(databasePath);
    let referenced;
    try {
      // The portable snapshot is one database file and does not depend on a WAL sidecar.
      snapshot.exec('PRAGMA journal_mode=DELETE;');
      checkDatabase(snapshot);
      referenced = snapshotFiles(snapshot);
    } finally { snapshot.close(); }
    await chmod(databasePath, 0o600);
    const files = [];
    for (const [path, size] of referenced) {
      const sourcePath = join(source, 'files', path);
      if ((await regularFile(sourcePath)).size !== size) throw new Error('Исходный файл отсутствует, неполон или изменён. Копия не создана.');
      const targetPath = join(target, 'files', path);
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      if ((await regularFile(targetPath)).size !== size) throw new Error('Размер скопированного файла не совпадает.');
      await chmod(targetPath, 0o600);
      files.push({ path, size, sha256: await digest(targetPath) });
    }
    const manifest = {
      format: 'family-space-backup', version: 1, createdAt: new Date().toISOString(),
      database: { path: 'family.sqlite', size: (await regularFile(databasePath)).size, sha256: await digest(databasePath) },
      files,
    };
    // Presence of this file marks a completed snapshot; no .env or API keys are copied.
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    complete = true;
    return { destination: target, files: files.length };
  } finally {
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

export async function readManifest(directory) {
  const path = join(directory, 'manifest.json');
  if ((await regularFile(path)).size > 20_000_000) throw new Error('Манифест резервной копии слишком большой.');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.format !== 'family-space-backup' || manifest.version !== 1 || manifest.database?.path !== 'family.sqlite' || !Array.isArray(manifest.files)) {
    throw new Error('Неизвестный формат резервной копии.');
  }
  const paths = new Set();
  for (const entry of [manifest.database, ...manifest.files]) {
    safeFilename(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Некорректная запись в манифесте.');
    if (paths.has(entry.path)) throw new Error('Повторяющееся имя в манифесте.');
    paths.add(entry.path);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/backup.mjs --data-dir ./data --out /private/backups/new-copy');
    else {
      if (!values.out) throw new Error('Укажите новый каталог копии: --out /private/backups/new-copy');
      const result = await createBackup(values['data-dir'] || process.env.DATA_DIR || './data', values.out);
      console.log(`Копия создана: ${result.destination}. Файлов: ${result.files}.`);
    }
  } catch (error) { console.error(`Резервная копия не создана: ${error.message}`); process.exitCode = 1; }
}
