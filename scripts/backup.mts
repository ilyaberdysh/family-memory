// Logical, engine-independent snapshot of the whole service (or one family): NDJSON rows plus the files they reference.
// Run: node_modules/.bin/tsx scripts/backup.mts --out /private/backups/new-copy
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Database, FAMILY_TABLES, GLOBAL_TABLES, type FamilyTable, type GlobalTable } from '../server/db.js';

export const STATUS_FILE = 'backup-status.json';
/** Present while a snapshot is being written; lets the scheduler tell an interrupted backup from anything else. */
export const IN_PROGRESS_MARKER = '.backup-in-progress';
export const DATABASE_FILE = 'database.ndjson';
export type Table = GlobalTable | FamilyTable;
/** Login state never enters a snapshot: restored copies must not regain authority. */
export const EXCLUDED_TABLES = ['sessions', 'auth_flows', 'codes'] as const;
/** Insert order: referenced rows come first. */
export const BACKUP_TABLES = ['families', 'users', 'memberships', 'invitation_links', ...FAMILY_TABLES] as const satisfies readonly Table[];
const KNOWN_TABLES = new Set<string>([...GLOBAL_TABLES, ...FAMILY_TABLES]);
const FAMILY_SCOPED = new Set<string>(['memberships', 'invitation_links', ...FAMILY_TABLES]);
const PROBLEM_KINDS = new Set(['missing', 'size', 'checksum', 'invalid']);
const SHA256 = /^[a-f0-9]{64}$/;
const FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A file the backup could not keep exactly as the database describes it. `recovered`: the live file was damaged,
 * but the snapshot holds the intact earlier version from `linkDest`. `preview`: browser copy, regenerable from the original. */
export interface BackupProblem {
  path: string | null;
  kind: 'missing' | 'size' | 'checksum' | 'invalid';
  familyId?: string;
  expectedSize?: number | null;
  actualSize?: number;
  expectedSha256?: string;
  actualSha256?: string;
  expectedFrom?: 'previous-backup';
  preview?: true;
  recovered?: true;
  error?: string;
  fileId?: string;
  reason?: 'name' | 'size' | 'sha256' | 'duplicate' | 'record';
}
export interface ManifestEntry { path: string; size: number; sha256: string }
export interface FamilySummary { name: string; rows: Partial<Record<Table, number>>; files: number; bytes: number }
export interface BackupManifest {
  format: 'family-space-backup'; version: 1 | 2 | 3; createdAt?: string;
  /** v3: source engine and schema version; `family` set for a one-family export. */
  engine?: 'postgres' | 'pglite'; schemaVersion?: number; family?: string | null;
  database: ManifestEntry & { rows?: number };
  counts?: Partial<Record<Table, number>>; families?: Record<string, FamilySummary>; excluded?: string[];
  files: ManifestEntry[]; problems: BackupProblem[];
}
export interface BackupResult { destination: string; files: number; families: number; rows: number; problems: BackupProblem[]; bytesCopied: number; bytesLinked: number }
export interface BackupOptions {
  db: Database;
  /** DATA_DIR: originals and previews are read from DATA_DIR/files/<familyId>/<name>; backup-status.json is written here. */
  dataDir: string;
  /** A new directory outside DATA_DIR. */
  destination: string;
  /** A previous complete snapshot; unchanged verified files are hard-linked from it instead of copied. */
  linkDest?: string;
  /** Export only this family (its rows, its members' accounts and its files). */
  family?: string;
  signal?: AbortSignal;
  /** false: do not write DATA_DIR/backup-status.json. */
  statusFile?: boolean;
  warn?: (message: string) => void;
}
/** Contents of DATA_DIR/backup-status.json. Counts and destination describe the last completed (ok/degraded) backup. */
export interface BackupStatusFile {
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastResult: 'ok' | 'degraded' | 'failed' | null; lastError: string | null;
  lastDestination: string | null; problemFiles: number; files: number; bytesCopied: number; bytesLinked: number;
}
/** One NDJSON line. */
export interface DatabaseRow { table: Table; id: string; familyId?: string; userId?: string; data: unknown }
export interface FileReference { path: string; size: number | null; sha256: string | null; preview: boolean; familyId: string }
export interface InvalidReference { fileId: string; familyId: string; path: string | null; preview: boolean; reason: NonNullable<BackupProblem['reason']> }

