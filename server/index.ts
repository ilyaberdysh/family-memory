import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type { UIMessage } from 'ai';
import { streamAgentReply } from './agent.js';
import { resolveModel } from './model.js';

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT ?? 4310);
const production = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ model: resolveModel().status });
});

app.post('/api/chat', async (request, response) => {
  const messages = request.body?.messages as UIMessage[] | undefined;
  if (!Array.isArray(messages)) {
    response.status(400).json({ error: 'Нужен список сообщений.' });
    return;
  }
  await streamAgentReply(messages, response);
});

if (production) {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Корни: http://localhost:${port}`);
});
