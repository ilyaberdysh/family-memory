import 'dotenv/config';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const production = process.env.NODE_ENV === 'production';
if (production && process.env.DEV_AUTH === '1') throw new Error('DEV_AUTH запрещён в production. Настройте вход через Telegram.');
if (production && !process.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('В production задайте PUBLIC_ORIGIN с HTTPS.');

/**
 * A forgotten or misspelled persistent volume leaves DATA_DIR on the container's writable layer:
 * everything works until the next redeploy silently erases it. Refuse to start instead.
 */
function assertPersistentDataDirectory(directory: string) {
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  if (!production || !inContainer || process.env.ALLOW_EPHEMERAL_DATA === '1') return;
  let existing = resolve(directory);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (statSync(existing).dev === statSync('/').dev) {
    throw new Error(`DATA_DIR (${directory}) находится во временной файловой системе контейнера: данные пропадут при следующем деплое. Подключите постоянный том к /var/lib/family-space (см. DEPLOYMENT.md).`);
  }
}
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
assertPersistentDataDirectory(dataDir);
const newDatabase = !process.env.DATABASE_URL && !existsSync(join(dataDir, 'pglite'));
if (newDatabase && existsSync(join(dataDir, 'family.sqlite')) && !process.env.DATABASE_URL) console.warn('Найдена прежняя база family.sqlite: перенесите её командой scripts/import-sqlite (см. DEPLOYMENT.md).');
const runtime = await createApp({ bindHost: host, production });
{
  const counts = await runtime.db.system(g => g.raw('SELECT (SELECT count(*) FROM families) AS families, (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM people) AS people, (SELECT count(*) FROM materials) AS materials, (SELECT count(*) FROM files) AS files'));
  const n = counts[0];
  // Visible in deploy logs: an unexpectedly empty archive is noticed at the first start, not months later.
  console.log(`Данные: ${runtime.db.kind === 'postgres' ? 'PostgreSQL' : resolve(dataDir, 'pglite')}; файлы: ${resolve(dataDir, 'files')}. Семей: ${n.families}, аккаунтов: ${n.users}, людей: ${n.people}, материалов: ${n.materials}, файлов: ${n.files}.`);
}
if (production) {
  runtime.app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    });
    next();
  });
  runtime.app.use(express.static(join(process.cwd(), 'dist')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(join(process.cwd(), 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  runtime.app.use(vite.middlewares);
}
const server = runtime.app.listen(port, host, () => console.log(`Family Space: http://${host}:${port}${process.env.DEV_AUTH === '1' ? ' (локальный просмотр)' : ''}`));
// Large uploads from phones can take long; the proxy in front must allow the same (see DEPLOYMENT.md).
server.requestTimeout = Math.max(60, Number(process.env.REQUEST_TIMEOUT_SECONDS) || 3600) * 1000;
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  // Let uploads and saves in flight finish before closing the database; new connections are refused meanwhile.
  const drained = new Promise<void>(done => server.close(() => done()));
  server.closeIdleConnections();
  const timeout = Math.max(0, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 50000);
  await Promise.race([drained, new Promise(done => setTimeout(done, timeout).unref())]);
  server.closeAllConnections();
  await runtime.close();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