export function safeFilename(value: unknown): string {
  if (typeof value !== 'string' || !FILENAME.test(value)) throw new Error('Некорректное имя файла в снимке.');
  return value;
}
/** `<familyId>/<name>` in v3 manifests, a bare name in v1/v2. */
export function safeStoredPath(value: unknown, version: number): string {
  if (version < 3) return safeFilename(value);
  const [family, name, extra] = typeof value === 'string' ? value.split('/') : [];
  if (extra !== undefined || !UUID.test(family ?? '')) throw new Error('Некорректное имя файла в снимке.');
  safeFilename(name);
  return value as string;
}

export async function regularFile(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ожидался обычный файл без символической ссылки.');
  return info;
}

export async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function formatBytes(bytes: number) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

/** Collects every file the `files` rows reference. Damaged metadata is reported, not thrown, so one bad row cannot block every future backup. */
export class References {
  readonly files = new Map<string, FileReference>();
  readonly invalid: InvalidReference[] = [];
  add(familyId: string, fileId: string, record: unknown) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { this.invalid.push({ fileId, familyId, path: null, preview: false, reason: 'record' }); return; }
    const value = record as Record<string, unknown>;
    this.include(familyId, fileId, value.path, value.size, value.sha256, false);
    if (value.previewPath !== undefined && value.previewPath !== null) this.include(familyId, fileId, value.previewPath, value.previewSize, value.previewSha256, true);
  }
  private include(familyId: string, fileId: string, name: unknown, size: unknown, sha256: unknown, preview: boolean) {
    if (typeof name !== 'string' || !FILENAME.test(name)) { this.invalid.push({ fileId, familyId, path: null, preview, reason: 'name' }); return; }
    const path = `${familyId}/${name}`;
    const knownSize = Number.isSafeInteger(size) && (size as number) >= 0 ? size as number : null;
    const hash = typeof sha256 === 'string' && SHA256.test(sha256.toLowerCase()) ? sha256.toLowerCase() : null;
    if (knownSize === null) this.invalid.push({ fileId, familyId, path, preview, reason: 'size' });
    if (sha256 !== undefined && sha256 !== null && !hash) this.invalid.push({ fileId, familyId, path, preview, reason: 'sha256' });
    const existing = this.files.get(path);
    if (!existing) { this.files.set(path, { path, size: knownSize, sha256: hash, preview, familyId }); return; }
    if (existing.size !== knownSize || (hash && existing.sha256 && existing.sha256 !== hash)) this.invalid.push({ fileId, familyId, path, preview, reason: 'duplicate' });
    existing.preview &&= preview;
    existing.sha256 ??= hash;
  }
  problems(): BackupProblem[] {
    return this.invalid.map(item => ({ path: item.path, kind: 'invalid', familyId: item.familyId, fileId: item.fileId, reason: item.reason, ...(item.preview ? { preview: true as const } : {}) }));
  }
}

/** Paths where the database and a manifest disagree without a recorded problem explaining it. */
export function unexplainedDifferences(references: References, manifest: Pick<BackupManifest, 'files' | 'problems'>): string[] {
  const listed = new Map(manifest.files.map(entry => [entry.path, entry]));
  const explained = new Set(manifest.problems.filter(problem => !problem.recovered && problem.path).map(problem => problem.path));
  const differences: string[] = [];
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

export function describeProblem(problem: BackupProblem) {
  const name = problem.path ? `files/${problem.path}` : `запись файла ${problem.fileId ?? 'без идентификатора'}${problem.familyId ? ` (семья ${problem.familyId})` : ''}`;
  const role = problem.preview ? ' (версия для браузера)' : '';
  const detail = ({
    missing: `отсутствует или не читается${problem.error ? ` (${problem.error})` : ''}`,
    size: `размер ${problem.actualSize ?? '?'} Б вместо ${problem.expectedSize ?? '?'} Б`,
    checksum: problem.expectedFrom === 'previous-backup' ? 'содержимое изменилось по сравнению с прежней копией' : 'содержимое не совпадает с записанной контрольной суммой',
    invalid: `некорректные сведения в базе (${problem.reason ?? 'запись'})`,
  } as Record<string, string>)[problem.kind] ?? problem.kind;
  const outcome = problem.recovered ? '; в копию перенесена прежняя целая версия' : problem.kind === 'size' || problem.kind === 'checksum' ? '; сохранено то, что есть' : '';
  return `${name}${role}: ${detail}${outcome}`;
}

export function problemFileCount(problems: BackupProblem[]) {
  return new Set(problems.map(problem => problem.path ?? `#${problem.familyId}/${problem.fileId}`)).size;
}

export async function syncPath(path: string) {
  // Directory fsync is unsupported on some platforms; the data files themselves are always synced.
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); } catch (error) { if (!(await lstat(path)).isDirectory()) throw error; } finally { await handle?.close(); }
}

