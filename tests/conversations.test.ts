import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Runtime } from '../server/app.js';
import type { FamilyStore } from '../server/db.js';
import type { ConversationAI } from '../server/conversations.js';
import { conversationUserText } from '../server/conversation-ai.js';
import type { Conversation, Fact, Material, Proposal } from '../shared/types.js';

type Table = Parameters<FamilyStore['all']>[0];
const defaults: ConversationAI = {
  available: () => false,
  reply: async () => { throw new Error('Unexpected reply call in offline fixture'); },
  prepare: async () => { throw new Error('Unexpected preparation call in offline fixture'); },
  transcribe: async () => { throw new Error('Unexpected transcription call in offline fixture'); },
};

type Who = { cookie: string; family?: string; id?: string };
async function fixture(ai: Partial<ConversationAI> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-conversations-test-'));
  let runtime!: Runtime;
  let server!: Server;
  let base = '';
  // On-disk PGlite: restart() must find the same conversations and sessions.
  const boot = async () => {
    runtime = await createApp({ memoryDatabase: false, databaseUrl: '', dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false, conversationAI: { ...defaults, ...ai } });
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  };
  await boot();
  const request = async (path: string, who: Who | string = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const { cookie, family } = typeof who === 'string' ? { cookie: who, family: undefined } : who;
    const response = await fetch(base + path, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(family ? { 'X-Family-Id': family } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  let familyId = '';
  const login = async (email: string) => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const account = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(account.status, 200, JSON.stringify(account.body));
    return { cookie: account.cookie, id: account.body.id as string, body: account.body, family: familyId || undefined };
  };
  const admin = await login('admin@example.test');
  const created = await request('/api/families', admin, { name: 'Синтетическая семья' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  familyId = created.body.id; admin.family = familyId;
  const inFamily = <T>(fn: (s: FamilyStore) => Promise<T>) => runtime.db.family(familyId, fn);
  const waitIdle = async (id: string, who: Who): Promise<Conversation> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await request(`/api/conversations/${id}`, who);
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
    await mkdir(join(dataDir, 'files', familyId), { recursive: true });
    await writeFile(runtime.blobs.localPath(familyId, id), bytes);
    const file = { id, name: 'recording.wav', mime: 'audio/wav', size: bytes.length, path: id, createdBy, url: `/api/files/${id}`, previewStatus: 'none' as const };
    await inFamily(s => s.put('files', file));
    return { file, bytes };
  };
  return { request, login, admin, waitIdle, audio, get familyId() { return familyId; }, get base() { return base; },
    all: <T = Record<string, unknown>>(table: Table) => inFamily(s => s.all<T>(table)),
    get: <T = Record<string, unknown>>(table: Table, id: string) => inFamily(s => s.get<T>(table, id)),
    put: <T extends { id: string }>(table: Table, value: T) => inFamily(s => s.put(table, value)),
    restart: async () => { await stop(); await boot(); },
    cleanup: async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('private conversations enforce access and idempotency; missing-key notes/audio survive until explicit publication', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/conversations')).status, 401);
    for (const [email, role] of [['owner@example.test', 'member'], ['other@example.test', 'member'], ['viewer@example.test', 'viewer']]) {
      assert.equal((await f.request('/api/invitations', f.admin, { email, role })).status, 201);
    }
    const owner = await f.login('owner@example.test');
    const other = await f.login('other@example.test');
    const viewer = await f.login('viewer@example.test');
    assert.equal((await f.request('/api/conversations', viewer, {})).status, 403);
    const created = await f.request('/api/conversations', owner, {});
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await f.request(`/api/conversations/${id}`, other)).status, 404);
    assert.equal((await f.request(`/api/conversations/${id}`, f.admin)).status, 200);
    const note = { id: randomUUID(), text: 'Запишу воспоминание и вернусь к нему позже.', version: 1 };
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner, note)).status, 202);
    let c = await f.waitIdle(id, owner);
    assert.equal(c.status, 'error'); assert.match(c.error!, /ключ API/);
    assert.equal(c.messages[0].text, note.text);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner, note)).status, 200);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner, { ...note, text: 'Changed payload' })).status, 409);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner, { ...note, id: randomUUID() })).status, 409);
    assert.equal((await f.get<Conversation>('conversations', id))!.messages.length, 1);
    const { file, bytes } = await f.audio(owner.body.id);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, owner, { id: randomUUID(), text: '', fileId: file.id, version: c.version })).status, 202);
    c = await f.waitIdle(id, owner);
    assert.equal(c.messages[1].file?.id, file.id);
    assert.equal((await fetch(f.base + file.url, { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await fetch(f.base + file.url + '/original', { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await fetch(f.base + file.url, { headers: { Cookie: owner.cookie } })).status, 200);
    assert.equal((await f.all('materials')).length, 0);
    const archived = await f.request(`/api/conversations/${id}/archive`, owner, { version: c.version });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const material = (await f.get<Material>('materials', archived.body.materialId))!;
    assert.equal(material.body, note.text); assert.equal(material.narrator, '');
    assert.equal(material.relatedMaterialIds?.length, 1);
    const published = await fetch(f.base + file.url, { headers: { Cookie: other.cookie } });
    assert.equal(published.status, 200);
    assert.deepEqual(Buffer.from(await published.arrayBuffer()), bytes);
    assert.equal((await fetch(f.base + file.url)).status, 401);
    assert.equal((await f.all('people')).length, 0);
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
    const c0 = (await f.request('/api/conversations', f.admin, {})).body as Conversation;
    assert.equal((await f.request(`/api/conversations/${c0.id}/messages`, f.admin, { id: randomUUID(), text: source, version: c0.version })).status, 202);
    let c = (await f.request(`/api/conversations/${c0.id}`, f.admin)).body as Conversation;
    assert.equal(c.status, 'responding'); assert.equal(c.messages.at(-1)?.text, 'Расскажите ');
    release(); c = await f.waitIdle(c.id, f.admin);
    assert.equal(c.status, 'idle'); assert.equal(c.messages.at(-1)?.text, 'Расскажите о её детстве.');
    assert.equal((await f.all('people')).length, 0);
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin, { version: c.version })).status, 202);
    c = await f.waitIdle(c.id, f.admin);
    assert.equal(c.status, 'idle');
    const material = (await f.get<Material>('materials', c.materialId!))!;
    assert.equal(material.body, source); assert.equal(material.proposals?.length, 2);
    assert.equal((await f.all('people')).length, 0); assert.equal((await f.all('facts')).length, 0);
    const batch = { accept: material.proposals, reject: [], transcriptVersion: null };
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin, batch)).status, 200);
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin, batch)).status, 200);
    assert.equal((await f.all('people')).length, 1);
    const facts = (await f.all<Fact>('facts'));
    assert.equal(facts.length, 2); assert.ok(facts.every(fact => fact.status === 'unconfirmed' && fact.createdBy === f.admin.body.id && fact.sourceMaterialId === material.id));
    const birth = facts.find(fact => fact.key === 'birthDate')!;
    assert.equal((await f.request(`/api/review/facts/${birth.id}`, f.admin, { action: 'confirm', version: birth.version })).status, 403);
    const oldSnapshot = JSON.stringify((await f.get('materials', material.id)));
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin, { version: c.version })).status, 200);
    assert.equal(preparations, 1);
    assert.equal((await f.request(`/api/conversations/${c.id}/archive`, f.admin, { version: c.version })).body.materialId, material.id);
    assert.equal((await f.all('materials')).length, 1);
    const second = 'Она любила гулять в саду.';
    assert.equal((await f.request(`/api/conversations/${c.id}/messages`, f.admin, { id: randomUUID(), text: second, version: c.version })).status, 202);
    c = await f.waitIdle(c.id, f.admin);
    const next = await f.request(`/api/conversations/${c.id}/archive`, f.admin, { version: c.version });
    assert.notEqual(next.body.materialId, material.id);
    assert.equal((await f.get<Material>('materials', next.body.materialId))!.body, `${source}\n\n${second}`);
    assert.equal(JSON.stringify((await f.get('materials', material.id))), oldSnapshot);
    await f.request(`/api/conversations/${c.id}/archive`, f.admin, { version: c.version });
    assert.equal((await f.all('materials')).length, 2);
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
    const initial = (await f.request('/api/conversations', f.admin, {})).body as Conversation;
    await f.request(`/api/conversations/${initial.id}/messages`, f.admin, { id: randomUUID(), text: 'Первое воспоминание.', version: initial.version });
    let c = await f.waitIdle(initial.id, f.admin);
    c = (await f.request(`/api/conversations/${c.id}/archive`, f.admin, { version: c.version })).body;
    const material = (await f.get<Material>('materials', c.materialId!))!;
    await f.put('materials', { ...material, extractionStatus: 'processing' });
    await f.put('conversations', { ...(await f.get<Conversation>('conversations', c.id))!, status: 'preparing' });
    await f.restart();
    c = (await f.request(`/api/conversations/${c.id}`, f.admin)).body;
    assert.equal(c.status, 'error'); assert.equal(c.errorOperation, 'preparing');
    assert.ok(!c.messages.at(-1)?.interrupted, 'a completed reply survives interrupted preparation');
    assert.equal((await f.get<Material>('materials', material.id))!.extractionStatus, 'error');
    assert.equal((await f.request(`/api/conversations/${c.id}/prepare`, f.admin, { version: c.version })).status, 202);
    assert.equal((await f.waitIdle(c.id, f.admin)).status, 'idle');
    assert.equal((await f.get<Material>('materials', material.id))!.extractionStatus, 'done');
    const voice = (await f.request('/api/conversations', f.admin, {})).body as Conversation;
    const { file } = await f.audio(f.admin.body.id);
    const messageId = randomUUID();
    await f.request(`/api/conversations/${voice.id}/messages`, f.admin, { id: messageId, text: '', fileId: file.id, version: voice.version });
    let vc = await f.waitIdle(voice.id, f.admin);
    assert.equal(vc.messages[0].automatic, true); assert.equal(transcriptions, 1);
    vc = (await f.request(`/api/conversations/${vc.id}/archive`, f.admin, { version: vc.version })).body;
    const oldStory = (await f.get<Material>('materials', vc.materialId!))!;
    const oldClip = (await f.get<Material>('materials', oldStory.relatedMaterialIds![0]))!;
    assert.equal(oldClip.transcript?.text, oldText); assert.equal(oldClip.narrator, '');
    const changed = await f.request(`/api/conversations/${vc.id}/messages/${messageId}`, f.admin, { text: corrected, version: vc.version }, 'PATCH');
    assert.equal(changed.status, 200); vc = changed.body;
    assert.equal(vc.messages.length, 1); assert.equal(vc.messages[0].automatic, false);
    await f.request(`/api/conversations/${vc.id}/retry`, f.admin, { version: vc.version });
    vc = await f.waitIdle(vc.id, f.admin); assert.equal(transcriptions, 1);
    assert.equal((await f.request(`/api/conversations/${vc.id}/prepare`, f.admin, { version: vc.version })).status, 202);
    vc = await f.waitIdle(vc.id, f.admin);
    assert.equal(vc.status, 'idle'); assert.equal(preparedSources.at(-1), corrected);
    const newStory = (await f.get<Material>('materials', vc.materialId!))!;
    const newClip = (await f.get<Material>('materials', newStory.relatedMaterialIds![0]))!;
    assert.notEqual(newStory.id, oldStory.id); assert.notEqual(newClip.id, oldClip.id);
    assert.equal(newClip.transcript?.text, corrected); assert.equal(newClip.transcript?.automatic, false);
    assert.deepEqual(newClip.transcript?.segments, []);
    assert.equal((await f.get<Material>('materials', oldStory.id))!.body, oldText);
    assert.equal((await f.get<Material>('materials', oldClip.id))!.transcript?.text, oldText);
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
    let c = (await f.request('/api/conversations', f.admin, {})).body as Conversation;
    await f.request(`/api/conversations/${c.id}/messages`, f.admin, { id: randomUUID(), text: 'Анна Петрова — моя бабушка.', version: c.version });
    c = await f.waitIdle(c.id, f.admin);
    const completedReply = c.messages.at(-1);
    await f.request(`/api/conversations/${c.id}/prepare`, f.admin, { version: c.version });
    c = await f.waitIdle(c.id, f.admin);
    assert.equal(c.status, 'error');
    assert.equal(c.errorOperation, 'preparing');
    assert.deepEqual(c.messages.at(-1), completedReply);
    // The failed preparation and the completed reply survive a restart unchanged.
    await f.restart();
    c = (await f.request(`/api/conversations/${c.id}`, f.admin)).body;
    assert.equal(c.status, 'error'); assert.equal(c.errorOperation, 'preparing');
    assert.ok(!c.messages.at(-1)?.interrupted);
    await f.request(`/api/conversations/${c.id}/prepare`, f.admin, { version: c.version });
    c = await f.waitIdle(c.id, f.admin);
    assert.equal(c.status, 'idle'); assert.equal(c.errorOperation, null);
    assert.equal(replies, 1); assert.equal(preparations, 2);
    assert.equal(c.messages.at(-1)?.text, completedReply?.text);
    assert.ok(!c.messages.at(-1)?.interrupted);
    assert.equal((await f.get<Material>('materials', c.materialId!))!.extractionRejectedCount, 1);
    assert.equal((await f.all('people')).length, 0);
  } finally { await f.cleanup(); }
});

