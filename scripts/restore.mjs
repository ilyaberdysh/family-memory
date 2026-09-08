#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { checkDatabase, digest, readManifest, regularFile, snapshotFiles } from './backup.mjs';

export async function restoreBackup(backupDirectory, destination, appStopped, adminEmail) {
  if (!appStopped) throw new Error('Сначала остановите приложение, затем укажите --app-stopped.');
  const nextEmail = adminEmail?.trim().toLowerCase();
  if (adminEmail !== undefined && (!z.email().safeParse(nextEmail).success || nextEmail.endsWith('.invalid'))) throw new Error('Укажите настоящий email администратора.');
  process.umask(0o077);
  const source = await realpath(resolve(backupDirectory));
  const target = resolve(destination);
  const manifest = await readManifest(source);
  const folder = await lstat(join(source, 'files'));
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Некорректный каталог файлов копии.');
  const entries = [{ ...manifest.database, relativePath: 'family.sqlite' }, ...manifest.files.map(entry => ({ ...entry, relativePath: join('files', entry.path) }))];
  // Validate all content before creating the destination.
  for (const entry of entries) {
    const path = join(source, entry.relativePath);
    if ((await regularFile(path)).size !== entry.size || await digest(path) !== entry.sha256) throw new Error('Контрольная сумма или размер файла не совпадает. Восстановление отменено.');
  }
  const snapshot = new DatabaseSync(join(source, 'family.sqlite'), { readOnly: true });
  let localAdminId;
  try {
    checkDatabase(snapshot);
    const referenced = snapshotFiles(snapshot);
    if (referenced.size !== manifest.files.length || manifest.files.some(file => referenced.get(file.path) !== file.size)) {
      throw new Error('Набор файлов не соответствует снимку базы данных.');
    }
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
    return { destination: target, files: manifest.files.length };
  } finally {
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, 'app-stopped': { type: 'boolean' }, 'admin-email': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/restore.mjs --from /private/backups/copy --to /private/family-restored --app-stopped [--admin-email real@example.com]');
    else {
      if (!values.from || !values.to) throw new Error('Укажите --from и новый, ещё не существующий каталог --to.');
      const result = await restoreBackup(values.from, values.to, values['app-stopped'], values['admin-email']);
      console.log(`Восстановлено: ${result.destination}. Файлов: ${result.files}. Укажите этот DATA_DIR перед запуском приложения. Потребуется повторный вход; незавершённую обработку запустите вручную.`);
    }
  } catch (error) { console.error(`Восстановление не выполнено: ${error.message}`); process.exitCode = 1; }
}
