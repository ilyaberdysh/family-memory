// Restores a v3 snapshot into an empty database, or one family into a database that does not contain it yet.
// Run: node_modules/.bin/tsx scripts/restore.mts --from /private/backups/copy --to /var/lib/family-space/data --app-stopped
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Database, GlobalStore } from '../server/db.js';
import {
  BACKUP_TABLES, DATABASE_FILE, References, UUID, describeProblem, digest, isMain, openDatabase, outside, readManifest, readRows, regularFile, syncPath, unexplainedDifferences,
  type BackupManifest, type BackupProblem, type Table,
} from './backup.mts';

/** Problems recorded at backup time that leave files missing or damaged in the copy (recovered ones were replaced by intact earlier versions). */
export const blockingProblems = (manifest: BackupManifest, family?: string) => manifest.problems.filter(problem => !problem.recovered && (!family || problem.familyId === family || problem.path?.startsWith(`${family}/`)));

type Json = Record<string, unknown>;
const ACTIVE = new Set(['queued', 'processing']);
/** Interrupted background work must not resume silently (or spend API quota) after a restore or migration. */
export function settleInterrupted(table: string, data: Json, reason: 'restore' | 'import'): Json {
  const by = reason === 'restore' ? 'восстановлением' : 'переносом';
  if (table === 'jobs' && ACTIVE.has(data.status as string)) return { ...data, status: 'error', error: `Задание прервано ${by}. Запустите обработку вручную.` };
  if (table === 'materials' && (ACTIVE.has(data.transcriptionStatus as string) || ACTIVE.has(data.extractionStatus as string))) {
    return { ...data,
      transcriptionStatus: ACTIVE.has(data.transcriptionStatus as string) ? 'error' : data.transcriptionStatus,
      extractionStatus: ACTIVE.has(data.extractionStatus as string) ? 'error' : data.extractionStatus,
      processingError: `Обработка прервана ${by}. Запустите её вручную.` };
  }
  if (table === 'conversations' && ['responding', 'transcribing', 'preparing'].includes(data.status as string)) {
    const messages = Array.isArray(data.messages) ? data.messages as Json[] : [];
    let lastUser = -1;
    messages.forEach((message, index) => { if (message?.role === 'user') lastUser = index; });
    return { ...data, status: 'error', errorOperation: data.status, error: `Разговор прерван ${by}. Повторите обработку вручную.`,
      messages: messages.map((message, index) => data.status === 'responding' && message?.role === 'assistant' && index > lastUser ? { ...message, interrupted: true } : message) };
  }
  // A browser copy that was being prepared is queued again; the preserved original is unaffected.
  if (table === 'files' && data.previewStatus === 'processing') return { ...data, previewStatus: 'pending' };
  return data;
}

type WritableTable = Table | 'sessions';
const INSERT: Record<WritableTable, string> = Object.fromEntries([...BACKUP_TABLES, 'sessions' as const].map(table => [table,
  table === 'sessions' ? "INSERT INTO sessions (id, user_id, data) SELECT r->>'id', r->>'userId', r->'data' FROM jsonb_array_elements($1::jsonb) r RETURNING id" :
  table === 'families' ? "INSERT INTO families (id, data) SELECT (r->>'id')::uuid, r->'data' FROM jsonb_array_elements($1::jsonb) r RETURNING id"
  : table === 'users' ? "INSERT INTO users (id, data) SELECT r->>'id', r->'data' FROM jsonb_array_elements($1::jsonb) r ON CONFLICT (id) DO NOTHING RETURNING id"
  : table === 'memberships' ? "INSERT INTO memberships (id, family_id, user_id, data) SELECT r->>'id', (r->>'familyId')::uuid, r->>'userId', r->'data' FROM jsonb_array_elements($1::jsonb) r RETURNING id"
  : `INSERT INTO ${table} (id, family_id, data) SELECT r->>'id', (r->>'familyId')::uuid, r->'data' FROM jsonb_array_elements($1::jsonb) r RETURNING id`])) as Record<WritableTable, string>;

