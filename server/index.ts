import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type { UIMessage } from 'ai';
import { streamAgentReply } from './agent.js';
import { resolveModel } from './model.js';
import { auditEvidence, backfillTreeEvidence, getResearchCase, reconcileResearchWithTree } from './research-store.js';
import { renderResearchReport } from './research-report.js';
import { deletePerson, getTree, resetTree, undo } from './tree-store.js';
import { withPersistenceTransaction } from './persistence-transaction.js';

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT ?? 4310);
const production = process.env.NODE_ENV === 'production';

backfillTreeEvidence(getTree());

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ model: resolveModel().status });
});

app.get('/api/tree', (_request, response) => {
  response.json(getTree());
});

app.get('/api/research', (_request, response) => {
  response.json(getResearchCase());
});

app.get('/api/research/audit', (_request, response) => {
  response.json(auditEvidence(getResearchCase(), getTree()));
});

app.get('/api/research/report', (request, response) => {
  const redactLivingPeople = request.query.redact !== 'false';
  response.type('text/markdown; charset=utf-8').send(renderResearchReport({ redactLivingPeople }));
});

app.post('/api/tree/undo', (_request, response) => {
  const tree = withPersistenceTransaction(() => {
    const next = undo();
    reconcileResearchWithTree(next);
    return next;
  });
  response.json(tree);
});

app.post('/api/tree/reset', (_request, response) => {
  const tree = withPersistenceTransaction(() => {
    const next = resetTree();
    reconcileResearchWithTree(next);
    return next;
  });
  response.json(tree);
});

app.delete('/api/tree/people/:id', (request, response) => {
  try {
    const tree = withPersistenceTransaction(() => {
      const next = deletePerson(request.params.id);
      reconcileResearchWithTree(next);
      return next;
    });
    response.json(tree);
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
