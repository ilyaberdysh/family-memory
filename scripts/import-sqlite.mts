// Moves a legacy single-family DATA_DIR (family.sqlite + files/) into the multi-family database as ONE new family.
// The source is opened read-only and never modified. Also accepts a v1/v2 backup snapshot directory as --from.
// Run: node_modules/.bin/tsx scripts/import-sqlite.mts --from /old/data --database-url postgres://… --files-to /var/lib/family-space/data --family-name "…" --app-stopped
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { FAMILY_TABLES, type Database, type FamilyTable } from '../server/db.js';
import { UUID, describeProblem, formatBytes, isMain, openDatabase, outside, regularFile, safeFilename, syncPath, type BackupProblem } from './backup.mts';
import { placeFamilyDirectories, RowWriter, settleInterrupted } from './restore.mts';

const LEGACY_TABLES = ['users', 'invitations', 'invitation_links', 'people', 'facts', 'relations', 'files', 'materials', 'history', 'sessions', 'codes', 'auth_flows', 'jobs', 'conversations'] as const;
type Json = Record<string, unknown>;
const IDENTITY = ['name', 'nameParts', 'phone', 'phoneVerified', 'telegramId', 'telegramSubject', 'email', 'authProvider'] as const;

export interface ImportOptions {
  /** Legacy DATA_DIR (or v1/v2 snapshot): family.sqlite and files/. */ from: string;
  db: Database;
  /** Target DATA_DIR: files go to DATA_DIR/files/<familyId>/. */ filesTo: string;
  familyName: string;
  /** Public surnames for invitations (FAMILY_SURNAMES of the old deployment). */ surnames?: string[];
  /** Copy what exists even when files are missing or damaged. */ allowProblems?: boolean;
  familyId?: string;
}
export interface ImportResult {
  familyId: string; rows: Partial<Record<string, number>>; users: { created: number; existing: number }; memberships: number; sessions: number;
  files: number; bytes: number; problems: BackupProblem[]; skipped: { codes: number; auth_flows: number; expiredSessions: number; unreferencedFiles: number };
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function readLegacy(path: string) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    if ((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') throw new Error('family.sqlite не прошёл проверку целостности.');
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    const tables = {} as Record<typeof LEGACY_TABLES[number], Json[]>;
    for (const table of LEGACY_TABLES) {
      tables[table] = present.has(table) ? (db.prepare(`SELECT id, data FROM ${table} ORDER BY rowid`).all() as { id: string; data: string }[]).map(row => {
        let value: unknown;
        try { value = JSON.parse(row.data); } catch { throw new Error(`family.sqlite: повреждённая запись ${table}/${row.id}.`); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Json).id !== row.id) throw new Error(`family.sqlite: некорректная запись ${table}/${row.id}.`);
        return value as Json;
      }) : [];
    }
    return tables;
  } finally { db.close(); }
}