export function outside(source: string, target: string) {
  const inside = relative(source, target);
  return Boolean(inside) && (inside.startsWith(`..${sep}`) || inside === '..');
}

/** Reads NDJSON rows one by one; throws on the first malformed line. */
export async function* readRows(path: string): AsyncGenerator<DatabaseRow> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let number = 0;
  for await (const line of lines) {
    number++;
    if (!line) continue;
    let row: DatabaseRow;
    try { row = JSON.parse(line); } catch { throw new Error(`${DATABASE_FILE}: строка ${number} повреждена.`); }
    if (!row || typeof row !== 'object' || !KNOWN_TABLES.has(row.table) || typeof row.id !== 'string' || !row.id || row.data === undefined
      || (FAMILY_SCOPED.has(row.table) || row.table === 'families' ? !UUID.test(row.familyId ?? '') : row.familyId !== undefined)
      || (row.table === 'memberships' ? typeof row.userId !== 'string' || !row.userId : row.userId !== undefined && row.table !== 'sessions')) {
      throw new Error(`${DATABASE_FILE}: строка ${number} не похожа на запись снимка.`);
    }
    yield row;
  }
}

interface Previous { root: string; files: Map<string, ManifestEntry>; bySha: Map<string, ManifestEntry>; damaged: Set<string> }

async function loadPrevious(directory: string): Promise<Previous> {
  let root: string, manifest: BackupManifest;
  try {
    root = await realpath(resolve(directory));
    manifest = await readManifest(root);
  } catch (error) { throw new Error(`Каталог --link-dest не является завершённой копией: ${(error as Error).message}`); }
  const damaged = new Set(manifest.problems.filter(problem => !problem.recovered && problem.path).map(problem => problem.path as string));
  const bySha = new Map<string, ManifestEntry>();
  // Content lookup lets an older (v2, flat) snapshot or a moved family still serve as the base for unchanged files.
  for (const entry of manifest.files) if (!damaged.has(entry.path) && !bySha.has(entry.sha256)) bySha.set(entry.sha256, entry);
  return { root, files: new Map(manifest.files.map(entry => [entry.path, entry])), bySha, damaged };
}