/** Batched inserts; returns how many rows each table actually received (users that already exist are kept as they are). */
export class RowWriter {
  private table: WritableTable | null = null;
  private batch: string[] = [];
  private bytes = 0;
  readonly inserted: Partial<Record<WritableTable, number>> = {};
  constructor(private readonly store: GlobalStore) {}
  async add(table: WritableTable, row: { id: string; familyId?: string; userId?: string; data: unknown }) {
    if (table !== this.table || this.batch.length >= 200 || this.bytes > 4_000_000) await this.flush();
    this.table = table;
    const text = JSON.stringify(row);
    this.batch.push(text); this.bytes += text.length;
  }
  async flush() {
    if (!this.table || !this.batch.length) return;
    const table = this.table, rows = `[${this.batch.join(',')}]`;
    this.batch = []; this.bytes = 0;
    try { this.inserted[table] = (this.inserted[table] ?? 0) + (await this.store.raw(INSERT[table], [rows])).length; }
    catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === '23505' || /duplicate key/.test(failure.message ?? '')) {
        throw new Error(table === 'users'
          ? 'Аккаунт с тем же Telegram или email уже есть в базе под другим идентификатором. Объединение аккаунтов не выполняется автоматически.'
          : `Запись таблицы ${table} уже есть в базе: эта семья, похоже, уже перенесена.`);
      }
      throw error;
    }
  }
}

/** Moves staged family directories into place; returns what was moved so a failed transaction can undo it. */
export async function placeFamilyDirectories(staging: string, filesRoot: string, families: string[], moved: string[]) {
  for (const family of families) {
    await rename(join(staging, family), join(filesRoot, family));
    moved.push(join(filesRoot, family));
  }
  await syncPath(filesRoot);
}

