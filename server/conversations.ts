import type { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, FamilyStore } from './db.js';
import { isAiConfigured, transcribeFile } from './ai.js';
import { conversationUserText, prepareConversationProposals, streamConversationReply } from './conversation-ai.js';
import { clientFile, type FileRecord, type LocalBlobStore } from './files.js';
import { actor, familyOf } from './http.js';
import type { ArchiveContext } from './archive.js';
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
type StoredMessage = ConversationMessage & { requestHash?: string; segments?: TranscriptSegment[] };
type StoredConversation = Omit<Conversation, 'messages'> & { messages: StoredMessage[] };
type ConversationMaterial = Material & { conversationId?: string; conversationVersion?: number; messageId?: string; messageHash?: string };
const now = () => new Date().toISOString();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const active = (c: Conversation) => ['responding', 'transcribing', 'preparing'].includes(c.status);
const operation = (c: Conversation): Conversation['errorOperation'] => c.status === 'preparing' || c.status === 'transcribing' || c.status === 'responding' ? c.status : null;
const versionSchema = z.object({ version: z.number().int().positive() });
const failed = (status: number, message: string): never => { throw new ConversationError(status, message); };
const lastUserIndex = (c: StoredConversation) => { for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === 'user') return i; return -1; };

/** Registered after authentication/CSRF and family selection. No assistant operation can write people, facts, or relations. */
export function registerConversations(app: Express, db: Database, blobs: LocalBlobStore, route: ArchiveContext['route'], overrides: Partial<ConversationAI> = {}) {
  const ai: ConversationAI = { available: isAiConfigured, reply: streamConversationReply, prepare: prepareConversationProposals, transcribe: transcribeFile, ...overrides };
  const operations = new Map<string, { controller: AbortController; familyId: string }>();
  let closed = false;
  // File snapshots in messages are refreshed on read, so a browser copy prepared later becomes visible.
  const freshFile = async (s: FamilyStore, file: UploadedFile | null | undefined) => { const record = file ? await s.get<FileRecord>('files', file.id) : undefined; return record ? clientFile(record) : file ?? null; };
  const clean = async (s: FamilyStore, c: StoredConversation): Promise<Conversation> => ({ ...c, messages: await Promise.all(c.messages.map(async ({ requestHash, segments, ...message }) => ({ ...message, file: await freshFile(s, message.file) }))) });
  const save = (s: FamilyStore, c: StoredConversation) => s.put('conversations', { ...c, updatedAt: now() });
  const get = async (s: FamilyStore, id: string) => (await s.get<StoredConversation>('conversations', id)) ?? failed(404, 'Разговор не найден.');
  const access = async (s: FamilyStore, id: string, account: User, write = false) => {
    const c = await get(s, id);
    if (c.createdBy !== account.id && account.role !== 'admin') failed(404, 'Разговор не найден.');
    if (write && account.role === 'viewer') failed(403, 'Наблюдатель может только смотреть.');
    // Administrators may read a private conversation, but only its author publishes or changes it.
    if (write && c.createdBy !== account.id) failed(403, 'Изменять разговор и сохранять его в архив может только автор.');
    return c;
  };
  const idleVersion = (c: StoredConversation, version: number) => {
    if (c.version !== version) failed(409, 'Разговор уже изменился. Обновите его и попробуйте снова.');
    if (active(c)) failed(409, 'Дождитесь завершения текущей обработки.');
  };
  const busy = () => operations.size >= 2;
  const capacity = () => { if (busy()) failed(429, 'Сейчас обрабатываются другие разговоры. Попробуйте через минуту.'); };
  const context = async (s: FamilyStore, c: StoredConversation, account: User) => ({ messages: (await clean(s, c)).messages, user: account, people: await s.all<Person>('people'), facts: await s.all<Fact>('facts'), relations: await s.all<Relation>('relations') });
  const interrupt = async (s: FamilyStore, c: StoredConversation) => {
    const error = 'Обработка прервана. Рассказ сохранён; повторите обработку вручную.';
    if (c.status === 'preparing' && c.materialId) {
      const material = await s.get<ConversationMaterial>('materials', c.materialId);
      if (material?.conversationId === c.id && material.extractionStatus === 'processing') await s.put('materials', { ...material, extractionStatus: 'error', processingError: error });
    }
    return save(s, { ...c, status: 'error', error, errorOperation: operation(c), messages: c.messages.map((m, i) => c.status === 'responding' && m.role === 'assistant' && i > lastUserIndex(c) ? { ...m, interrupted: true } : m) });
  };

  /** An explicit publication makes a fixed source, independent of subsequent conversation edits. */
  async function archive(s: FamilyStore, c: StoredConversation, account: User): Promise<StoredConversation> {
    if (!c.messages.some(m => m.role === 'user')) failed(400, 'Сначала добавьте рассказ или голосовое сообщение.');
    if (c.materialId && c.archivedVersion === c.version && await s.get('materials', c.materialId)) return c;
    const relatedMaterialIds: string[] = [];
    for (const message of c.messages) {
      if (message.role !== 'user' || !message.file) continue;
      const messageHash = digest(JSON.stringify([message.text, message.file.id, message.automatic, message.segments]));
      let material = (await s.where<ConversationMaterial>('materials', "data->>'conversationId' = $2 AND data->>'messageId' = $3 AND data->>'messageHash' = $4", c.id, message.id, messageHash))[0];
      if (!material) {
        material = await s.put<ConversationMaterial>('materials', {
          id: randomUUID(), title: `${c.title} · запись ${relatedMaterialIds.length + 1}`, kind: 'audio', body: '', narrator: '', occurredAt: '', personIds: [], file: message.file,
          createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: message.text ? 'done' : 'idle', extractionStatus: 'idle', processingError: null,
          transcript: message.text ? { text: message.text, segments: message.segments ?? [], version: 1, automatic: message.automatic ?? false, updatedAt: now() } : null,
          proposals: [], conversationId: c.id, messageId: message.id, messageHash,
        });
        await s.history('materials', material.id, account.id, 'archive_recording', null, material);
      }
      relatedMaterialIds.push(material.id);
    }
    const material = await s.put<ConversationMaterial>('materials', {
      id: randomUUID(), title: c.title, kind: 'story', body: conversationUserText(c.messages), narrator: '', occurredAt: '', personIds: [], file: null, relatedMaterialIds,
      createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: 'idle', extractionStatus: 'idle', processingError: null, transcript: null, proposals: [], conversationId: c.id, conversationVersion: c.version,
    });
    await s.history('materials', material.id, account.id, 'archive_conversation', null, material);
    return save(s, { ...c, materialId: material.id, archivedVersion: c.version });
  }

  /** Background work keeps its family: every write re-enters that family's transaction. */
  function launch(familyId: string, id: string, task: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    operations.set(id, { controller, familyId });
    void Promise.resolve().then(() => task(controller.signal)).catch(async error => {
      if (closed) return;
      try { await db.family(familyId, s => recordFailure(s, id, error)); } catch (failure) { console.error('Conversation state could not be saved:', failure instanceof Error ? failure.message : 'Unknown error'); }
    }).finally(() => operations.delete(id));
  }
  async function recordFailure(s: FamilyStore, id: string, error: unknown) {
    const c = await get(s, id);
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Не удалось обработать разговор. Попробуйте ещё раз.';
    await save(s, { ...c, status: 'error' as const, error: message, errorOperation: operation(c), messages: c.messages.map((m, i) => c.status === 'responding' && m.role === 'assistant' && i > lastUserIndex(c) ? { ...m, interrupted: true } : m) });
    if (c.status === 'preparing' && c.materialId) {
      const material = await s.get<Material>('materials', c.materialId);
      if (material?.extractionStatus === 'processing') await s.put('materials', { ...material, extractionStatus: 'error', processingError: message });
    }
  }

  async function reply(familyId: string, id: string, account: User, signal: AbortSignal) {
    if (!ai.available()) throw new Error('Ассистент ещё не подключён: администратору нужно настроить ключ API. Сообщение сохранено.');
    const inFamily = <T>(fn: (s: FamilyStore) => Promise<T>) => db.family(familyId, fn);
    let c = await inFamily(s => get(s, id));
    if (!c.messages[lastUserIndex(c)]) throw new Error('Сначала добавьте сообщение.');
    for (const pending of c.messages.filter(m => m.role === 'user' && m.file && !m.text.trim())) {
      const file = await inFamily(async s => { const file = await s.get<FileRecord>('files', pending.file!.id); if (file) await save(s, { ...await get(s, id), status: 'transcribing' }); return file; });
      if (!file) throw new Error('Исходная запись не найдена.');
      const result = await ai.transcribe(blobs.localPath(familyId, file.path), file.mime);
      if (closed || signal.aborted) return;
      const text = result.text.trim();
      if (!text) throw new Error('В записи не удалось распознать речь. Можно написать рассказ вручную.');
      // A paid transcript is kept even when the dialogue becomes too long for a reply.
      const { next, tooLong } = await inFamily(async s => {
        const latest = await get(s, id);
        const tooLong = conversationUserText(latest.messages).length + text.length > 120000;
        return { tooLong, next: await save(s, { ...latest, version: latest.version + 1, messages: latest.messages.map(m => m.id === pending.id ? { ...m, text, automatic: true, segments: result.segments } : m) }) };
      });
      c = next;
      if (tooLong) throw new Error('Расшифровка сохранена, но разговор стал слишком длинным для ответа ассистента. Сохраните его в архив и начните новый.');
    }
    const assistantId = randomUUID();
    const input = await inFamily(async s => {
      c = await save(s, { ...await get(s, id), status: 'responding', messages: [...(await get(s, id)).messages, { id: assistantId, role: 'assistant', text: '', createdAt: now() }] });
      return context(s, { ...c, messages: c.messages.filter(m => m.id !== assistantId) }, account);
    });
    let text = ''; let lastWrite = 0; let writing: Promise<unknown> = Promise.resolve();
    const flush = () => {
      if (closed || signal.aborted) return writing;
      lastWrite = Date.now(); const snapshot = text;
      writing = writing.then(() => inFamily(async s => { const latest = await get(s, id); await save(s, { ...latest, messages: latest.messages.map(m => m.id === assistantId ? { ...m, text: snapshot } : m) }); })).catch(() => {});
      return writing;
    };
    try {
      const result = await ai.reply(input, delta => { text += delta; if (Date.now() - lastWrite > 200) void flush(); }, signal);
      if (closed || signal.aborted) return;
      text = result; await flush();
      await inFamily(async s => save(s, { ...await get(s, id), status: 'idle', error: null, errorOperation: null }));
    } catch (error) { await flush(); throw error; }
  }

  app.get('/api/conversations', route(async (s, _req, res) => {
    const account = actor(res);
    return (await s.all<StoredConversation>('conversations')).filter(c => c.createdBy === account.id || account.role === 'admin').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length }));
  }));
  app.post('/api/conversations', route(async (s, req, res) => {
    const account = actor(res);
    if (account.role === 'viewer') failed(403, 'Наблюдатель может только смотреть.');
    const { title } = z.object({ title: z.string().trim().min(1).max(180).optional() }).parse(req.body);
    const c = await s.put<StoredConversation>('conversations', { id: randomUUID(), title: title || 'Новый разговор', createdBy: account.id, createdAt: now(), updatedAt: now(), version: 1, messages: [], status: 'idle', error: null, errorOperation: null, materialId: null, archivedVersion: null });
    res.status(201); return clean(s, c);
  }));
  app.get('/api/conversations/:id', route(async (s, req, res) => clean(s, await access(s, String(req.params.id), actor(res)))));
  app.post('/api/conversations/:id/messages', route(async (s, req, res) => {
    const account = actor(res);
    const input = versionSchema.extend({ id: z.uuid(), text: z.string().trim().max(20000), fileId: z.string().min(1).optional() }).parse(req.body);
    let c = await access(s, String(req.params.id), account, true);
    const requestHash = digest(JSON.stringify([input.text, input.fileId ?? null]));
    const existing = c.messages.find(m => m.id === input.id);
    // Idempotency precedes version/busy checks: a lost HTTP response must not duplicate the message.
    if (existing) {
      if (existing.requestHash !== requestHash) failed(409, 'Это сообщение уже сохранено с другим содержимым.');
      return clean(s, c);
    }
    idleVersion(c, input.version);
    if (!input.text && !input.fileId) failed(400, 'Напишите сообщение или добавьте голосовую запись.');
    if (c.messages.length >= 198 || conversationUserText(c.messages).length + input.text.length > 120000) failed(400, 'Разговор достаточно длинный. Сохраните его и начните новый.');
    const file = input.fileId ? await s.get<FileRecord>('files', input.fileId) : null;
    if (input.fileId && (!file || (file.createdBy !== account.id && account.role !== 'admin'))) failed(404, 'Запись не найдена. Загрузите её заново.');
    if (file && !file.mime.startsWith('audio/')) failed(400, 'К сообщению можно прикрепить аудиозапись.');
    if (file && input.text) failed(400, 'Отправьте запись и текст отдельными сообщениями, чтобы сохранить точную расшифровку.');
    // The person's words are saved first; a busy assistant only postpones the reply.
    const postponed = busy();
    const nextStatus = file ? 'transcribing' as const : 'responding' as const;
    c = await save(s, { ...c, title: c.messages.length ? c.title : input.text ? input.text.slice(0, 65) + (input.text.length > 65 ? '…' : '') : `Разговор от ${new Intl.DateTimeFormat('ru-RU').format(new Date())}`, version: c.version + 1,
      ...(postponed ? { status: 'error' as const, error: 'Сообщение сохранено. Ассистент сейчас занят другими разговорами — запросите ответ через минуту.', errorOperation: nextStatus } : { status: nextStatus, error: null, errorOperation: null }),
      messages: [...c.messages, { id: input.id, role: 'user', text: input.text, createdAt: now(), file: file ? clientFile(file) : null, automatic: false, requestHash }] });
    // Launch after the response is committed: the background task opens its own transaction.
    if (!postponed) res.once('finish', () => launch(s.familyId, c.id, signal => reply(familyOf(res), c.id, account, signal)));
    res.status(202); return clean(s, c);
  }));
  app.patch('/api/conversations/:id/messages/:messageId', route(async (s, req, res) => {
    const account = actor(res); const c = await access(s, String(req.params.id), account, true);
    const input = versionSchema.extend({ text: z.string().trim().min(1).max(120000) }).parse(req.body);
    idleVersion(c, input.version);
    const index = lastUserIndex(c);
    if (index < 0 || c.messages[index].id !== req.params.messageId) failed(409, 'Можно исправить только последнее своё сообщение.');
    const messages = c.messages.slice(0, index + 1).map((m, i) => i === index ? { ...m, text: input.text, automatic: false, segments: [] } : m);
    if (conversationUserText(messages).length > 120000) failed(400, 'Разговор слишком длинный. Сократите текст или начните новый.');
    const previous = c.messages[index];
    // The earlier wording (and any automatic transcript) stays recoverable from history.
    await s.history('conversations', c.id, account.id, 'edit_message', { messageId: previous.id, text: previous.text, automatic: previous.automatic ?? false, segments: previous.segments ?? [] }, { messageId: previous.id, text: input.text });
    return clean(s, await save(s, { ...c, messages, version: c.version + 1, status: 'idle', error: null, errorOperation: null }));
  }));
  app.post('/api/conversations/:id/retry', route(async (s, req, res) => {
    const account = actor(res); let c = await access(s, String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version); capacity();
    const index = lastUserIndex(c); if (index < 0) failed(400, 'Сначала добавьте сообщение.');
    c = await save(s, { ...c, messages: c.messages.slice(0, index + 1), status: c.messages[index].file && !c.messages[index].text ? 'transcribing' : 'responding', error: null, errorOperation: null });
    res.once('finish', () => launch(s.familyId, c.id, signal => reply(familyOf(res), c.id, account, signal)));
    res.status(202); return clean(s, c);
  }));
  app.post('/api/conversations/:id/archive', route(async (s, req, res) => {
    const account = actor(res); const c = await access(s, String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version);
    return clean(s, await archive(s, c, account));
  }));
  app.post('/api/conversations/:id/prepare', route(async (s, req, res) => {
    const account = actor(res); let c = await access(s, String(req.params.id), account, true);
    const input = versionSchema.parse(req.body); idleVersion(c, input.version); capacity();
    if (!ai.available()) failed(503, 'Поиск сведений ещё не подключён. Рассказ можно сохранить в архив без обработки.');
    if (c.messages.some(m => m.role === 'user' && m.file && !m.text.trim())) failed(400, 'Сначала расшифруйте все записи или добавьте их текст. Записи без текста можно сохранить в архив.');
    if (!conversationUserText(c.messages).trim()) failed(400, 'Сначала добавьте текст рассказа.');
    c = await archive(s, c, account);
    const material = (await s.get<Material>('materials', c.materialId!))!;
    if (material.extractionStatus === 'done') return clean(s, await save(s, { ...c, status: 'idle', error: null, errorOperation: null }));
    if (['queued', 'processing'].includes(material.extractionStatus)) failed(409, 'Рассказ уже обрабатывается в архиве. Дождитесь результата.');
    const source = await context(s, c, account);
    if (material.body !== conversationUserText(c.messages) || material.transcript) failed(409, 'Рассказ был отредактирован в архиве. Запустите поиск сведений в его карточке.');
    c = await save(s, { ...c, status: 'preparing', error: null, errorOperation: null });
    await s.put('materials', { ...material, extractionStatus: 'processing', extractionRejectedCount: 0, processingError: null });
    const familyId = s.familyId; const conversationId = c.id;
    res.once('finish', () => launch(familyId, conversationId, async signal => {
      const result = await ai.prepare(source);
      if (closed || signal.aborted) return;
      await db.family(familyId, async store => {
        const latest = (await store.get<Material>('materials', material.id))!;
        if (latest.version !== material.version || latest.body !== material.body || latest.transcript) throw new Error('Рассказ изменился во время обработки. Запустите поиск сведений в архиве.');
        const proposals: Proposal[] = result.proposals.map(p => ({ ...p, id: randomUUID(), status: 'pending', baseVersion: p.action === 'set_fact' && p.personId && p.key ? source.facts.find(f => f.personId === p.personId && f.key === p.key)?.version ?? null : null }));
        const after = await store.put<Material>('materials', { ...latest, extractionStatus: 'done', extractionRejectedCount: result.rejectedCount, processingError: null, proposals: [...(latest.proposals ?? []).map(p => p.status === 'pending' ? { ...p, status: 'rejected' as const } : p), ...proposals], version: latest.version + 1, updatedAt: now() });
        await store.history('materials', after.id, account.id, 'extract_conversation', latest, after);
        await save(store, { ...await get(store, conversationId), status: 'idle', error: null, errorOperation: null });
      });
    }));
    res.status(202); return clean(s, c);
  }));
  return {
    /** Never automatically repeat a potentially paid request on startup or restore. */
    async recover() {
      const rows = await db.system(g => g.raw("SELECT family_id, data FROM conversations WHERE data->>'status' IN ('responding', 'transcribing', 'preparing')"));
      for (const row of rows) await db.family(row.family_id as string, async s => { const c = await s.get<StoredConversation>('conversations', (row.data as StoredConversation).id); if (c && active(c)) await interrupt(s, c); });
    },
    async close() {
      closed = true;
      for (const [id, { controller, familyId }] of operations) { controller.abort(); await db.family(familyId, async s => { const c = await s.get<StoredConversation>('conversations', id); if (c && active(c)) await interrupt(s, c); }).catch(() => {}); }
    },
  };
}
