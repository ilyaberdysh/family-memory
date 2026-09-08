import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationUserText, prepareConversationProposals, streamConversationReply } from '../server/conversation-ai.js';
import { parseAndGroundProposals } from '../server/ai.js';
import type { ConversationMessage, Person, User } from '../shared/types.js';

const message = (role: 'user' | 'assistant', text: string, id: string = role): ConversationMessage => ({ id, role, text, createdAt: '' });
const user: User = { id: 'account-only', name: 'Имя аккаунта', email: 'private@example.com', role: 'member' };
const people: Person[] = [{ id: 'p1', name: 'Анна Петрова', avatarFileId: null, createdBy: 'someone', createdAt: '' }];
const proposal = (sourceQuote: string, value: string) => ({ action: 'set_fact', personId: 'nonexistent-id', personName: 'Анна Петрова', key: 'birthDate', value,
  fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote });

test('only current user statements enter extraction; assistant inventions and guessed IDs fail grounding', async t => {
  const corrected = 'Анна Петрова родилась около 1941 года, точную дату не знаю.';
  const invented = 'Анна Петрова родилась 12 января 1940 года.';
  const messages = [message('user', corrected), message('assistant', invented)];
  const corpus = conversationUserText(messages);
  assert.equal(corpus, corrected);
  assert.equal(conversationUserText([message('user', 'Первая фраза.'), message('assistant', 'Вопрос'), message('user', 'Вторая фраза.', 'u2')]), 'Первая фраза.\n\nВторая фраза.');
  assert.throws(() => parseAndGroundProposals({ proposals: [proposal(invented, '12 января 1940 года')] }, corpus, [], { people, facts: [] }), /цитаты/);
  const apiKeyBefore = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-placeholder-not-a-real-key';
  t.after(() => { if (apiKeyBefore === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = apiKeyBefore; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const request = JSON.parse(String(options?.body));
    const data = JSON.parse(request.input[0].content);
    assert.equal(data.transcript, corrected);
    assert.equal(JSON.stringify(request).includes(invented), false);
    assert.equal(JSON.stringify(request).includes(user.email), false);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ proposals: [proposal(corrected, 'около 1941 года'), proposal(invented, '12 января 1940 года')] }) }] }] });
  });
  const { proposals: [draft], rejectedCount } = await prepareConversationProposals({ messages, user, people, facts: [], relations: [] });
  assert.equal(rejectedCount, 1);
  assert.equal(draft.personId, null);
  assert.equal(draft.value, 'около 1941 года');
  assert.equal(draft.sourceStart, null);
});

test('direct provider streams real deltas; partial/provider/abort failures cannot become successful replies or leak errors', async t => {
  const apiKeyBefore = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-placeholder-not-a-real-key';
  t.after(() => { if (apiKeyBefore === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = apiKeyBefore; });
  let mode = 'success';
  const mockFetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const request = JSON.parse(String(options?.body));
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.equal(JSON.stringify(request).includes(user.email), false);
    assert.equal(request.tools, undefined);
    if (mode === 'error') return Response.json({ error: { message: 'PRIVATE_ERROR_DETAIL test-placeholder-not-a-real-key', type: 'server_error' } }, { status: 500 });
    const event = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const payload = event({ role: 'assistant', content: 'Что вы помните ' }) + event({ content: 'об этом месте?' })
      + (mode === 'partial' ? '' : event({}, 'stop') + 'data: [DONE]\n\n');
    return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const input = { messages: [message('user', 'Хочу рассказать о семье.')], user, people, facts: [], relations: [] };
  const deltas: string[] = [];
  assert.equal(await streamConversationReply(input, delta => deltas.push(delta)), 'Что вы помните об этом месте?');
  assert.deepEqual(deltas, ['Что вы помните ', 'об этом месте?']);
  mode = 'partial';
  await assert.rejects(() => streamConversationReply(input, () => {}), /не завершил|незавершённый/);
  mode = 'error';
  await assert.rejects(() => streamConversationReply(input, () => {}), error => error instanceof Error && !/PRIVATE_ERROR_DETAIL|test-placeholder/.test(error.message) && /Не удалось/.test(error.message));
  const before = mockFetch.mock.callCount();
  await assert.rejects(() => streamConversationReply(input, () => {}, AbortSignal.abort()), /Ответ прерван/);
  assert.equal(mockFetch.mock.callCount(), before);
  mode = 'success';
  const controller = new AbortController();
  await assert.rejects(() => streamConversationReply(input, () => controller.abort(), controller.signal), /Ответ прерван/);
});
