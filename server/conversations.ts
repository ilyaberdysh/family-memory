import type { Express, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { isAiConfigured, transcribeFile } from './ai.js';
import { conversationUserText, prepareConversationProposals, streamConversationReply } from './conversation-ai.js';
import type { Conversation, ConversationMessage, Fact, Material, Person, Proposal, Relation, TranscriptSegment, UploadedFile, User } from '../shared/types.js';

export class ConversationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface ConversationAI {
  available: () => boolean;
  reply: typeof streamConversationReply;
  prepare: typeof prepareConversationProposals;
  transcribe: typeof transcribeFile;
}
type FileRecord = UploadedFile & { createdBy: string; path: string; previewMime?: string; previewSize?: number };
type StoredMessage = ConversationMessage & { requestHash?: string; segments?: TranscriptSegment[] };
type StoredConversation = Omit<Conversation, 'messages'> & { messages: StoredMessage[] };
type ConversationMaterial = Material & { conversationId?: string; conversationVersion?: number; messageId?: string; messageHash?: string };
const now = () => new Date().toISOString();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const active = (c: Conversation) => ['responding', 'transcribing', 'preparing'].includes(c.status);
const operation = (c: Conversation): Conversation['errorOperation'] => c.status === 'preparing' || c.status === 'transcribing' || c.status === 'responding' ? c.status : null;
const versionSchema = z.object({ version: z.number().int().positive() });
const failed = (status: number, message: string): never => { throw new ConversationError(status, message); };
const clean = (c: StoredConversation): Conversation => ({ ...c, messages: c.messages.map(({ requestHash, segments, ...message }) => message) });
const publicFile = (file: FileRecord): UploadedFile => ({ id: file.id, name: file.name, mime: file.previewMime ?? file.mime, size: file.previewSize ?? file.size, url: file.url });

/** Registered after authentication/CSRF. No assistant operation can write people, facts, or relations. */
export function registerConversations(app: Express, store: Store, overrides: Partial<ConversationAI> = {}) {
  const ai: ConversationAI = { available: isAiConfigured, reply: streamConversationReply, prepare: prepareConversationProposals, transcribe: transcribeFile, ...overrides };
  const operations = new Map<string, AbortController>();
  let closed = false;
  const save = (c: StoredConversation) => store.put('conversations', { ...c, updatedAt: now() });
  const get = (id: string) => store.get<StoredConversation>('conversations', id) ?? failed(404, 'Разговор не найден.');
  const user = (res: Response): User => res.locals.user as User;
  const access = (id: string, account: User, write = false) => {
    const c = get(id);
    if (c.createdBy !== account.id && account.role !== 'admin') failed(404, 'Разговор не найден.');
    if (write && account.role === 'viewer') failed(403, 'Наблюдатель может только смотреть.');
    return c;
  };
  const idleVersion = (c: StoredConversation, version: number) => {
    if (c.version !== version) failed(409, 'Разговор уже изменился. Обновите его и попробуйте снова.');
    if (active(c)) failed(409, 'Дождитесь завершения текущей обработки.');
  };
  const capacity = () => { if (operations.size >= 2) failed(429, 'Сейчас обрабатываются другие разговоры. Попробуйте через минуту.'); };
  const context = (c: StoredConversation, account: User) => ({ messages: clean(c).messages, user: account, people: store.all<Person>('people'), facts: store.all<Fact>('facts'), relations: store.all<Relation>('relations') });
  const lastUserIndex = (c: StoredConversation) => { for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === 'user') return i; return -1; };
  const interrupt = (c: StoredConversation) => {
    const error = 'Обработка прервана. Рассказ сохранён; повторите обработку вручную.';
    if (c.status === 'preparing' && c.materialId) {
      const material = store.get<ConversationMaterial>('materials', c.materialId);
      if (material?.conversationId === c.id && material.extractionStatus === 'processing') store.put('materials', { ...material, extractionStatus: 'error', processingError: error });
    }
    return save({ ...c, status: 'error', error, errorOperation: operation(c), messages: c.messages.map((m, i) => c.status === 'responding' && m.role === 'assistant' && i > lastUserIndex(c) ? { ...m, interrupted: true } : m) });
  };
  // Never automatically repeat a potentially paid request on startup or restore.
  for (const c of store.all<StoredConversation>('conversations')) {
    if (active(c)) interrupt(c);
    // Repair the known legacy extraction failure, which incorrectly marked the completed reply.
    // The exact message belongs exclusively to the extraction validator, never the chat stream.
    else if (c.status === 'error' && c.errorOperation === undefined && c.error === 'AI вернул предложение без надёжной цитаты или с некорректными полями. Повторите поиск сведений.') {
      const material = c.materialId ? store.get<ConversationMaterial>('materials', c.materialId) : null;
      if (material?.conversationId === c.id && material.extractionStatus === 'error' && material.processingError === c.error) {
        save({ ...c, errorOperation: 'preparing', messages: c.messages.map((m, i) => m.role === 'assistant' && i > lastUserIndex(c) ? { ...m, interrupted: false } : m) });
      }
    }
  }

  /** An explicit publication makes a fixed source, independent of subsequent conversation edits. */
  function archive(c: StoredConversation, account: User): StoredConversation {
    if (!c.messages.some(m => m.role === 'user')) failed(400, 'Сначала добавьте рассказ или голосовое сообщение.');
    if (c.materialId && c.archivedVersion === c.version && store.get('materials', c.materialId)) return c;
    return store.transaction(() => {
      const relatedMaterialIds: string[] = [];
      for (const message of c.messages) {
        if (message.role !== 'user' || !message.file) continue;
        const messageHash = digest(JSON.stringify([message.text, message.file.id, message.automatic, message.segments]));
        let material = store.all<ConversationMaterial>('materials').find(m => m.conversationId === c.id && m.messageId === message.id && m.messageHash === messageHash);
        if (!material) {
          material = store.put<ConversationMaterial>('materials', {
            id: randomUUID(), title: `${c.title} · запись ${relatedMaterialIds.length + 1}`, kind: 'audio', body: '', narrator: '', occurredAt: '', personIds: [], file: message.file,
            createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: message.text ? 'done' : 'idle', extractionStatus: 'idle', processingError: null,
            transcript: message.text ? { text: message.text, segments: message.segments ?? [], version: 1, automatic: message.automatic ?? false, updatedAt: now() } : null,
            proposals: [], conversationId: c.id, messageId: message.id, messageHash,
          });
          store.history('materials', material.id, account.id, 'archive_recording', null, material);
        }
        relatedMaterialIds.push(material.id);
      }
      const material = store.put<ConversationMaterial>('materials', {
        id: randomUUID(), title: c.title, kind: 'story', body: conversationUserText(c.messages), narrator: '', occurredAt: '', personIds: [], file: null, relatedMaterialIds,
        createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: 'idle', extractionStatus: 'idle', processingError: null, transcript: null, proposals: [], conversationId: c.id, conversationVersion: c.version,
      });
      store.history('materials', material.id, account.id, 'archive_conversation', null, material);
      return save({ ...c, materialId: material.id, archivedVersion: c.version });
    });
  }

  function launch(id: string, task: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    operations.set(id, controller);
    void Promise.resolve().then(() => task(controller.signal)).catch(error => {
      if (closed) return;
      const c = get(id);
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Не удалось обработать разговор. Попробуйте ещё раз.';
      const next = { ...c, status: 'error' as const, error: message, errorOperation: operation(c), messages: c.messages.map((m, i) => c.status === 'responding' && m.role === 'assistant' && i > lastUserIndex(c) ? { ...m, interrupted: true } : m) };
      save(next);
      if (c.status === 'preparing' && c.materialId) {
        const material = store.get<Material>('materials', c.materialId);
        if (material?.extractionStatus === 'processing') store.put('materials', { ...material, extractionStatus: 'error', processingError: message });
      }
    }).finally(() => operations.delete(id));
  }

  async function reply(id: string, account: User, signal: AbortSignal) {
    if (!ai.available()) throw new Error('Ассистент ещё не подключён: администратору нужно настроить ключ API. Сообщение сохранено.');
    let c = get(id);
    const index = lastUserIndex(c);
    const message = c.messages[index];
    if (!message) throw new Error('Сначала добавьте сообщение.');
    for (const pending of c.messages.filter(m => m.role === 'user' && m.file && !m.text.trim())) {
      const file = store.get<FileRecord>('files', pending.file!.id);
      if (!file) throw new Error('Исходная запись не найдена.');
      save({ ...c, status: 'transcribing' });
      const result = await ai.transcribe(join(store.filesDir, file.path), file.mime);
      if (closed || signal.aborted) return;
      c = get(id);
      const text = result.text.trim();
      if (!text) throw new Error('В записи не удалось распознать речь. Можно написать рассказ вручную.');
      if (conversationUserText(c.messages).length + text.length > 120000) throw new Error('Разговор слишком длинный. Сохраните запись в архив и начните новый разговор.');
      c = save({ ...c, version: c.version + 1, messages: c.messages.map(m => m.id === pending.id ? { ...m, text, automatic: true, segments: result.segments } : m) });
    }
    const assistantId = randomUUID();
    c = save({ ...c, status: 'responding', messages: [...c.messages, { id: assistantId, role: 'assistant', text: '', createdAt: now() }] });
    const input = context({ ...c, messages: c.messages.filter(m => m.id !== assistantId) }, account);
    let text = ''; let lastWrite = 0;
    const flush = () => {
      if (closed || signal.aborted) return;
      const latest = get(id);
      save({ ...latest, messages: latest.messages.map(m => m.id === assistantId ? { ...m, text } : m) });
      lastWrite = Date.now();
    };
    try {
      const result = await ai.reply(input, delta => { text += delta; if (Date.now() - lastWrite > 200) flush(); }, signal);
      if (closed || signal.aborted) return;
      text = result; flush();
      save({ ...get(id), status: 'idle', error: null, errorOperation: null });
    } catch (error) { flush(); throw error; }
  }

  app.get('/api/conversations', (_req, res) => {
    const account = user(res);
    res.json(store.all<StoredConversation>('conversations').filter(c => c.createdBy === account.id || account.role === 'admin').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })));
  });
  app.post('/api/conversations', (req, res) => {
    const account = user(res);
    if (account.role === 'viewer') failed(403, 'Наблюдатель может только смотреть.');
    const { title } = z.object({ title: z.string().trim().min(1).max(180).optional() }).parse(req.body);
    const c = store.put<StoredConversation>('conversations', { id: randomUUID(), title: title || 'Новый разговор', createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, messages: [], status: 'idle', error: null, errorOperation: null, materialId: null, archivedVersion: null });
    res.status(201).json(clean(c));
  });
  app.get('/api/conversations/:id', (req, res) => res.json(clean(access(String(req.params.id), user(res)))));
  app.post('/api/conversations/:id/messages', (req, res) => {
    const account = user(res);
    const input = versionSchema.extend({ id: z.uuid(), text: z.string().trim().max(20000), fileId: z.string().min(1).optional() }).parse(req.body);
    let c = access(String(req.params.id), account, true);
    const requestHash = digest(JSON.stringify([input.text, input.fileId ?? null]));
    const existing = c.messages.find(m => m.id === input.id);
    // Idempotency precedes version/busy checks: a lost HTTP response must not duplicate the message.
    if (existing) {
      if (existing.requestHash !== requestHash) failed(409, 'Это сообщение уже сохранено с другим содержимым.');
      res.json(clean(c)); return;
    }
    idleVersion(c, input.version); capacity();
    if (!input.text && !input.fileId) failed(400, 'Напишите сообщение или добавьте голосовую запись.');
    if (c.messages.length >= 198 || conversationUserText(c.messages).length + input.text.length > 120000) failed(400, 'Разговор достаточно длинный. Сохраните его и начните новый.');
    const file = input.fileId ? store.get<FileRecord>('files', input.fileId) : null;
    if (input.fileId && (!file || (file.createdBy !== account.id && account.role !== 'admin'))) failed(404, 'Запись не найдена. Загрузите её заново.');
    if (file && !file.mime.startsWith('audio/')) failed(400, 'К сообщению можно прикрепить аудиозапись.');
    if (file && input.text) failed(400, 'Отправьте запись и текст отдельными сообщениями, чтобы сохранить точную расшифровку.');
    c = save({ ...c, title: c.messages.length ? c.title : input.text ? input.text.slice(0, 65) + (input.text.length > 65 ? '…' : '') : `Разговор от ${new Intl.DateTimeFormat('ru-RU').format(new Date())}`, version: c.version + 1, status: file ? 'transcribing' : 'responding', error: null, errorOperation: null,
      messages: [...c.messages, { id: input.id, role: 'user', text: input.text, createdAt: now(), file: file ? publicFile(file) : null, automatic: false, requestHash }] });
    res.status(202).json(clean(c)); launch(c.id, signal => reply(c.id, account, signal));
  });
  app.patch('/api/conversations/:id/messages/:messageId', (req, res) => {
    const c = access(String(req.params.id), user(res), true);
    const input = versionSchema.extend({ text: z.string().trim().min(1).max(120000) }).parse(req.body);
    idleVersion(c, input.version);
    const index = lastUserIndex(c);
    if (index < 0 || c.messages[index].id !== req.params.messageId) failed(409, 'Можно исправить только последнее своё сообщение.');
    const messages = c.messages.slice(0, index + 1).map((m, i) => i === index ? { ...m, text: input.text, automatic: false, segments: [] } : m);
    if (conversationUserText(messages).length > 120000) failed(400, 'Разговор слишком длинный. Сократите текст или начните новый.');
    res.json(clean(save({ ...c, messages, version: c.version + 1, status: 'idle', error: null, errorOperation: null })));
  });
  app.post('/api/conversations/:id/retry', (req, res) => {
    const account = user(res); let c = access(String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version); capacity();
    const index = lastUserIndex(c); if (index < 0) failed(400, 'Сначала добавьте сообщение.');
    c = save({ ...c, messages: c.messages.slice(0, index + 1), status: c.messages[index].file && !c.messages[index].text ? 'transcribing' : 'responding', error: null, errorOperation: null });
    res.status(202).json(clean(c)); launch(c.id, signal => reply(c.id, account, signal));
  });
  app.post('/api/conversations/:id/archive', (req, res) => {
    const account = user(res); const c = access(String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version);
    res.json(clean(archive(c, account)));
  });
  app.post('/api/conversations/:id/prepare', (req, res) => {
    const account = user(res); let c = access(String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version); capacity();
    if (!ai.available()) failed(503, 'Поиск сведений ещё не подключён. Рассказ можно сохранить в архив без обработки.');
    if (c.messages.some(m => m.role === 'user' && m.file && !m.text.trim())) failed(400, 'Сначала расшифруйте все записи или добавьте их текст. Записи без текста можно сохранить в архив.');
    if (!conversationUserText(c.messages).trim()) failed(400, 'Сначала добавьте текст рассказа.');
    c = archive(c, account);
    const material = store.get<Material>('materials', c.materialId!)!;
    if (material.extractionStatus === 'done') { res.json(clean(save({ ...c, status: 'idle', error: null, errorOperation: null }))); return; }
    if (['queued', 'processing'].includes(material.extractionStatus)) failed(409, 'Рассказ уже обрабатывается в архиве. Дождитесь результата.');
    const source = context(c, account);
    if (material.body !== conversationUserText(c.messages) || material.transcript) failed(409, 'Рассказ был отредактирован в архиве. Запустите поиск сведений в его карточке.');
    c = save({ ...c, status: 'preparing', error: null, errorOperation: null });
    store.put('materials', { ...material, extractionStatus: 'processing', extractionRejectedCount: 0, processingError: null });
    res.status(202).json(clean(c));
    launch(c.id, async signal => {
      const result = await ai.prepare(source);
      if (closed || signal.aborted) return;
      const latest = store.get<Material>('materials', material.id)!;
      if (latest.version !== material.version || latest.body !== material.body || latest.transcript) throw new Error('Рассказ изменился во время обработки. Запустите поиск сведений в архиве.');
      const proposals: Proposal[] = result.proposals.map(p => ({ ...p, id: randomUUID(), status: 'pending', baseVersion: p.action === 'set_fact' && p.personId && p.key ? source.facts.find(f => f.personId === p.personId && f.key === p.key)?.version ?? null : null }));
      store.transaction(() => {
        const after = store.put<Material>('materials', { ...latest, extractionStatus: 'done', extractionRejectedCount: result.rejectedCount, processingError: null, proposals: [...(latest.proposals ?? []).map(p => p.status === 'pending' ? { ...p, status: 'rejected' as const } : p), ...proposals], version: latest.version + 1, updatedAt: now() });
        store.history('materials', after.id, account.id, 'extract_conversation', latest, after);
        save({ ...get(c.id), status: 'idle', error: null, errorOperation: null });
      });
    });
  });
  return { close() { closed = true; for (const [id, controller] of operations) { interrupt(get(id)); controller.abort(); } } };
}