export async function importSqlite(options: ImportOptions): Promise<ImportResult> {
  const { db, allowProblems = false } = options;
  const familyName = options.familyName?.trim();
  if (!familyName) throw new Error('Укажите название семьи: --family-name "…".');
  const source = await realpath(resolve(options.from)).catch(() => { throw new Error('Каталог --from не найден.'); });
  await regularFile(join(source, 'family.sqlite')).catch(() => { throw new Error('В --from нет обычного файла family.sqlite.'); });
  const legacy = readLegacy(join(source, 'family.sqlite'));
  const familyId = options.familyId ?? randomUUID();
  const target = resolve(options.filesTo);
  const filesRoot = join(target, 'files');
  if (target !== source && !outside(source, target)) throw new Error('Не размещайте DATA_DIR назначения внутри исходного каталога.');

  // Files: every referenced original and preview, checked against recorded size and hash before anything is written.
  const problems: BackupProblem[] = [];
  const planned = new Map<string, { name: string; size: number; sha256: string }>();
  const fileRows: Json[] = [];
  for (const record of legacy.files) {
    const row: Json = { ...record };
    fileRows.push(row);
    for (const [pathKey, sizeKey, hashKey, preview] of [['path', 'size', 'sha256', false], ['previewPath', 'previewSize', 'previewSha256', true]] as const) {
      const name = record[pathKey];
      if (name === undefined || name === null) continue;
      const flag = preview ? { preview: true as const } : {};
      try { safeFilename(name); } catch { problems.push({ path: null, kind: 'invalid', fileId: String(record.id), reason: 'name', ...flag }); continue; }
      const fileName = name as string;
      const expectedSize = Number.isSafeInteger(record[sizeKey]) ? record[sizeKey] as number : null;
      const expectedSha256 = typeof record[hashKey] === 'string' ? (record[hashKey] as string).toLowerCase() : null;
      const problem = (details: Partial<BackupProblem> & Pick<BackupProblem, 'kind'>) => problems.push({ path: fileName, fileId: String(record.id), ...details, expectedSize, ...(expectedSha256 ? { expectedSha256 } : {}), ...flag });
      const known = planned.get(fileName);
      if (known) { if (!expectedSha256) row[hashKey] = known.sha256; continue; }
      let size: number;
      try { size = (await regularFile(join(source, 'files', fileName))).size; }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; problem({ kind: 'missing', ...(code && code !== 'ENOENT' ? { error: code } : {}) }); continue; }
      const actualSha256 = await sha256(join(source, 'files', fileName));
      if (expectedSize !== null && size !== expectedSize) problem({ kind: 'size', actualSize: size, actualSha256 });
      else if (expectedSha256 && actualSha256 !== expectedSha256) problem({ kind: 'checksum', actualSize: size, actualSha256 });
      // Rows written before checksums existed receive the hash of the bytes moved now, so later backups can verify them.
      else if (!expectedSha256) row[hashKey] = actualSha256;
      planned.set(fileName, { name: fileName, size, sha256: actualSha256 });
    }
  }
  if (problems.length && !allowProblems) {
    const listed = problems.slice(0, 5).map(describeProblem).join('; ');
    throw new Error(`В исходном каталоге есть проблемы с файлами (${problems.length}): ${listed}${problems.length > 5 ? '; …' : ''}. Проверьте их или добавьте --allow-problems, чтобы перенести то, что есть.`);
  }
  let unreferencedFiles = 0;
  try {
    for (const name of await readdir(join(source, 'files'))) if (!name.startsWith('.') && !UUID.test(name) && !planned.has(name)) unreferencedFiles++;
  } catch { /* no files directory */ }

  const now = new Date().toISOString();
  const users = legacy.users;
  const admins = users.filter(user => user.role === 'admin');
  const createdBy = String((admins.find(user => (user.status ?? 'active') === 'active') ?? admins[0] ?? users[0])?.id ?? '') || null;
  const surnames = (options.surnames ?? []).map(name => name.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 5);
  const familyRow = { id: familyId, name: familyName, surnames, createdAt: now, createdBy };
  const sessions = legacy.sessions.filter(session => typeof session.userId === 'string' && !(typeof session.expires === 'number' && session.expires <= Date.now()));
  const familyRows = {} as Record<FamilyTable, Json[]>;
  for (const table of FAMILY_TABLES) familyRows[table] = table === 'files' ? fileRows : legacy[table];

  // Refuse before writing: the same family must not be imported twice, and no existing record may be overwritten.
  await db.system(async store => {
    if ((await store.raw('SELECT 1 FROM families WHERE id = $1', [familyId])).length) throw new Error('Семья с таким идентификатором уже есть в базе.');
    for (const table of FAMILY_TABLES) {
      const ids = familyRows[table].map(row => String(row.id));
      if (ids.length && (await store.raw(`SELECT 1 FROM ${table} WHERE id = ANY($1::text[]) LIMIT 1`, [ids])).length) throw new Error('Эта семья уже перенесена: её записи есть в базе. Повторный перенос не выполняется.');
    }
    const links = legacy.invitation_links.map(row => String(row.id));
    if (links.length && (await store.raw('SELECT 1 FROM invitation_links WHERE id = ANY($1::text[]) LIMIT 1', [links])).length) throw new Error('Эта семья уже перенесена: её гостевые ссылки есть в базе.');
  });
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });

  process.umask(0o077);
  const staging = join(filesRoot, `.import-${randomBytes(6).toString('hex')}`);
  const moved: string[] = [];
  let committed = false, bytes = 0;
  try {
    await mkdir(join(staging, familyId), { recursive: true, mode: 0o700 });
    for (const file of planned.values()) {
      const targetPath = join(staging, familyId, file.name);
      await copyFile(join(source, 'files', file.name), targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(targetPath, 0o600);
      if ((await regularFile(targetPath)).size !== file.size || await sha256(targetPath) !== file.sha256) throw new Error(`Проверка скопированного файла ${file.name} не прошла.`);
      await syncPath(targetPath);
      bytes += file.size;
    }
    const outcome = await db.system(async store => {
      const writer = new RowWriter(store);
      await writer.add('families', { id: familyId, familyId, data: familyRow });
      for (const user of users) {
        const profileComplete = user.status !== 'profile' && typeof user.name === 'string' && user.name.trim() !== '';
        const identity = Object.fromEntries(IDENTITY.filter(key => user[key] !== undefined).map(key => [key, user[key]]));
        await writer.add('users', { id: String(user.id), data: { id: user.id, ...identity, status: profileComplete ? 'active' : 'profile' } });
      }
      await writer.flush();
      const created = writer.inserted.users ?? 0;
      for (const user of users) {
        const membership = { id: randomUUID(), familyId, userId: String(user.id), role: user.role ?? 'member', // Legacy 'profile' meant "signed in, profile unfinished": guests were preapproved, others still awaited approval.
          status: user.status === 'profile' ? (user.authProvider === 'guest' ? 'active' : 'pending') : user.status ?? 'active', personId: user.personId ?? null, createdAt: typeof user.createdAt === 'string' ? user.createdAt : now };
        await writer.add('memberships', { id: membership.id, familyId, userId: membership.userId, data: membership });
      }
      // Login codes and unfinished Telegram handshakes are short-lived and dropped; sessions and guest links keep working.
      for (const session of sessions) await writer.add('sessions', { id: String(session.id), userId: String(session.userId), data: session });
      for (const link of legacy.invitation_links) await writer.add('invitation_links', { id: String(link.id), familyId, data: { ...link, familyId } });
      for (const table of FAMILY_TABLES) for (const row of familyRows[table]) await writer.add(table, { id: String(row.id), familyId, data: settleInterrupted(table, row, 'import') });
      await writer.flush();
      await placeFamilyDirectories(staging, filesRoot, [familyId], moved);
      return { created, rows: writer.inserted };
    });
    committed = true;
    const rows = Object.fromEntries(FAMILY_TABLES.map(table => [table, outcome.rows[table] ?? 0]));
    return {
      familyId, rows: { ...rows, invitation_links: outcome.rows.invitation_links ?? 0 }, users: { created: outcome.created, existing: users.length - outcome.created },
      memberships: outcome.rows.memberships ?? 0, sessions: outcome.rows.sessions ?? 0, files: planned.size, bytes, problems,
      skipped: { codes: legacy.codes.length, auth_flows: legacy.auth_flows.length, expiredSessions: legacy.sessions.length - sessions.length, unreferencedFiles },
    };
  } finally {
    if (!committed) for (const path of moved) await rm(path, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { from: { type: 'string' }, 'database-url': { type: 'string' }, 'data-dir': { type: 'string' }, 'files-to': { type: 'string' }, 'family-name': { type: 'string' }, surnames: { type: 'string' }, 'app-stopped': { type: 'boolean' }, 'allow-problems': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('tsx scripts/import-sqlite.mts --from /old/data (--database-url postgres://… | --data-dir DATA_DIR) [--files-to DATA_DIR] --family-name "…" [--surnames "Фамилия1,Фамилия2"] --app-stopped [--allow-problems]\nСтарое приложение должно быть остановлено. Исходный каталог не изменяется.');
    else {
      if (!values.from) throw new Error('Укажите --from <старый DATA_DIR>.');
      if (!values['app-stopped']) throw new Error('Остановите старое приложение (и новое, если используется PGlite), затем укажите --app-stopped.');
      const url = values['database-url'] || process.env.DATABASE_URL;
      if (!url && !values['data-dir']) throw new Error('Укажите --database-url (PostgreSQL) или --data-dir (PGlite).');
      const filesTo = values['files-to'] || values['data-dir'] || process.env.DATA_DIR;
      if (!filesTo) throw new Error('Укажите --files-to <DATA_DIR> для файлов.');
      const db = await openDatabase({ url, dataDir: values['data-dir'] ?? filesTo, appStopped: true, create: true });
      let result: ImportResult;
      try {
        result = await importSqlite({ from: values.from, db, filesTo, familyName: values['family-name'] ?? '', surnames: (values.surnames ?? process.env.FAMILY_SURNAMES ?? '').split(','), allowProblems: values['allow-problems'] });
      } finally { await db.close(); }
      console.log(`Семья перенесена: ${result.familyId}.`);
      console.log(`Записи: ${Object.entries(result.rows).map(([table, count]) => `${table} ${count}`).join(', ')}.`);
      console.log(`Аккаунтов создано: ${result.users.created}, уже было в базе: ${result.users.existing}; участников семьи: ${result.memberships}; сессий сохранено: ${result.sessions}.`);
      console.log(`Файлов скопировано: ${result.files} (${formatBytes(result.bytes)}) в files/${result.familyId}/.`);
      console.log(`Не перенесено: кодов входа ${result.skipped.codes}, незавершённых входов ${result.skipped.auth_flows}, истёкших сессий ${result.skipped.expiredSessions}; файлов без записи в базе (остались в источнике): ${result.skipped.unreferencedFiles}.`);
      if (result.problems.length) {
        console.error(`ВНИМАНИЕ: перенесено с проблемами (${result.problems.length}):`);
        for (const problem of result.problems) console.error(`  - ${describeProblem(problem)}`);
        process.exitCode = 2;
      }
    }
  } catch (error) { console.error(`Перенос не выполнен: ${(error as Error).message}`); process.exitCode = 1; }
}