test('a busy assistant never refuses a message; only the author changes or publishes a conversation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ available: () => true, reply: async () => { await gate; return 'Спасибо, записал.'; } });
  try {
    assert.equal((await f.request('/api/invitations', f.admin, { email: 'teller@example.test', role: 'member' })).status, 201);
    const teller = await f.login('teller@example.test');
    const conversations = [];
    for (let i = 0; i < 3; i++) conversations.push((await f.request('/api/conversations', teller, {})).body as Conversation);
    for (const c of conversations.slice(0, 2)) assert.equal((await f.request(`/api/conversations/${c.id}/messages`, teller, { id: randomUUID(), text: 'Первая история', version: c.version })).status, 202);
    const story = { id: randomUUID(), text: 'Бабушка рассказывала про дом у реки.', version: conversations[2].version };
    const saved = await f.request(`/api/conversations/${conversations[2].id}/messages`, teller, story);
    assert.equal(saved.status, 202, JSON.stringify(saved.body));
    assert.equal(saved.body.status, 'error'); assert.equal(saved.body.errorOperation, 'responding'); assert.match(saved.body.error, /Сообщение сохранено/);
    assert.equal((await f.get<Conversation>('conversations', conversations[2].id))!.messages[0].text, story.text);
    // Administrators can read but not alter or publish another member's private dialogue.
    assert.equal((await f.request(`/api/conversations/${conversations[2].id}`, f.admin)).status, 200);
    assert.equal((await f.request(`/api/conversations/${conversations[2].id}/archive`, f.admin, { version: saved.body.version })).status, 403);
    release();
    for (const c of conversations.slice(0, 2)) assert.equal((await f.waitIdle(c.id, teller)).status, 'idle');
    const retried = await f.request(`/api/conversations/${conversations[2].id}/retry`, teller, { version: saved.body.version });
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    const done = await f.waitIdle(conversations[2].id, teller);
    assert.equal(done.status, 'idle'); assert.equal(done.messages.at(-1)?.text, 'Спасибо, записал.');
    // Correcting a message keeps the earlier wording in history.
    const edited = await f.request(`/api/conversations/${done.id}/messages/${story.id}`, teller, { text: 'Бабушка рассказывала про дом у реки Оки.', version: done.version }, 'PATCH');
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const history = (await f.all<{ entityId: string; action: string; before: string }>('history')).filter(entry => entry.entityId === done.id);
    assert.equal(history.length, 1); assert.equal(JSON.parse(history[0].before).text, story.text);
  } finally { release(); await f.cleanup(); }
});
