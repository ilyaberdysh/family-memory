import 'dotenv/config';
import { join } from 'node:path';
import express from 'express';
import { createApp } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const production = process.env.NODE_ENV === 'production';
if (production && process.env.DEV_AUTH === '1') throw new Error('DEV_AUTH запрещён в production. Настройте вход через Telegram.');
if (production && !process.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('В production задайте PUBLIC_ORIGIN с HTTPS.');
const runtime = createApp({ bindHost: host, production });
if (production) {
  runtime.app.use(express.static(join(process.cwd(), 'dist')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(join(process.cwd(), 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  runtime.app.use(vite.middlewares);
}
const server = runtime.app.listen(port, host, () => console.log(`Family Space: http://${host}:${port}${process.env.DEV_AUTH === '1' ? ' (локальный просмотр)' : ''}`));
async function shutdown() { server.close(); await runtime.close(); process.exit(0); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
