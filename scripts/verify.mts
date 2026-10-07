// Read-only integrity check of the live database + DATA_DIR/files, or of a backup snapshot. It never modifies, moves or deletes anything.
// Run: node_modules/.bin/tsx scripts/verify.mts [--database-url …] [--data-dir DATA_DIR] [--backup DIR] [--family <uuid>] [--quick]
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Database } from '../server/db.js';
import {
  DATABASE_FILE, References, UUID, describeProblem, digest, formatBytes, isMain, openDatabase, readManifest, readRows, regularFile, unexplainedDifferences,
  type BackupProblem, type FileReference, type Table,
} from './backup.mts';

/** Temporary upload, conversion, restore and import areas start with a dot and are never user data. */
const transient = (name: string) => name.startsWith('.');

export interface Orphan { path: string; type: 'file' | 'directory' | 'other'; size: number | null }
export interface FamilyCheck { id: string; name: string; files: number; problems: number; orphans: number }
export interface LiveVerification {
  ok: boolean; families: FamilyCheck[]; files: number; previews: number; hashed: number; legacyWithoutHash: number; quick: boolean;
  problems: BackupProblem[]; orphans: Orphan[];
}
export interface BackupVerification {
  ok: boolean; version: 1 | 2 | 3; createdAt: string | null; family: string | null; files: number; rows: number | null; quick: boolean;
  databaseOk: boolean; databaseError: string | null;
  /** Damage found now inside the copy. */ problems: (BackupProblem & { database?: true })[];
  /** Paths where the copy's database and manifest disagree. */ differences: string[];
  /** Problems recorded when the copy was made. */ recorded: BackupProblem[]; recovered: BackupProblem[];
}

async function inspect(path: string, expected: { size: number | null; sha256: string | null }, quick: boolean): Promise<Partial<BackupProblem> & Pick<BackupProblem, 'kind'> | null> {
  let info;
  try { info = await lstat(path); } catch (error) { const code = (error as NodeJS.ErrnoException).code; return { kind: 'missing', ...(code === 'ENOENT' ? {} : { error: code }) }; }
  if (!info.isFile()) return { kind: 'missing', error: 'not-a-file' };
  if (expected.size !== null && info.size !== expected.size) return { kind: 'size', actualSize: info.size };
  if (quick || !expected.sha256) return null;
  let actualSha256;
  try { actualSha256 = await digest(path); } catch (error) { return { kind: 'missing', error: (error as NodeJS.ErrnoException).code ?? 'read' }; }
  return actualSha256 === expected.sha256 ? null : { kind: 'checksum', actualSha256 };
}

async function entries(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
}

async function orphan(path: string, relativePath: string): Promise<Orphan | null> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null; // Removed while listing.
  return { path: relativePath, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.isFile() ? info.size : null };
}