/** Hard-links (or, across filesystems, copies) a verified file from the previous snapshot. Returns null when it cannot be reused. */
async function reuse(previous: Previous, earlier: ManifestEntry, targetPath: string) {
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

type Outcome = { entry?: ManifestEntry; problem: BackupProblem | null; copied: number; linked: number };

async function backupFile(source: string, target: string, reference: FileReference, previous: Previous | null): Promise<Outcome> {
  const { path, size: expectedSize, sha256: expectedSha256, preview, familyId } = reference;
  const sourcePath = join(source, 'files', path);
  const targetPath = join(target, 'files', path);
  const problem = (details: Partial<BackupProblem> & Pick<BackupProblem, 'kind'>): BackupProblem => ({ path, familyId, ...details, expectedSize, ...(expectedSha256 ? { expectedSha256 } : {}), ...(preview ? { preview: true as const } : {}) });
  let damage: (Partial<BackupProblem> & Pick<BackupProblem, 'kind'>) | null = null;
  try {
    const info = await lstat(sourcePath);
    if (!info.isFile()) damage = { kind: 'missing', error: 'not-a-file' };
    else if (expectedSize !== null && info.size !== expectedSize) damage = { kind: 'size', actualSize: info.size };
  } catch (error) { damage = { kind: 'missing', ...(code(error) === 'ENOENT' ? {} : { error: code(error) }) }; }

  const earlier = previous ? previous.files.get(path) ?? (expectedSha256 ? previous.bySha.get(expectedSha256) : undefined) : undefined;
  let reusable = earlier && previous && expectedSize !== null && earlier.size === expectedSize && !previous.damaged.has(earlier.path)
    && (!expectedSha256 || earlier.sha256 === expectedSha256) ? earlier : null;
  let changed: (Partial<BackupProblem> & Pick<BackupProblem, 'kind'>) | null = null;
  if (reusable && !expectedSha256 && !damage) {
    // Legacy rows have no recorded hash: a fresh source hash (reading is cheaper than writing) proves the earlier copy.
    const current = await digest(sourcePath).catch(error => ({ error: code(error) }));
    if (typeof current !== 'string') damage = { kind: 'missing', error: current.error };
    else if (current !== reusable.sha256) {
      // Originals never change, so different bytes mean damage on one side. Keep the live bytes and flag the original;
      // the earlier snapshot still holds the previous version.
      if (!preview) changed = { kind: 'checksum', expectedFrom: 'previous-backup', expectedSha256: reusable.sha256 };
      reusable = null;
    }
  }
  // If the live file is damaged, the earlier intact copy is carried forward so rotation never drops the last good version.
  if (reusable && previous) {
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
      if (await digest(sourcePath).then(() => true, () => false)) throw new Error(`Не удалось записать files/${path} в копию: ${code(error)}`);
      return { problem: problem({ kind: 'missing', error: code(error) === 'ENOENT' ? 'read' : code(error) }), copied: 0, linked: 0 };
    }
    await chmod(targetPath, 0o600);
    const copied = await regularFile(targetPath);
    const actualSha256 = await digest(targetPath);
    let found: (Partial<BackupProblem> & Pick<BackupProblem, 'kind'>) | null = null;
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

/** One cursor = one statement = one consistent MVCC snapshot of every table, even under READ COMMITTED.
 * (db.system() runs set_config before our code, so SET TRANSACTION ISOLATION LEVEL is no longer allowed there.) */
function snapshotQuery(family: string | undefined) {
  if (family !== undefined && !UUID.test(family)) throw new Error('Укажите идентификатор семьи (UUID).');
  const only = family ? `'${family}'::uuid` : null; // Validated above; DECLARE takes no bind parameters.
  return BACKUP_TABLES.map(table => {
    const familyColumn = table === 'families' ? 'id::text' : FAMILY_SCOPED.has(table) ? 'family_id::text' : 'NULL::text';
    const userColumn = table === 'memberships' ? 'user_id' : 'NULL::text';
    const where = !only ? '' : table === 'families' ? `WHERE id = ${only}` : table === 'users' ? `WHERE id IN (SELECT user_id FROM memberships WHERE family_id = ${only})` : `WHERE family_id = ${only}`;
    return `(SELECT '${table}'::text AS t, id::text AS id, ${familyColumn} AS family_id, ${userColumn} AS user_id, data::text AS data FROM ${table} ${where} ORDER BY seq)`;
  }).join('\nUNION ALL\n');
}

interface DumpResult { database: ManifestEntry & { rows: number }; references: References; counts: Partial<Record<Table, number>>; families: Record<string, FamilySummary>; schemaVersion: number }

async function dumpDatabase(db: Database, path: string, family: string | undefined, signal?: AbortSignal): Promise<DumpResult> {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const hash = createHash('sha256');
  let size = 0;
  const write = async (text: string) => {
    hash.update(text); size += Buffer.byteLength(text);
    if (!output.write(text)) await once(output, 'drain');
  };
  const references = new References();
  const counts: Partial<Record<Table, number>> = {};
  const families: Record<string, FamilySummary> = {};
  let rows = 0, schemaVersion = 0;
  try {
    await db.system(async store => {
      schemaVersion = Number((await store.raw('SELECT coalesce(max(version), 0) AS v FROM schema_migrations'))[0].v);
      if (family && !(await store.raw('SELECT 1 FROM families WHERE id = $1', [family])).length) throw new Error('Семья с таким идентификатором не найдена.');
      await store.raw(`DECLARE family_backup NO SCROLL CURSOR FOR ${snapshotQuery(family)}`);
      for (;;) {
        signal?.throwIfAborted();
        const batch = await store.raw('FETCH 500 FROM family_backup');
        if (!batch.length) break;
        for (const row of batch) {
          const table = row.t as Table, id = String(row.id), familyId = row.family_id as string | null, data = String(row.data);
          let line = `{"table":"${table}","id":${JSON.stringify(id)}`;
          if (familyId) line += `,"familyId":"${familyId}"`;
          if (row.user_id) line += `,"userId":${JSON.stringify(row.user_id)}`;
          await write(`${line},"data":${data}}\n`);
          rows++;
          counts[table] = (counts[table] ?? 0) + 1;
          if (table === 'families') {
            let name = '';
            try { name = String(JSON.parse(data)?.name ?? ''); } catch { /* reported by restore if broken */ }
            families[id] = { name, rows: {}, files: 0, bytes: 0 };
          } else if (familyId && families[familyId]) families[familyId].rows[table] = (families[familyId].rows[table] ?? 0) + 1;
          if (table === 'files' && familyId) {
            let record: unknown = null;
            try { record = JSON.parse(data); } catch { /* reported as an invalid record */ }
            references.add(familyId, id, record);
          }
        }
      }
      await store.raw('CLOSE family_backup');
    });
    output.end();
    await once(output, 'finish');
  } finally { output.destroy(); }
  await syncPath(path);
  return { database: { path: DATABASE_FILE, size, sha256: hash.digest('hex'), rows }, references, counts, families, schemaVersion };
}

async function snapshot(options: BackupOptions): Promise<BackupResult> {
  const { db, dataDir, destination, linkDest, signal, family } = options;
  signal?.throwIfAborted();
  let source: string;
  try { source = await realpath(resolve(dataDir)); } catch { throw new Error('Каталог DATA_DIR не найден.'); }
  if (!outside(source, resolve(destination))) throw new Error('Сохраняйте копию вне активного DATA_DIR.');
  const sourceFiles = await lstat(join(source, 'files')).catch(() => null);
  if (sourceFiles && (!sourceFiles.isDirectory() || sourceFiles.isSymbolicLink())) throw new Error('Некорректный каталог исходных файлов.');
  const previous = linkDest ? await loadPrevious(linkDest) : null;
  await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  // Re-check through the real parent so a symlinked parent cannot place the copy inside DATA_DIR.
  const target = join(await realpath(dirname(resolve(destination))), basename(resolve(destination)));
  if (!outside(source, target)) throw new Error('Сохраняйте копию вне активного DATA_DIR.');
  try { await mkdir(target, { mode: 0o700 }); } // Existing destinations are never overwritten.
  catch (error) { throw new Error(code(error) === 'EEXIST' ? 'Каталог копии уже существует; укажите новое имя.' : `Не удалось создать каталог копии: ${code(error)}`); }
  let complete = false;
  try {
    await writeFile(join(target, IN_PROGRESS_MARKER), '', { flag: 'wx', mode: 0o600 });
    await mkdir(join(target, 'files'), { mode: 0o700 });
    const dump = await dumpDatabase(db, join(target, DATABASE_FILE), family, signal);
    let bytesCopied = dump.database.size, bytesLinked = 0;
    const files: ManifestEntry[] = [];
    const problems = dump.references.problems();
    const directories = new Set<string>();
    for (const reference of dump.references.files.values()) {
      signal?.throwIfAborted();
      if (!directories.has(reference.familyId)) { await mkdir(join(target, 'files', reference.familyId), { mode: 0o700 }); directories.add(reference.familyId); }
      const outcome = await backupFile(source, target, reference, previous);
      if (outcome.entry) {
        files.push(outcome.entry);
        const summary = dump.families[reference.familyId];
        if (summary) { summary.files++; summary.bytes += outcome.entry.size; }
      }
      if (outcome.problem) problems.push(outcome.problem);
      bytesCopied += outcome.copied;
      bytesLinked += outcome.linked;
    }
    signal?.throwIfAborted();
    for (const directory of directories) await syncPath(join(target, 'files', directory));
    await syncPath(join(target, 'files'));
    const manifest: BackupManifest = {
      format: 'family-space-backup', version: 3, createdAt: new Date().toISOString(), engine: db.kind, schemaVersion: dump.schemaVersion, family: family ?? null,
      database: dump.database, counts: dump.counts, families: dump.families, excluded: [...EXCLUDED_TABLES], files, problems,
    };
    // Presence of this file marks a completed snapshot; no .env, API keys or login sessions are copied.
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await syncPath(join(target, 'manifest.json'));
    await rm(join(target, IN_PROGRESS_MARKER), { force: true });
    await syncPath(target);
    complete = true;
    return { destination: target, files: files.length, families: Object.keys(dump.families).length, rows: dump.database.rows, problems, bytesCopied, bytesLinked };
  } finally {
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

const STATUS_DEFAULTS: BackupStatusFile = { lastAttemptAt: null, lastSuccessAt: null, lastResult: null, lastError: null, lastDestination: null, problemFiles: 0, files: 0, bytesCopied: 0, bytesLinked: 0 };

/** Merges into DATA_DIR/backup-status.json atomically. Never throws: the status file is advisory. */
export async function recordBackupStatus(dataDirectory: string, patch: Partial<BackupStatusFile>, warn: (message: string) => void = console.warn) {
  const directory = resolve(dataDirectory);
  const path = join(directory, STATUS_FILE);
  const temporary = join(directory, `.${STATUS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    let previous: unknown = {};
    try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* first attempt or unreadable */ }
    const known = previous && typeof previous === 'object' && !Array.isArray(previous)
      ? Object.fromEntries(Object.keys(STATUS_DEFAULTS).filter(key => key in previous).map(key => [key, (previous as Record<string, unknown>)[key]])) : {};
    await writeFile(temporary, `${JSON.stringify({ ...STATUS_DEFAULTS, ...known, ...patch }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    warn(`Не удалось обновить ${STATUS_FILE}: ${code(error)}`);
  }
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const { dataDir, signal, statusFile = true, warn = console.warn } = options;
  // A one-family export is a support operation, not the service backup: it never changes backup-status.json.
  const recordStatus = statusFile !== false && !options.family;
  const lastAttemptAt = new Date().toISOString();
  let result: BackupResult;
  try {
    result = await snapshot(options);
  } catch (error) {
    const lastError = signal?.aborted ? 'Резервное копирование прервано остановкой.' : error instanceof Error ? error.message : String(error);
    // Counts and destination keep describing the last completed backup.
    if (recordStatus) await recordBackupStatus(dataDir, { lastAttemptAt, lastResult: 'failed', lastError }, warn);
    throw error;
  }
  if (recordStatus) {
    const problemFiles = problemFileCount(result.problems);
    await recordBackupStatus(dataDir, {
      lastAttemptAt, lastSuccessAt: new Date().toISOString(), lastResult: problemFiles ? 'degraded' : 'ok',
      lastError: problemFiles ? `Копия создана с проблемами, файлов: ${problemFiles}. Подробности — в manifest.json копии и в выводе scripts/verify.mts.` : null,
      lastDestination: result.destination, problemFiles, files: result.files, bytesCopied: result.bytesCopied, bytesLinked: result.bytesLinked,
    }, warn);
  }
  return result;
}

/** Reads and validates manifest.json. v1/v2 (SQLite) manifests are accepted for verification, rotation and link-dest only. */
export async function readManifest(directory: string): Promise<BackupManifest> {
  const path = join(directory, 'manifest.json');
  const info = await regularFile(path).catch(() => { throw new Error('Нет manifest.json: копия не завершена или это не резервная копия.'); });
  if (info.size > 64_000_000) throw new Error('Манифест резервной копии слишком большой.');
  let manifest: BackupManifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('manifest.json повреждён.'); }
  const databasePath = manifest?.version === 3 ? DATABASE_FILE : 'family.sqlite';
  if (manifest?.format !== 'family-space-backup' || ![1, 2, 3].includes(manifest.version) || manifest.database?.path !== databasePath || !Array.isArray(manifest.files)) {
    throw new Error('Неизвестный формат резервной копии.');
  }
  if (manifest.version === 1 && manifest.problems !== undefined) throw new Error('Неизвестный формат резервной копии.');
  if (manifest.version === 3 && (manifest.family != null && !UUID.test(manifest.family) || !manifest.families || typeof manifest.families !== 'object' || !manifest.counts || typeof manifest.counts !== 'object')) {
    throw new Error('Неизвестный формат резервной копии.');
  }
  const problems = manifest.version === 1 ? [] : manifest.problems;
  if (!Array.isArray(problems)) throw new Error('Неизвестный формат резервной копии.');
  const paths = new Set<string>();
  for (const [index, entry] of [manifest.database, ...manifest.files].entries()) {
    if (index) safeStoredPath(entry?.path, manifest.version);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256)) throw new Error('Некорректная запись в манифесте.');
    if (paths.has(entry.path)) throw new Error('Повторяющееся имя в манифесте.');
    paths.add(entry.path);
  }
  for (const problem of problems) {
    if (!problem || !PROBLEM_KINDS.has(problem.kind)) throw new Error('Некорректная запись о проблеме в манифесте.');
    if (problem.path !== null || problem.kind !== 'invalid') safeStoredPath(problem.path, manifest.version);
    const stored = paths.has(problem.path as string);
    if ((problem.kind === 'missing' && !problem.recovered && stored) || ((problem.recovered || problem.kind === 'size' || problem.kind === 'checksum') && !stored)) {
      throw new Error('Запись о проблеме противоречит списку файлов манифеста.');
    }
  }
  return { ...manifest, problems };
}

export interface DatabaseTarget { url?: string; dataDir: string; appStopped?: boolean; create?: boolean }
/** DATABASE_URL selects PostgreSQL; otherwise the embedded PGlite database in DATA_DIR/pglite, which only one process may open. */
export async function openDatabase({ url, dataDir, appStopped, create }: DatabaseTarget): Promise<Database> {
  if (url) return Database.open({ url });
  if (!appStopped) throw new Error('Встроенную базу PGlite (DATA_DIR/pglite) нельзя открывать при работающем приложении. Остановите его и добавьте --app-stopped или укажите --database-url.');
  if (!create) await lstat(join(resolve(dataDir), 'pglite')).catch(() => { throw new Error(`В ${dataDir} нет базы pglite; для PostgreSQL укажите --database-url.`); });
  return Database.open({ directory: resolve(dataDir) });
}

export const isMain = (url: string) => Boolean(process.argv[1]) && url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'database-url': { type: 'string' }, out: { type: 'string' }, 'link-dest': { type: 'string' }, family: { type: 'string' }, 'app-stopped': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('tsx scripts/backup.mts [--database-url postgres://…] [--data-dir ./data] --out /private/backups/new-copy [--link-dest /private/backups/previous-copy] [--family <uuid>] [--app-stopped]\nБез DATABASE_URL используется PGlite в DATA_DIR/pglite (только при остановленном приложении).\nКоды выхода: 0 — копия чистая, 2 — копия создана с проблемами, 1 — копия не создана.');
    else {
      if (!values.out) throw new Error('Укажите новый каталог копии: --out /private/backups/new-copy');
      process.umask(0o077);
      const dataDir = values['data-dir'] || process.env.DATA_DIR || './data';
      const db = await openDatabase({ url: values['database-url'] || process.env.DATABASE_URL, dataDir, appStopped: values['app-stopped'] });
      let result: BackupResult;
      try { result = await createBackup({ db, dataDir, destination: values.out, linkDest: values['link-dest'], family: values.family }); } finally { await db.close(); }
      const sizes = `скопировано ${formatBytes(result.bytesCopied)}${result.bytesLinked ? `, связано с прежней копией ${formatBytes(result.bytesLinked)}` : ''}`;
      if (!result.problems.length) console.log(`Копия создана: ${result.destination}. Семей: ${result.families}; записей: ${result.rows}; файлов: ${result.files}; ${sizes}.`);
      else {
        console.error(`ВНИМАНИЕ: копия создана (${result.destination}), но файлов с проблемами: ${problemFileCount(result.problems)}.`);
        for (const problem of result.problems) console.error(`  - ${describeProblem(problem)}`);
        console.error(`Семей: ${result.families}; записей: ${result.rows}; файлов в копии: ${result.files}; ${sizes}. Проверьте DATA_DIR: tsx scripts/verify.mts … и сохраните прежние копии, пока проблема не решена.`);
        process.exitCode = 2;
      }
    }
  } catch (error) { console.error(`Резервная копия не создана: ${(error as Error).message}`); process.exitCode = 1; }
}
