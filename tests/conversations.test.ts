import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { ConversationAI } from '../server/conversations.js';
import { conversationUserText } from '../server/conversation-ai.js';
import type { Conversation, Fact, Material, Proposal } from '../shared/types.js';

const defaults: ConversationAI = {
  available: () => false,
  reply: async () => { throw new Error('Unexpected reply call in offline fixture'); },
  prepare: async () => { throw new Error('Unexpected preparation call in offline fixture'); },
  transcribe: async () => { throw new Error('Unexpected transcription call in offline fixture'); },
};

async function fixture(ai: Partial<ConversationAI> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-conversations-test-'));
  let runtime!: ReturnType<typeof createApp>;
  let server!: Server;
  let base = '';
  const boot = async () => {
    runtime = createApp({ dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false, conversationAI: { ...defaults, ...ai } });
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  };
  await boot();
  const request = async (path: string, cookie = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const login = async (email: string) => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const account = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(account.status, 200, JSON.stringify(account.body));
    return account;
  };
  const admin = await login('admin@example.test');
  const waitIdle = async (id: string, cookie: string): Promise<Conversation> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/api/conversations/${id}`, cookie);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (['idle', 'error'].includes(result.body.status)) return result.body;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('The mocked operation did not finish');
  };
  // A fixture file isolates authorization/provenance from media conversion (covered in backend.test.ts).
  const audio = async (createdBy: string) => {
    const id = randomUUID();
    const bytes = Buffer.from('synthetic private recording bytes');
    await writeFile(join(runtime.store.filesDir, id), bytes);
    const file = { id, name: 'recording.wav', mime: 'audio/wav', size: bytes.length, path: id, createdBy, url: `/api/files/${id}` };
    runtime.store.put('files', file);
    return { file, bytes };
  };
  return { request, login, admin, waitIdle, audio, get store() { return runtime.store; }, get base() { return base; },
    restart: async () => { await stop(); await boot(); },
    cleanup: async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('private conversations enforce access and idempotency; missing-key notes/audio survive until explicit publication', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/conversations')).status, 401);
    for (const [email, role] of [['owner@example.test', 'member'], ['other@example.test', 'member'], ['viewer@example.test', 'viewer']]) {
      assert.equal((await f.request('/api/invitations', f.admin.cookie, { email, role })).status, 201);
    }
    const owner = await f.login('owner@example.test');
    const other = await f.login('other@example.test');
    const viewer = await f.login('viewer@example.test');
    assert.equal((await f.request('/api/conversations', viewer.cookie, {})).status, 403);
    const created = await f.request('/api/conversations', owner.cookie, {});
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await f.request(`/api/conversations/${id}`, other.cookie)).status, 404);
    assert.equal((await f.request(`/api/conversations/${id}`, f.admin.cookie)).status, 200);
    const note = { id: randomUUID(), text: 'Запишу воспоминание и вернусь к нему позже.', version: 1 };
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner.cookie, note)).status, 202);
    let c = await f.waitIdle(id, owner.cookie);
    assert.equal(c.status, 'error'); assert.match(c.error!, /ключ API/);
    assert.equal(c.messages[0].text, note.text);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner.cookie, note)).status, 200);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner.cookie, { ...note, text: 'Changed payload' })).status, 409);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner.cookie, { ...note, id: randomUUID() })).status, 409);
    assert.equal(f.store.get<Conversation>('conversations', id)!.messages.length, 1);
    const { file, bytes } = await f.audio(owner.body.id);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner.cookie, { id: randomUUID(), text: '', fileId: file.id, version: c.version })).status, 202);
    c = await f.waitIdle(id, owner.cookie);
    assert.equal(c.messages[1].file?.id, file.id);
    assert.equal((await fetch(f.base + file.url, { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await fetch(f.base + file.url + '/original', { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await fetch(f.base + file.url, { headers: { Cookie: owner.cookie } })).status, 200);
    assert.equal(f.store.all('materials').length, 0);
    const archived = await f.request(`/api/conversations/${id}/archive`, owner.cookie, { version: c.version });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const material = f.store.get<Material>('materials', archived.body.materialId)!;
    assert.equal(material.body, note.text); assert.equal(material.narrator, '');
    assert.equal(material.relatedMaterialIds?.length, 1);
    const published = await fetch(f.base + file.url, { headers: { Cookie: other.cookie } });
    assert.equal(published.status, 200);
    assert.deepEqual(Buffer.from(await published.arrayBuffer()), bytes);
    assert.equal((await fetch(f.base + file.url)).status, 401);
    assert.equal(f.store.all('people').length, 0);
  } finally { await f.cleanup(); }
});

test('streaming and prepare create fixed reviewable sources; acceptance is explicit, unconfirmed, and idempotent', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let replies = 0; let preparations = 0;
  const source = 'Анна Петрова родилась около 1941 года.';
  const f = await fixture({
    available: () => true,
    reply: async (_input, onDelta) => {
      replies++; onDelta('Расскажите ');
      if (replies === 1) await gate;
      onDelta('о её детстве.'); return 'Расскажите о её детстве.';
    },
    prepare: async input => {
      preparations++; assert.equal(conversationUserText(input.messages), source);
      const common = { personId: null, personName: 'Анна Петрова', key: null, value: null, fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote: source, sourceStart: null, sourceEnd: null };
      return { proposals: [{ ...common, action: 'create_person' }, { ...common, action: 'set_fact', key: 'birthDate', value: 'около 1941 года' }], rejectedCount: 0 };
    },
  });
  try {
    const c0 = (await f.request('/api/conversations', f.admin.cookie, {})).body as Conversation;
    assert.equal((await f.request(`/api/conversations/${c0.id}/messages`, f.admin.cookie, { id: randomUUID(), text: source, version: c0.version })).status, 202);
    let c = (await f.request(`/api/conversations/${c0.id}`, f.admin.cookie)).body as Conversation;
    assert.equal(c.status, 'responding'); assert.equal(c.messages.at(-1)?.text, 'Расскажите ');
    release(); c = await f.waitIdle(c.id, f.admin.cookie);
    assert.equal(c.status, 'idle'); assert.equal(c.messages.at(-1)?.text, 'Расскажите о её детстве.');
    assert.equal(f.store.all('people').length, 0);
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin.cookie, { version: c.version })).status, 202);
    c = await f.waitIdle(c.id, f.admin.cookie);
    assert.equal(c.status, 'idle');
    const material = f.store.get<Material>('materials', c.materialId!)!;
    assert.equal(material.body, source); assert.equal(material.proposals?.length, 2);
    assert.equal(f.store.all('people').length, 0); assert.equal(f.store.all('facts').length, 0);
    const batch = { accept: material.proposals, reject: [], transcriptVersion: null };
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, batch)).status, 200);
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, batch)).status, 200);
    assert.equal(f.store.all('people').length, 1);
    const facts = f.store.all<Fact>('facts');
    assert.equal(facts.length, 2); assert.ok(facts.every(fact => fact.status === 'unconfirmed' && fact.createdBy === f.admin.body.id && fact.sourceMaterialId === material.id));
    const birth = facts.find(fact => fact.key === 'birthDate')!;
    assert.equal((await f.request(`/api/review/facts/${birth.id}`, f.admin.cookie, { action: 'confirm', version: birth.version })).status, 403);
    const oldSnapshot = JSON.stringify(f.store.get('materials', material.id));
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin.cookie, { version: c.version })).status, 200);
    assert.equal(preparations, 1);
    assert.equal((await f.request(`/api/conversations/${c.id}/archive`, f.admin.cookie, { version: c.version })).body.materialId, material.id);
    assert.equal(f.store.all('materials').length, 1);
    const second = 'Она любила гулять в саду.';
    assert.equal((await f.request(`/api/conversations/${c.id}/messages`, f.admin.cookie, { id: randomUUID(), text: second, version: c.version })).status, 202);
    c = await f.waitIdle(c.id, f.admin.cookie);
    const next = await f.request(`/api/conversations/${c.id}/archive`, f.admin.cookie, { version: c.version });
    assert.notEqual(next.body.materialId, material.id);
    assert.equal(f.store.get<Material>('materials', next.body.materialId)!.body, `${source}\n\n${second}`);
    assert.equal(JSON.stringify(f.store.get('materials', material.id)), oldSnapshot);
    await f.request(`/api/conversations/${c.id}/archive`, f.admin.cookie, { version: c.version });
    assert.equal(f.store.all('materials').length, 2);
  } finally { release(); await f.cleanup(); }
});

test('startup interruptions are recoverable; correcting voice text creates a new source without reusing obsolete transcription', async () => {
  let transcriptions = 0;
  const preparedSources: string[] = [];
  const oldText = 'Анна Петрова родилась в 1940 году.';
  const corrected = 'Анна Петрова родилась около 1941 года.';
  const f = await fixture({ available: () => true,
    reply: async (_input, onDelta) => { onDelta('Что ещё вы помните?'); return 'Что ещё вы помните?'; },
    prepare: async input => { preparedSources.push(conversationUserText(input.messages)); return { proposals: [], rejectedCount: 0 }; },
    transcribe: async () => { transcriptions++; return { text: oldText, segments: [{ start: 0, end: 3, text: oldText }] }; },
  });
  try {
    const initial = (await f.request('/api/conversations', f.admin.cookie, {})).body as Conversation;
    await f.request(`/api/conversations/${initial.id}/messages`, f.admin.cookie, { id: randomUUID(), text: 'Первое воспоминание.', version: initial.version });
    let c = await f.waitIdle(initial.id, f.admin.cookie);
    c = (await f.request(`/api/conversations/${c.id}/archive`, f.admin.cookie, { version: c.version })).body;
    const material = f.store.get<Material>('materials', c.materialId!)!;
    f.store.put('materials', { ...material, extractionStatus: 'processing' });
    f.store.put('conversations', { ...f.store.get<Conversation>('conversations', c.id)!, status: 'preparing' });
    await f.restart();
    c = (await f.request(`/api/conversations/${c.id}`, f.admin.cookie)).body;
    assert.equal(c.status, 'error'); assert.equal(c.errorOperation, 'preparing');
    assert.ok(!c.messages.at(-1)?.interrupted, 'a completed reply survives interrupted preparation');
    assert.equal(f.store.get<Material>('materials', material.id)!.extractionStatus, 'error');
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin.cookie, { version: c.version })).status, 202);
    assert.equal((await f.waitIdle(c.id, f.admin.cookie)).status, 'idle');
    assert.equal(f.store.get<Material>('materials', material.id)!.extractionStatus, 'done');
    const voice = (await f.request('/api/conversations', f.admin.cookie, {})).body as Conversation;
    const { file } = await f.audio(f.admin.body.id);
    const messageId = randomUUID();
    await f.request(`/api/conversations/${voice.id}/messages`, f.admin.cookie, { id: messageId, text: '', fileId: file.id, version: voice.version });
    let vc = await f.waitIdle(voice.id, f.admin.cookie);
    assert.equal(vc.messages[0].automatic, true); assert.equal(transcriptions, 1);
    vc = (await f.request(`/api/conversations/${vc.id}/archive`, f.admin.cookie, { version: vc.version })).body;
    const oldStory = f.store.get<Material>('materials', vc.materialId!)!;
    const oldClip = f.store.get<Material>('materials', oldStory.relatedMaterialIds![0])!;
    assert.equal(oldClip.transcript?.text, oldText); assert.equal(oldClip.narrator, '');
    const changed = await f.request(`/api/conversations/${vc.id}/messages/${messageId}`, f.admin.cookie, { text: corrected, version: vc.version }, 'PATCH');
    assert.equal(changed.status, 200); vc = changed.body;
    assert.equal(vc.messages.length, 1); assert.equal(vc.messages[0].automatic, false);
    await f.request(`/api/conversations/${vc.id}/retry`, f.admin.cookie, { version: vc.version });
    vc = await f.waitIdle(vc.id, f.admin.cookie); assert.equal(transcriptions, 1);
    assert.equal((await f.request(`/api/conversations/${vc.id}/prepare`, f.admin.cookie, { version: vc.version })).status, 202);
    vc = await f.waitIdle(vc.id, f.admin.cookie);
    assert.equal(vc.status, 'idle'); assert.equal(preparedSources.at(-1), corrected);
    const newStory = f.store.get<Material>('materials', vc.materialId!)!;
    const newClip = f.store.get<Material>('materials', newStory.relatedMaterialIds![0])!;
    assert.notEqual(newStory.id, oldStory.id); assert.notEqual(newClip.id, oldClip.id);
    assert.equal(newClip.transcript?.text, corrected); assert.equal(newClip.transcript?.automatic, false);
    assert.deepEqual(newClip.transcript?.segments, []);
    assert.equal(f.store.get<Material>('materials', oldStory.id)!.body, oldText);
    assert.equal(f.store.get<Material>('materials', oldClip.id)!.transcript?.text, oldText);
  } finally { await f.cleanup(); }
});


test('preparation failure preserves the completed reply and retry targets preparation', async () => {
  let preparations = 0;
  let replies = 0;
  const f = await fixture({ available: () => true,
    reply: async () => { replies++; return 'Рассказ сохранён.'; },
    prepare: async () => { if (++preparations === 1) throw new Error('AI вернул предложение без надёжной цитаты или с некорректными полями. Повторите поиск сведений.'); return { proposals: [], rejectedCount: 1 }; },
  });
  try {
    let c = (await f.request('/api/conversations', f.admin.cookie, {})).body as Conversation;
    await f.request(`/api/conversations/${c.id}/messages`, f.admin.cookie, { id: randomUUID(), text: 'Анна Петрова — моя бабушка.', version: c.version });
    c = await f.waitIdle(c.id, f.admin.cookie);
    const completedReply = c.messages.at(-1);
    await f.request(`/api/conversations/${c.id}/prepare`, f.admin.cookie, { version: c.version });
    c = await f.waitIdle(c.id, f.admin.cookie);
    assert.equal(c.status, 'error');
    assert.equal(c.errorOperation, 'preparing');
    assert.deepEqual(c.messages.at(-1), completedReply);
    // Simulate the stored shape from the previous app version.
    f.store.put('conversations', { ...f.store.get<Conversation>('conversations', c.id)!, errorOperation: undefined, messages: c.messages.map(m => m.role === 'assistant' ? { ...m, interrupted: true } : m) });
    await f.restart();
    c = (await f.request(`/api/conversations/${c.id}`, f.admin.cookie)).body;
    assert.equal(c.errorOperation, 'preparing');
    assert.equal(c.messages.at(-1)?.interrupted, false);
    await f.request(`/api/conversations/${c.id}/prepare`, f.admin.cookie, { version: c.version });
    c = await f.waitIdle(c.id, f.admin.cookie);
    assert.equal(c.status, 'idle'); assert.equal(c.errorOperation, null);
    assert.equal(replies, 1); assert.equal(preparations, 2);
    assert.equal(c.messages.at(-1)?.text, completedReply?.text);
    assert.equal(c.messages.at(-1)?.interrupted, false);
    assert.equal(f.store.get<Material>('materials', c.materialId!)!.extractionRejectedCount, 1);
    assert.equal(f.store.all('people').length, 0);
  } finally { await f.cleanup(); }
});