export interface RestoreOptions {
  /** A complete v3 snapshot. */ from: string;
  db: Database;
  /** Target DATA_DIR: files go to DATA_DIR/files/<familyId>/. */ dataDir: string;
  appStopped?: boolean;
  /** Restore only this family into a database that does not contain it yet; the service can keep running. */ family?: string;
  /** Replace the email of the single local-preview account (admin@local.invalid); its ID and authorship stay. */ adminEmail?: string;
  allowProblems?: boolean;
}
export interface RestoreResult { families: string[]; rows: number; files: number; users: { created: number; existing: number }; problems: BackupProblem[]; recovered: BackupProblem[] }

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { db, family, allowProblems = false } = options;
  if (!family && !options.appStopped) throw new Error('Сначала остановите приложение, затем укажите --app-stopped.');
  if (family !== undefined && !UUID.test(family)) throw new Error('Укажите идентификатор семьи (UUID).');
  const nextEmail = options.adminEmail?.trim().toLowerCase();
  if (options.adminEmail !== undefined && (!nextEmail || !z.email().safeParse(nextEmail).success || nextEmail.endsWith('.invalid'))) throw new Error('Укажите настоящий email администратора.');
  const source = await realpath(resolve(options.from)).catch(() => { throw new Error('Каталог копии не найден.'); });
  const manifest = await readManifest(source);
  if (manifest.version !== 3) throw new Error('Это копия старого формата (SQLite). Перенесите её в новую базу командой scripts/import-sqlite.mts --from <копия>.');
  if (family && manifest.family && manifest.family !== family) throw new Error('В этой копии другая семья.');
  if (family && !manifest.families?.[family]) throw new Error('В копии нет семьи с таким идентификатором.');
  const problems = blockingProblems(manifest, family);
  if (problems.length && !allowProblems) {
    const listed = problems.slice(0, 5).map(problem => problem.path ? `files/${problem.path}` : `запись ${problem.fileId}`).join(', ');
    throw new Error(`Копия создана с проблемами (${problems.length}: ${listed}${problems.length > 5 ? ', …' : ''}). Добавьте --allow-problems, чтобы восстановить всё, что в ней сохранилось.`);
  }
  const folder = await lstat(join(source, 'files')).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) throw new Error('Некорректный каталог файлов копии.');
  const selectedFiles = manifest.files.filter(entry => !family || entry.path.startsWith(`${family}/`));
  // Validate all content before touching the database or DATA_DIR.
  for (const entry of [manifest.database, ...selectedFiles]) {
    const relativePath = entry === manifest.database ? entry.path : join('files', entry.path);
    const info = await regularFile(join(source, relativePath)).catch(() => { throw new Error(`В копии нет ${relativePath}. Восстановление отменено.`); });
    if (info.size !== entry.size || await digest(join(source, relativePath)) !== entry.sha256) throw new Error(`Контрольная сумма или размер ${relativePath} не совпадает. Восстановление отменено.`);
  }

  // Pass 1: structure, order and the file set, without writing anything.
  const databasePath = join(source, DATABASE_FILE);
  const seenFamilies = new Set<string>();
  const counts: Partial<Record<Table, number>> = {};
  const neededUsers = new Set<string>();
  const references = new References();
  const localAdmins: string[] = [];
  const emails = new Map<string, string>();
  for await (const row of readRows(databasePath)) {
    counts[row.table] = (counts[row.table] ?? 0) + 1;
    if (row.table === 'families') {
      if (row.familyId !== row.id || seenFamilies.has(row.id)) throw new Error(`${DATABASE_FILE}: некорректная запись семьи.`);
      seenFamilies.add(row.id);
      continue;
    }
    if (row.familyId && !seenFamilies.has(row.familyId)) throw new Error(`${DATABASE_FILE}: запись ссылается на семью, которой нет выше в снимке.`);
    if (row.table === 'memberships' && (!family || row.familyId === family)) neededUsers.add(row.userId as string);
    if (row.table === 'files' && (!family || row.familyId === family)) references.add(row.familyId as string, row.id, row.data);
    if (row.table === 'users') {
      const email = typeof (row.data as Json)?.email === 'string' ? ((row.data as Json).email as string).toLowerCase() : '';
      if (email) emails.set(row.id, email);
      if (email === 'admin@local.invalid') localAdmins.push(row.id);
    }
  }
  for (const [table, count] of Object.entries(manifest.counts ?? {})) if ((counts[table as Table] ?? 0) !== count) throw new Error(`${DATABASE_FILE}: число записей ${table} не совпадает с манифестом.`);
  const families = family ? [family] : [...seenFamilies];
  if (family && !seenFamilies.has(family)) throw new Error('В копии нет семьи с таким идентификатором.');
  // Every difference between the database and the copied files must be a problem recorded at backup time.
  const scoped = { files: selectedFiles, problems: manifest.problems.filter(problem => !family || problem.familyId === family || problem.path?.startsWith(`${family}/`)) };
  const differences = unexplainedDifferences(references, scoped);
  if (differences.length) throw new Error(`Набор файлов не соответствует снимку базы данных: ${differences.slice(0, 5).join(', ')}${differences.length > 5 ? ', …' : ''}.`);
  const restoredUser = (id: string) => !family || neededUsers.has(id);
  let localAdminId: string | undefined;
  if (nextEmail) {
    const local = localAdmins.filter(restoredUser);
    if (local.length !== 1) throw new Error('В копии нет единственного аккаунта локального просмотра (admin@local.invalid). Email не изменён.');
    if ([...emails].some(([id, email]) => restoredUser(id) && email === nextEmail)) throw new Error('Этот email уже занят другим аккаунтом.');
    localAdminId = local[0];
  }

  // Target checks.
  const target = resolve(options.dataDir);
  if (!outside(source, target) || !outside(target, source)) throw new Error('Копия и DATA_DIR не должны быть вложены друг в друга.');
  await db.system(async store => {
    const schema = Number((await store.raw('SELECT coalesce(max(version), 0) AS v FROM schema_migrations'))[0].v);
    if ((manifest.schemaVersion ?? 0) > schema) throw new Error('Копия создана более новой версией приложения. Обновите приложение и повторите восстановление.');
    if (!family && (await store.raw('SELECT 1 FROM families LIMIT 1')).length) throw new Error('В базе уже есть семьи. Полное восстановление выполняется только в пустую базу; для одной семьи используйте --family.');
    if (family && (await store.raw('SELECT 1 FROM families WHERE id = $1', [family])).length) throw new Error('Эта семья уже есть в базе. Восстановление поверх существующих данных не выполняется.');
    if (nextEmail && (await store.raw("SELECT 1 FROM users WHERE lower(data->>'email') = $1", [nextEmail])).length) throw new Error('Этот email уже занят другим аккаунтом.');
  });
  const filesRoot = join(target, 'files');
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  for (const id of families) {
    const existing = await lstat(join(filesRoot, id)).catch(() => null);
    if (existing) throw new Error(`Каталог files/${id} уже существует в DATA_DIR. Восстановление не перезаписывает файлы.`);
  }

  process.umask(0o077);
  const staging = join(filesRoot, `.restore-${randomBytes(6).toString('hex')}`);
  const moved: string[] = [];
  let committed = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const id of families) await mkdir(join(staging, id), { mode: 0o700 });
    for (const entry of selectedFiles) {
      const targetPath = join(staging, entry.path);
      await copyFile(join(source, 'files', entry.path), targetPath, constants.COPYFILE_EXCL);
      await chmod(targetPath, 0o600);
      if ((await regularFile(targetPath)).size !== entry.size || await digest(targetPath) !== entry.sha256) throw new Error('Проверка восстановленного файла не прошла.');
      await syncPath(targetPath);
    }
    const now = new Date().toISOString();
    let rows = 0;
    const users = await db.system(async store => {
      // Pass 2: the same validated rows, now written in one transaction.
      const writer = new RowWriter(store);
      let wantedUsers = 0;
      for await (const row of readRows(databasePath)) {
        if (row.table === 'users' ? !restoredUser(row.id) : family && row.familyId !== family) continue;
        let data = row.data as Json;
        if (row.table === 'users') { wantedUsers++; if (row.id === localAdminId) data = { ...data, email: nextEmail }; }
        // Restored guest links must not become valid login credentials again.
        if (row.table === 'invitation_links' && !data.revokedAt) data = { ...data, revokedAt: now };
        data = settleInterrupted(row.table, data, 'restore');
        await writer.add(row.table, { id: row.id, familyId: row.familyId, userId: row.userId, data });
        rows++;
      }
      await writer.flush();
      await placeFamilyDirectories(staging, filesRoot, families, moved);
      return { created: writer.inserted.users ?? 0, existing: wantedUsers - (writer.inserted.users ?? 0) };
    });
    committed = true;
    return { families, rows, files: selectedFiles.length, users, problems, recovered: manifest.problems.filter(problem => problem.recovered && (!family || problem.path?.startsWith(`${family}/`))) };
  } finally {
    if (!committed) for (const path of moved) await rm(path, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, 'database-url': { type: 'string' }, 'data-dir': { type: 'string' }, family: { type: 'string' }, 'app-stopped': { type: 'boolean' }, 'admin-email': { type: 'string' }, 'allow-problems': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('tsx scripts/restore.mts --from /private/backups/copy (--database-url postgres://… | --data-dir DATA_DIR) [--to DATA_DIR] --app-stopped [--family <uuid>] [--admin-email real@example.com] [--allow-problems]\nПолное восстановление — только в пустую базу. --family восстанавливает одну семью в базу, где её ещё нет.\n--to — DATA_DIR, куда кладутся файлы (по умолчанию --data-dir или DATA_DIR).');
    else {
      if (!values.from) throw new Error('Укажите --from <каталог копии>.');
      const url = values['database-url'] || process.env.DATABASE_URL;
      const dataDir = values.to || values['data-dir'] || process.env.DATA_DIR;
      if (!dataDir) throw new Error('Укажите --to <DATA_DIR> для файлов.');
      if (!url && !values['data-dir']) throw new Error('Укажите --database-url (PostgreSQL) или --data-dir (PGlite).');
      const db = await openDatabase({ url, dataDir: values['data-dir'] ?? dataDir, appStopped: values['app-stopped'], create: true });
      let result: RestoreResult;
      try {
        result = await restoreBackup({ from: values.from, db, dataDir, appStopped: values['app-stopped'], family: values.family, adminEmail: values['admin-email'], allowProblems: values['allow-problems'] });
      } finally { await db.close(); }
      if (result.problems.length) {
        console.error(`ВНИМАНИЕ: восстановлено с проблемами, записанными при создании копии (${result.problems.length}):`);
        for (const problem of result.problems) console.error(`  - ${describeProblem(problem)}`);
        console.error('Эти файлы отсутствуют или повреждены. Поищите их целые версии в более ранних копиях.');
      }
      if (result.recovered.length) console.log(`Файлов, повреждённых в DATA_DIR на момент копии и восстановленных из прежних целых версий: ${result.recovered.length}.`);
      console.log(`Восстановлено семей: ${result.families.length} (${result.families.join(', ')}). Записей: ${result.rows}; файлов: ${result.files}; аккаунтов создано: ${result.users.created}, уже было: ${result.users.existing}.`);
      console.log('Потребуется повторный вход; гостевые ссылки отозваны; незавершённую обработку запустите вручную.');
    }
  } catch (error) { console.error(`Восстановление не выполнено: ${(error as Error).message}`); process.exitCode = 1; }
}
