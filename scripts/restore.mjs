#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { checkDatabase, collectReferences, describeProblem, digest, readManifest, regularFile, unexplainedDifferences } from './backup.mjs';

/** Problems recorded at backup time that leave files missing or damaged in the copy (recovered ones were replaced by intact earlier versions). */
export const blockingProblems = manifest => manifest.problems.filter(problem => !problem.recovered);

export async function restoreBackup(backupDirectory, destination, appStopped, adminEmail, allowProblems = false) {
  if (!appStopped) throw new Error('Сначала остановите приложение, затем укажите --app-stopped.');
  const nextEmail = adminEmail?.trim().toLowerCase();
  if (adminEmail !== undefined && (!z.email().safeParse(nextEmail).success || nextEmail.endsWith('.invalid'))) throw new Error('Укажите настоящий email администратора.');
  process.umask(0o077);
  const source = await realpath(resolve(backupDirectory));
  const target = resolve(destination);
  const manifest = await readManifest(source);
  const problems = blockingProblems(manifest);
  if (problems.length && !allowProblems) {
    const listed = problems.slice(0, 5).map(problem => problem.path ? `files/${problem.path}` : `запись ${problem.fileId}`).join(', ');
    throw new Error(`Копия создана с проблемами (${problems.length}: ${listed}${problems.length > 5 ? ', …' : ''}). Добавьте --allow-problems, чтобы восстановить всё, что в ней сохранилось.`);
  }
  const folder = await lstat(join(source, 'files'));
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Некорректный каталог файлов копии.');
  const entries = [{ ...manifest.database, relativePath: 'family.sqlite' }, ...manifest.files.map(entry => ({ ...entry, relativePath: join('files', entry.path) }))];
  // Validate all content before creating the destination.
  for (const entry of entries) {
    const path = join(source, entry.relativePath);
    const info = await regularFile(path).catch(() => { throw new Error(`В копии нет ${entry.relativePath}. Восстановление отменено.`); });
    if (info.size !== entry.size || await digest(path) !== entry.sha256) throw new Error(`Контрольная сумма или размер ${entry.relativePath} не совпадает. Восстановление отменено.`);
  }
  const snapshot = new DatabaseSync(join(source, 'family.sqlite'), { readOnly: true });
  let localAdminId;
  try {
    checkDatabase(snapshot);
    // Every difference between the database and the copied files must be a problem recorded at backup time.
    const differences = unexplainedDifferences(collectReferences(snapshot), manifest);
    if (differences.length) throw new Error(`Набор файлов не соответствует снимку базы данных: ${differences.slice(0, 5).join(', ')}${differences.length > 5 ? ', …' : ''}.`);
    if (nextEmail) {
      const accounts = snapshot.prepare('SELECT id, data FROM users').all().map(row => JSON.parse(row.data));
      const local = accounts.filter(user => user.email === 'admin@local.invalid' && user.role === 'admin');
      if (local.length !== 1) throw new Error('В копии нет единственного администратора локального просмотра. Email не изменён.');
      if (accounts.some(user => user.email?.toLowerCase() === nextEmail)) throw new Error('Этот email уже занят другим аккаунтом.');
      localAdminId = local[0].id;
    }
  } finally { snapshot.close(); }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // No overwrite flag: the active database must remain untouched, even if the operator made a typo.
  await mkdir(target, { mode: 0o700 });
  let complete = false;
  try {
    await mkdir(join(target, 'files'), { mode: 0o700 });
    for (const entry of entries) {
      const targetPath = join(target, entry.relativePath);
      await copyFile(join(source, entry.relativePath), targetPath, constants.COPYFILE_EXCL);
      await chmod(targetPath, 0o600);
      if ((await regularFile(targetPath)).size !== entry.size || await digest(targetPath) !== entry.sha256) throw new Error('Проверка восстановленного файла не прошла.');
    }
    const restored = new DatabaseSync(join(target, 'family.sqlite'));
    try {
      checkDatabase(restored);
      // Old login codes/sessions and interrupted jobs must not regain authority or spend API quota.
      restored.exec(`
        BEGIN;
        DELETE FROM sessions;
        DELETE FROM codes;
        UPDATE jobs SET data=json_set(data,
          '$.status','error',
          '$.error','Задание прервано восстановлением. Запустите обработку вручную.')
          WHERE json_extract(data,'$.status') IN ('queued','processing');
        UPDATE materials SET data=json_set(data,
          '$.transcriptionStatus', CASE
            WHEN json_extract(data,'$.transcriptionStatus') IN ('queued','processing') THEN 'error'
            ELSE json_extract(data,'$.transcriptionStatus') END,
          '$.extractionStatus', CASE
            WHEN json_extract(data,'$.extractionStatus') IN ('queued','processing') THEN 'error'
            ELSE json_extract(data,'$.extractionStatus') END,
          '$.processingError','Обработка прервана восстановлением. Запустите её вручную.')
          WHERE json_extract(data,'$.transcriptionStatus') IN ('queued','processing')
            OR json_extract(data,'$.extractionStatus') IN ('queued','processing');
        COMMIT;
      `);
      // Change only the login address in the new copy; all authorship keeps its existing user ID.
      if (localAdminId) restored.prepare("UPDATE users SET data=json_set(data,'$.email',?) WHERE id=?").run(nextEmail, localAdminId);
      // Restored OAuth handshakes and guest links must not become valid login credentials again.
      if (restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_flows'").get()) restored.exec('DELETE FROM auth_flows');
      if (restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invitation_links'").get()) {
        restored.prepare("UPDATE invitation_links SET data=json_set(data,'$.revokedAt',?) WHERE json_extract(data,'$.revokedAt') IS NULL").run(new Date().toISOString());
      }
      if (restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get()) {
        const interrupted = restored.prepare("SELECT id,data FROM conversations WHERE json_extract(data,'$.status') IN ('responding','transcribing','preparing')").all();
        const update = restored.prepare('UPDATE conversations SET data=? WHERE id=?');
        for (const row of interrupted) {
          const conversation = JSON.parse(row.data);
          const messages = conversation.messages || [];
          const lastUser = messages.findLastIndex(message => message.role === 'user');
          update.run(JSON.stringify({ ...conversation, status: 'error', errorOperation: conversation.status,
            error: 'Разговор прерван восстановлением. Повторите обработку вручную.',
            messages: messages.map((message, index) => conversation.status === 'responding' && message.role === 'assistant' && index > lastUser ? { ...message, interrupted: true } : message),
          }), row.id);
        }
      }
    } finally { restored.close(); }
    complete = true;
    return { destination: target, files: manifest.files.length, problems, recovered: manifest.problems.filter(problem => problem.recovered) };
  } finally {
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, 'app-stopped': { type: 'boolean' }, 'admin-email': { type: 'string' }, 'allow-problems': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/restore.mjs --from /private/backups/copy --to /private/family-restored --app-stopped [--admin-email real@example.com] [--allow-problems]');
    else {
      if (!values.from || !values.to) throw new Error('Укажите --from и новый, ещё не существующий каталог --to.');
      const result = await restoreBackup(values.from, values.to, values['app-stopped'], values['admin-email'], values['allow-problems']);
      if (result.problems.length) {
        console.error(`ВНИМАНИЕ: восстановлено с проблемами, записанными при создании копии (${result.problems.length}):`);
        for (const problem of result.problems) console.error(`  - ${describeProblem(problem)}`);
        console.error('Эти файлы отсутствуют или повреждены в восстановленном каталоге. Поищите их целые версии в более ранних копиях.');
      }
      if (result.recovered.length) console.log(`Файлов, повреждённых в DATA_DIR на момент копии и восстановленных из прежних целых версий: ${result.recovered.length}.`);
      console.log(`Восстановлено: ${result.destination}. Файлов: ${result.files}. Укажите этот DATA_DIR перед запуском приложения. Потребуется повторный вход; незавершённую обработку запустите вручную.`);
    }
  } catch (error) { console.error(`Восстановление не выполнено: ${error.message}`); process.exitCode = 1; }
}
