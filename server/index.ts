import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type { UIMessage } from 'ai';
import { streamAgentReply } from './agent.js';
import { resolveModel } from './model.js';
import { deletePerson, getTree, resetTree, undo } from './tree-store.js';

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT ?? 4310);
const production = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ model: resolveModel().status });
});

app.get('/api/tree', (_request, response) => {
  response.json(getTree());
});

app.post('/api/tree/undo', (_request, response) => {
  response.json(undo());
});

app.post('/api/tree/reset', (_request, response) => {
  response.json(resetTree());
});

app.delete('/api/tree/people/:id', (request, response) => {
  try {
    response.json(deletePerson(request.params.id));
  } catch (error) {
    response.status(404).json({ error: (error as Error).message });
  }
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

// HOST=0.0.0.0 inside the container; loopback by default for the local stand.
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Корни: http://localhost:${port}`);
});