/** Compares every `files` row (all families or one) with DATA_DIR/files/<familyId>/ and lists files no row references. */
export async function verifyLive({ db, dataDir, family, quick = false }: { db: Database; dataDir: string; family?: string; quick?: boolean }): Promise<LiveVerification> {
  if (family !== undefined && !UUID.test(family)) throw new Error('Укажите идентификатор семьи (UUID).');
  const root = await realpath(resolve(dataDir)).catch(() => { throw new Error('Каталог DATA_DIR не найден.'); });
  const filesRoot = join(root, 'files');
  // List first, then read the database: a file uploaded in between is then referenced rather than reported as an orphan.
  const topLevel = await entries(filesRoot);
  const listings = new Map<string, string[]>();
  for (const entry of topLevel) if (entry.isDirectory() && UUID.test(entry.name) && (!family || entry.name === family)) listings.set(entry.name, (await entries(join(filesRoot, entry.name))).map(item => item.name));
  const references = new References();
  const names = new Map<string, string>();
  await db.system(async store => {
    for (const row of await store.raw(`SELECT id::text AS id, data->>'name' AS name FROM families ${family ? 'WHERE id = $1' : ''} ORDER BY seq`, family ? [family] : [])) names.set(String(row.id), String(row.name ?? ''));
    if (family && !names.size) throw new Error('Семья с таким идентификатором не найдена.');
    const rows = await store.raw(`SELECT id, family_id::text AS family_id, data FROM files ${family ? 'WHERE family_id = $1' : ''} ORDER BY seq`, family ? [family] : []);
    for (const row of rows) references.add(String(row.family_id), String(row.id), typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
  });
  const problems = references.problems();
  let hashed = 0, legacyWithoutHash = 0, previews = 0;
  for (const reference of references.files.values()) {
    if (reference.preview) previews++;
    if (!reference.sha256) legacyWithoutHash++;
    else if (!quick) hashed++;
    const found = await inspect(join(filesRoot, reference.path), reference, quick);
    if (found) problems.push({ path: reference.path, familyId: reference.familyId, ...found, expectedSize: reference.size, ...(reference.sha256 ? { expectedSha256: reference.sha256 } : {}), ...(reference.preview ? { preview: true as const } : {}) });
  }
  const orphans: Orphan[] = [];
  if (!family) {
    for (const entry of topLevel) {
      if (transient(entry.name) || (entry.isDirectory() && names.has(entry.name))) continue;
      // Flat files from the single-family layout, directories of deleted families and anything else unknown.
      const found = await orphan(join(filesRoot, entry.name), entry.name);
      if (found) orphans.push(found);
    }
  }
  for (const [id, listing] of listings) {
    if (!names.has(id)) continue;
    for (const name of listing) {
      if (transient(name) || references.files.has(`${id}/${name}`)) continue;
      const found = await orphan(join(filesRoot, id, name), `${id}/${name}`);
      if (found) orphans.push(found);
    }
  }
  const byFamily = (list: { path: string | null; familyId?: string }[], id: string) => list.filter(item => item.familyId === id || item.path?.startsWith(`${id}/`)).length;
  const files = [...references.files.values()];
  const families = [...names].map(([id, name]) => ({ id, name, files: files.filter((reference: FileReference) => reference.familyId === id).length, problems: byFamily(problems, id), orphans: byFamily(orphans, id) }));
  return { ok: !problems.length, families, files: references.files.size, previews, hashed, legacyWithoutHash, quick, problems, orphans };
}

export async function verifyBackup(backupDirectory: string, { quick = false } = {}): Promise<BackupVerification> {
  const root = await realpath(resolve(backupDirectory)).catch(() => { throw new Error('Каталог копии не найден.'); });
  const manifest = await readManifest(root);
  const folder = await lstat(join(root, 'files')).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) throw new Error('Некорректный каталог файлов копии.');
  const problems: BackupVerification['problems'] = [];
  for (const entry of [manifest.database, ...manifest.files]) {
    const relativePath = entry === manifest.database ? entry.path : join('files', entry.path);
    const found = await inspect(join(root, relativePath), entry, quick);
    if (found) problems.push({ path: entry.path, ...found, expectedSize: entry.size, expectedSha256: entry.sha256, ...(entry === manifest.database ? { database: true as const } : {}) });
  }
  let databaseOk = false, databaseError: string | null = null, differences: string[] = [], rows: number | null = null;
  if (manifest.version < 3) databaseError = 'старый формат (SQLite): проверены только размеры и контрольные суммы; перенос — через scripts/import-sqlite.mts';
  else if (problems.some(problem => problem.database)) databaseError = 'файл базы в копии повреждён';
  else {
    try {
      // Parse every row: a snapshot that cannot be read back is not a backup.
      const references = new References();
      const counts: Partial<Record<Table, number>> = {};
      rows = 0;
      for await (const row of readRows(join(root, DATABASE_FILE))) {
        rows++;
        counts[row.table] = (counts[row.table] ?? 0) + 1;
        if (row.table === 'files') references.add(row.familyId as string, row.id, row.data);
      }
      for (const [table, count] of Object.entries(manifest.counts ?? {})) if ((counts[table as Table] ?? 0) !== count) throw new Error(`число записей ${table} не совпадает с манифестом`);
      differences = unexplainedDifferences(references, manifest);
      databaseOk = true;
    } catch (error) { databaseError = (error as Error).message; }
  }
  const recorded = manifest.problems.filter(problem => !problem.recovered);
  const recovered = manifest.problems.filter(problem => problem.recovered);
  return {
    ok: databaseOk && !problems.length && !differences.length && !recorded.length,
    version: manifest.version, createdAt: manifest.createdAt ?? null, family: manifest.family ?? null, files: manifest.files.length, rows, quick,
    databaseOk, databaseError, problems, differences, recorded, recovered,
  };
}

function printLive(directory: string, result: LiveVerification) {
  console.log(`Проверка базы и файлов: ${directory}`);
  console.log(`Семей: ${result.families.length}. Файлов в базе: ${result.files} (версий для браузера: ${result.previews}). ${result.quick ? 'Быстрая проверка: только наличие и размер.' : `С записанной контрольной суммой сверено: ${result.hashed}.`}`);
  for (const family of result.families) if (family.problems || family.orphans) console.log(`  семья ${family.id}${family.name ? ` («${family.name}»)` : ''}: файлов ${family.files}, проблем ${family.problems}, лишних файлов ${family.orphans}`);
  if (result.legacyWithoutHash) console.log(`Старых записей без контрольной суммы: ${result.legacyWithoutHash} — для них проверены только наличие и размер.`);
  if (result.problems.length) {
    console.log(`ПРОБЛЕМЫ (${result.problems.length}):`);
    for (const problem of result.problems) console.log(`  - ${describeProblem(problem)}`);
  }
  if (result.orphans.length) {
    console.log(`Файлы без записи в базе (${result.orphans.length}); на код выхода не влияют, ничего не удалено:`);
    for (const item of result.orphans.slice(0, 50)) console.log(`  - files/${item.path}${item.type === 'file' ? ` (${formatBytes(item.size ?? 0)})` : item.type === 'directory' ? ' (каталог)' : ''}`);
    if (result.orphans.length > 50) console.log(`  … и ещё ${result.orphans.length - 50}.`);
    console.log('  Свежие файлы могут принадлежать идущей загрузке; файлы прямо в files/ остаются от прежней односемейной раскладки.');
  }
  console.log(result.ok ? 'Итог: проблем не найдено.' : 'Итог: НАЙДЕНЫ ПРОБЛЕМЫ.');
}

function printBackup(directory: string, result: BackupVerification) {
  console.log(`Проверка копии: ${directory} (формат ${result.version}${result.createdAt ? `, создана ${result.createdAt}` : ''}${result.family ? `, одна семья ${result.family}` : ''})`);
  console.log(`Файлов в манифесте: ${result.files}${result.rows !== null ? `; записей базы: ${result.rows}` : ''}. ${result.quick ? 'Быстрая проверка: только наличие и размер.' : 'Размеры и контрольные суммы сверены.'}`);
  console.log(result.databaseOk ? 'База данных в копии: все записи читаются.' : `База данных в копии: ОШИБКА (${result.databaseError}).`);
  for (const problem of result.problems) console.log(`  - повреждено в копии: ${describeProblem(problem)}`);
  for (const path of result.differences) console.log(`  - не соответствует базе копии: ${path}`);
  if (result.recorded.length) {
    console.log(`Проблемы, записанные при создании копии (${result.recorded.length}); восстановление потребует --allow-problems:`);
    for (const problem of result.recorded) console.log(`  - ${describeProblem(problem)}`);
  }
  if (result.recovered.length) console.log(`Файлов, повреждённых в DATA_DIR на момент копии, но сохранённых в копии из прежних целых версий: ${result.recovered.length}.`);
  console.log(result.ok ? 'Итог: копия цела.' : 'Итог: НАЙДЕНЫ ПРОБЛЕМЫ.');
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'database-url': { type: 'string' }, backup: { type: 'string' }, family: { type: 'string' }, quick: { type: 'boolean' }, 'app-stopped': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('tsx scripts/verify.mts [--database-url postgres://…] [--data-dir DATA_DIR] [--family <uuid>] [--backup /private/backups/copy] [--quick] [--app-stopped]\nБез DATABASE_URL используется PGlite в DATA_DIR/pglite (только при остановленном приложении).\nКоды выхода: 0 — проблем нет, 2 — найдены проблемы, 1 — проверка не выполнена.');
    else {
      let ok = true;
      const url = values['database-url'] || process.env.DATABASE_URL;
      const live = values['data-dir'] || values['database-url'] || values.family || !values.backup;
      if (live) {
        const dataDir = values['data-dir'] || process.env.DATA_DIR || './data';
        const db = await openDatabase({ url, dataDir, appStopped: values['app-stopped'] });
        try {
          const result = await verifyLive({ db, dataDir, family: values.family, quick: values.quick });
          printLive(dataDir, result);
          ok &&= result.ok;
        } finally { await db.close(); }
      }
      if (values.backup) {
        const result = await verifyBackup(values.backup, { quick: values.quick });
        printBackup(values.backup, result);
        ok &&= result.ok;
      }
      process.exitCode = ok ? 0 : 2;
    }
  } catch (error) { console.error(`Проверка не выполнена: ${(error as Error).message}`); process.exitCode = 1; }
}
