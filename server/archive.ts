import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { Database, FamilyStore } from './db.js';
import { isAiConfigured, transcribeFile, extractProposals } from './ai.js';
import { identifyMedia, createPreview, MediaError } from './media.js';
import { clientFile, DurableUploadStorage, previewReady, storageStatus, type FileRecord, type LocalBlobStore, type StoredUpload } from './files.js';
import { actor, familyOf, fail, hash, now, owned, requireVersion, writable, type Membership } from './http.js';
import type { User, Person, Fact, Relation, Reviewed, Material, UploadedFile, Proposal, FactKey, HistoryEntry, Transcript, NameParts } from '../shared/types.js';
import { cleanNameParts, fullName, NAME_PART_MAX_LENGTH, dateInputError, formatFamilyDate, isDateFact } from '../shared/person-fields.js';

export type Job = { id: string; materialId: string; actorId: string; type: 'transcribe' | 'extract'; status: 'queued' | 'processing' | 'done' | 'error'; sourceVersion: number | null; sourceHash: string; createdAt: string; error?: string };
export interface ArchiveContext {
  app: Express; db: Database; blobs: LocalBlobStore; incoming: string; maxUploadMb: number; minFreeBytes: number; familyLimitBytes: number | null;
  /** Runs a handler inside the current family's transaction and sends its result as JSON. */
  route: (handler: (store: FamilyStore, req: Request, res: Response) => Promise<unknown>) => RequestHandler;
}

export const factKey = z.enum(['name', 'previousName', 'birthDate', 'deathDate', 'place', 'bio']);
export const relationSchema = z.object({ fromId: z.string().min(1), toId: z.string().min(1), type: z.enum(['parent', 'partner']), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).default('unspecified'), source: z.string().max(5000).default('') });
export const namePartsSchema = z.object({ firstName: z.string().max(NAME_PART_MAX_LENGTH).default(''), lastName: z.string().max(NAME_PART_MAX_LENGTH).default(''), patronymic: z.string().max(NAME_PART_MAX_LENGTH).default('') });
const textValue = z.string().trim().min(1).max(10000);
const versionSchema = z.number().int().positive();
const PREVIEW_INTERRUPTED = 'Подготовка просмотра несколько раз прерывалась. Оригинал сохранён и доступен для скачивания.';

function checkedDate(value: string): string { const error = dateInputError(value); if (error) fail(400, error); return formatFamilyDate(value.trim()); }
function factFields(key: FactKey, rawValue: string | undefined, parts?: NameParts, previous?: Fact): Pick<Fact, 'value' | 'nameParts'> {
  if (parts && key !== 'name') fail(400, 'Отдельные части ФИО можно сохранить только в поле имени.');
  const nameParts = parts ? cleanNameParts(parts) : key === 'name' && rawValue === previous?.value ? previous?.nameParts : undefined;
  const value = parts ? fullName(parts) : rawValue?.trim() ?? '';
  if (!value) fail(400, key === 'name' ? 'Укажите хотя бы одну известную часть имени.' : 'Укажите значение сведения.');
  return { value: isDateFact(key) ? checkedDate(value) : value, ...(key === 'name' ? { nameParts } : {}) };
}
export const sourceText = (material: Material) => material.transcript?.text ?? (material.kind === 'story' ? material.body : '');
export const invalidatePending = (proposals: Proposal[] = []): Proposal[] => proposals.map(item => item.status === 'pending' ? { ...item, status: 'rejected' } : item);
export async function found<T>(promise: Promise<T | undefined>): Promise<T> { return (await promise) ?? fail(404, 'Запись не найдена.'); }
export async function freshFile(s: FamilyStore, file: UploadedFile | null | undefined) { const record = file ? await s.get<FileRecord>('files', file.id) : undefined; return record ? clientFile(record) : file ?? null; }

/** Tree mutations shared by manual editing and accepted proposals; all run inside the caller's family transaction. */
function tree(s: FamilyStore) {
  const reviewed = (user: User, source = '', extra: Partial<Reviewed> = {}): Reviewed => ({ id: randomUUID(), version: 1, status: 'unconfirmed', createdBy: user.id, updatedBy: user.id, createdAt: now(), updatedAt: now(), confirmedBy: null, confirmedAt: null, source, disputedBy: null, disputeNote: null, ...extra });
  const revised = <T extends Reviewed>(record: T, user: User, changes: Partial<T>): T => ({ ...record, ...changes, version: record.version + 1, updatedBy: user.id, updatedAt: now(), status: 'unconfirmed', confirmedBy: null, confirmedAt: null, disputedBy: null, disputeNote: null });
  const syncName = async (fact: Fact) => { if (fact.key === 'name') await s.put('people', { ...await found(s.get<Person>('people', fact.personId)), name: fact.value, nameParts: fact.nameParts }); };
  const findFact = async (personId: string, key: FactKey) => (await s.where<Fact>('facts', "data->>'personId' = $2 AND data->>'key' = $3", personId, key))[0];
  async function newFact(user: User, personId: string, key: FactKey, value: string | undefined, source = '', provenance: Partial<Reviewed> = {}, nameParts?: NameParts) {
    await found(s.get<Person>('people', personId));
    if (await findFact(personId, key)) fail(409, 'Это поле уже заполнено. Отредактируйте существующее сведение.');
    const fact = await s.put<Fact>('facts', { ...reviewed(user, source, provenance), personId, key, ...factFields(key, value, nameParts) });
    await syncName(fact);
    await s.history('facts', fact.id, user.id, 'create', null, fact); return fact;
  }
  async function newPerson(user: User, personName: string | undefined, source = '', provenance: Partial<Reviewed> = {}, nameParts?: NameParts) {
    const fields = factFields('name', personName, nameParts);
    const person = await s.put<Person>('people', { id: randomUUID(), name: fields.value, nameParts: fields.nameParts, avatarFileId: null, createdBy: user.id, createdAt: now() });
    await newFact(user, person.id, 'name', fields.value, source, provenance, fields.nameParts); return person;
  }
  async function validateRelation(input: z.infer<typeof relationSchema>, except?: string) {
    await found(s.get<Person>('people', input.fromId)); await found(s.get<Person>('people', input.toId));
    if (input.fromId === input.toId) fail(400, 'Нельзя связать человека с самим собой.');
    const relations = (await s.all<Relation>('relations')).filter(item => item.id !== except);
    if (relations.some(item => item.type === input.type && ((item.fromId === input.fromId && item.toId === input.toId) || (input.type === 'partner' && item.fromId === input.toId && item.toId === input.fromId)))) fail(409, 'Такая связь уже существует.');
    if (input.type === 'parent') {
      const seen = new Set<string>(); const queue = [input.toId];
      while (queue.length) {
        const id = queue.pop()!;
        if (id === input.fromId) fail(409, 'Эта связь создаёт круг: человек не может быть собственным предком.');
        if (seen.has(id)) continue; seen.add(id);
        for (const item of relations) if (item.type === 'parent' && item.fromId === id) queue.push(item.toId);
      }
    }
  }
  async function newRelation(user: User, input: z.infer<typeof relationSchema>, provenance: Partial<Reviewed> = {}) {
    await validateRelation(input);
    const relation = await s.put<Relation>('relations', { ...reviewed(user, input.source, provenance), ...input });
    await s.history('relations', relation.id, user.id, 'create', null, relation); return relation;
  }
  return { revised, syncName, findFact, newFact, newPerson, validateRelation, newRelation };
}

export function registerTree({ app, route }: ArchiveContext) {
  app.post('/api/people', route(async (s, req, res) => {
    const user = actor(res); writable(user);
    const input = z.object({ name: z.string().trim().max(302).optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000).default(''), facts: z.partialRecord(factKey, z.string().trim().max(10000)).optional(), relation: z.object({ relativeId: z.string(), type: z.enum(['parent', 'child', 'partner']), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).optional() }).optional() }).parse(req.body);
    const t = tree(s);
    const person = await t.newPerson(user, input.name, input.source, {}, input.nameParts);
    for (const [key, value] of Object.entries(input.facts ?? {})) if (key !== 'name' && value) await t.newFact(user, person.id, key as FactKey, value, input.source);
    if (input.relation) {
      const { relativeId, type, parentKind } = input.relation;
      await t.newRelation(user, { fromId: type === 'child' ? relativeId : person.id, toId: type === 'child' ? person.id : relativeId, type: type === 'partner' ? 'partner' : 'parent', parentKind: parentKind ?? 'unspecified', source: input.source });
    }
    res.status(201); return person;
  }));
  app.patch('/api/people/:id', route(async (s, req, res) => {
    const user = actor(res); const before = await found(s.get<Person>('people', String(req.params.id))); owned(before, user);
    const input = z.object({ avatarFileId: z.string().nullable() }).parse(req.body);
    if (input.avatarFileId) { const file = await found(s.get<FileRecord>('files', input.avatarFileId)); if (!file.mime.startsWith('image/')) fail(400, 'Для портрета нужна фотография.'); if (file.createdBy !== user.id && user.role !== 'admin') fail(403, 'Выберите загруженный вами файл.'); }
    const after = await s.put('people', { ...before, ...input }); await s.history('people', after.id, user.id, 'edit', before, after); return after;
  }));
  app.post('/api/facts', route(async (s, req, res) => {
    const user = actor(res); writable(user);
    const input = z.object({ personId: z.string(), key: factKey, value: textValue.optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000).default(''), sourceMaterialId: z.string().nullable().optional() }).parse(req.body);
    if (input.sourceMaterialId) await found(s.get<Material>('materials', input.sourceMaterialId));
    res.status(201); return tree(s).newFact(user, input.personId, input.key, input.value, input.source, { sourceMaterialId: input.sourceMaterialId }, input.nameParts);
  }));
  app.patch('/api/facts/:id', route(async (s, req, res) => {
    const input = z.object({ value: textValue.optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000), version: versionSchema }).parse(req.body); const user = actor(res);
    const t = tree(s);
    const before = await found(s.get<Fact>('facts', String(req.params.id))); owned(before, user); requireVersion(before.version, input.version);
    const fields = factFields(before.key, input.value, input.nameParts, before);
    const after = await s.put('facts', t.revised(before, user, { ...fields, source: input.source, ...(before.sourceQuote && fields.value !== before.value ? { sourceEdited: true } : {}) }));
    await t.syncName(after);
    await s.history('facts', after.id, user.id, 'edit', before, after); return after;
  }));
  app.post('/api/relations', route(async (s, req, res) => { const user = actor(res); writable(user); const input = relationSchema.parse(req.body); res.status(201); return tree(s).newRelation(user, input); }));
  app.patch('/api/relations/:id', route(async (s, req, res) => {
    const input = relationSchema.extend({ version: versionSchema }).parse(req.body); const user = actor(res); const t = tree(s);
    const before = await found(s.get<Relation>('relations', String(req.params.id))); owned(before, user); requireVersion(before.version, input.version); await t.validateRelation(input, before.id);
    const after = await s.put('relations', t.revised(before, user, { fromId: input.fromId, toId: input.toId, type: input.type, parentKind: input.parentKind, source: input.source }));
    await s.history('relations', after.id, user.id, 'edit', before, after); return after;
  }));
  app.post('/api/review/:kind/:id', route(async (s, req, res) => {
    const kind = z.enum(['facts', 'relations']).parse(req.params.kind); const user = actor(res); writable(user);
    const input = z.object({ action: z.enum(['confirm', 'dispute']), version: versionSchema, note: z.string().trim().max(2000).optional() }).parse(req.body);
    const before = await found(s.get<Fact | Relation>(kind, String(req.params.id))); requireVersion(before.version, input.version);
    if (input.action === 'confirm' && before.updatedBy === user.id) fail(403, 'Ваше изменение должен подтвердить другой участник.');
    if (input.action === 'confirm' && before.status === 'disputed') fail(409, 'Сначала нужно исправить спорное сведение.');
    if (input.action === 'dispute' && !input.note) fail(400, 'Напишите, что кажется неточным.');
    if (input.action === 'confirm' && before.status === 'confirmed') return before;
    const after = await s.put(kind, { ...before, status: input.action === 'confirm' ? 'confirmed' : 'disputed', confirmedBy: input.action === 'confirm' ? user.id : null, confirmedAt: input.action === 'confirm' ? now() : null, disputedBy: input.action === 'dispute' ? user.id : null, disputeNote: input.action === 'dispute' ? input.note : null });
    await s.history(kind, before.id, user.id, input.action, before, after); return after;
  }));
  app.get('/api/history/:kind/:id', route(async (s, req) => {
    const kind = z.enum(['facts', 'relations', 'materials', 'people']).parse(req.params.kind); const id = String(req.params.id);
    await found(s.get(kind, id));
    return s.where<HistoryEntry>('history', "data->>'entityType' = $2 AND data->>'entityId' = $3", kind, id);
  }));
}

export function registerArchive(ctx: ArchiveContext, media: { kick(): void }) {
  const { app, db, blobs, route } = ctx;
  const upload = multer({ storage: new DurableUploadStorage(ctx.incoming), defParamCharset: 'utf8', limits: { fileSize: ctx.maxUploadMb * 1024 * 1024, files: 1, fields: 0 } });
  const familyBytes = async (s: FamilyStore) => Number((await s.raw("SELECT coalesce(sum((data->>'size')::bigint + coalesce((data->>'previewSize')::bigint, 0)), 0) AS n FROM files WHERE family_id = $1", [s.familyId]))[0].n);
  const acceptingUploads = async (req: Request, res: Response, next: NextFunction) => {
    try {
      writable(actor(res));
      const declared = Number(req.get('content-length')) || 0;
      const disk = storageStatus(ctx.incoming, ctx.minFreeBytes);
      if (disk.freeBytes !== null && disk.freeBytes - declared < ctx.minFreeBytes) fail(507, 'На сервере заканчивается место. Файл не принят; сообщите администратору.');
      if (ctx.familyLimitBytes !== null && await db.family(familyOf(res), familyBytes) + declared > ctx.familyLimitBytes) fail(507, 'Место для файлов этой семьи закончилось. Файл не принят; сообщите администратору семьи.');
      next();
    } catch (error) {
      // Drain the unread body so the browser receives this message instead of a connection reset.
      req.resume(); req.once('end', () => next(error)); req.once('error', () => next(error));
    }
  };
  // The original is committed as soon as it is durable and recognised; browser copies follow in the background.
  app.post('/api/files', acceptingUploads, upload.single('file'), async (req, res) => {
    const file = req.file as StoredUpload | undefined; if (!file) fail(400, 'Выберите файл.');
    const familyId = familyOf(res); let committed: string | undefined;
    try {
      const media_ = await identifyMedia(file.path);
      committed = await blobs.commit(file, familyId);
      const id = randomUUID();
      const record: FileRecord = { id, name: file.originalname.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'Файл', mime: media_.mime, size: file.size, sha256: file.sha256, url: `/api/files/${id}`, createdBy: actor(res).id, path: committed, createdAt: now(), previewStatus: media_.needsPreview ? 'pending' : 'none', previewAttempts: 0 };
      await db.family(familyId, async s => { await s.put('files', record); await s.history('files', id, record.createdBy, 'upload', null, { name: record.name, mime: record.mime, size: record.size, sha256: record.sha256 }); });
      res.status(201).json(clientFile(record));
      if (media_.needsPreview) media.kick();
    } catch (error) { await (committed ? blobs.remove(familyId, committed) : unlink(file.path).catch(() => {})); throw error; }
  });
  /** Media URLs carry no family header (img/audio src): the file names its family, then membership is checked. */
  app.get(['/api/files/:id', '/api/files/:id/original'], async (req, res, next) => {
    const user = res.locals.user as User;
    const owner = (await db.system(g => g.raw('SELECT family_id FROM files WHERE id = $1', [String(req.params.id)])))[0]?.family_id as string | undefined;
    if (!owner) fail(404, 'Файл не найден.');
    const file = await db.family(owner, async s => {
      const membership = (await s.global.where<Membership>('memberships', 'family_id = $1 AND user_id = $2', owner, user.id))[0];
      if (!membership || membership.status !== 'active') return undefined;
      const record = await s.get<FileRecord>('files', String(req.params.id));
      // Indexed lookups: media players issue many range requests per playback.
      if (!record || (record.createdBy !== user.id && membership.role !== 'admin' && !await s.exists('materials', "data->'file'->>'id' = $2", record.id) && !await s.exists('people', "data->>'avatarFileId' = $2", record.id))) return undefined;
      return record;
    });
    if (!file) fail(404, 'Файл не найден.');
    const original = req.query.original === '1' || req.path.endsWith('/original');
    const preview = !original && previewReady(file);
    const size = preview ? file.previewSize! : file.size;
    const mime = preview ? file.previewMime! : file.mime;
    const name = preview ? file.previewPath! : file.path;
    const displayName = preview ? file.name.replace(/\.[^.]*$/, '') + (mime === 'image/jpeg' ? '.jpg' : mime === 'audio/mpeg' ? '.mp3' : '.mp4') : file.name;
    res.set({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': `${original ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(displayName).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
    let start = 0; let end = size - 1;
    const range = req.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; }
      if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; } start = Math.max(0, size - suffix); }
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || start < 0) { res.set('Content-Range', `bytes */${size}`); res.status(416).end(); return; }
      res.status(206); res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    const stream = blobs.read(owner, name, { start, end }) as NodeJS.ReadableStream & { destroy(): void; on(event: 'error', listener: (error: Error) => void): void };
    stream.on('error', error => { if (res.headersSent) res.destroy(); else next(error); });
    res.on('close', () => stream.destroy()); stream.pipe(res);
  });
  const materialFields = z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(1000000).default(''), narrator: z.string().max(200).default(''), occurredAt: z.string().max(200).default('').transform(checkedDate), personIds: z.array(z.string()).max(1000).default([]) });
  app.post('/api/materials', route(async (s, req, res) => {
    const user = actor(res); writable(user);
    const input = materialFields.extend({ kind: z.enum(['story', 'photo', 'audio', 'video']), fileId: z.string().nullable().optional() }).parse(req.body);
    for (const id of input.personIds) await found(s.get<Person>('people', id));
    const file = input.fileId ? await found(s.get<FileRecord>('files', input.fileId)) : null;
    if (file && file.createdBy !== user.id && user.role !== 'admin') fail(403, 'Выберите загруженный вами файл.');
    if (input.kind !== 'story' && !file) fail(400, 'Для этого материала нужен файл.');
    if (file && ((input.kind === 'photo' && !file.mime.startsWith('image/')) || (input.kind === 'audio' && !file.mime.startsWith('audio/')) || (input.kind === 'video' && !file.mime.startsWith('video/')) || (input.kind === 'story' && !file.mime.startsWith('image/')))) fail(400, 'Тип материала не соответствует файлу.');
    const record = await s.put<Material>('materials', { id: randomUUID(), title: input.title, kind: input.kind, body: input.body, narrator: input.narrator, occurredAt: input.occurredAt, personIds: [...new Set(input.personIds)], file: file ? clientFile(file) : null, createdBy: user.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: 'idle', extractionStatus: 'idle', extractionRejectedCount: 0, processingError: null, transcript: null, proposals: [] });
    await s.history('materials', record.id, user.id, 'create', null, record);
    res.status(201); return record;
  }));
  app.get('/api/materials/:id', route(async (s, req) => { const material = await found(s.get<Material>('materials', String(req.params.id))); return { ...material, file: await freshFile(s, material.file) }; }));
  app.patch('/api/materials/:id', route(async (s, req, res) => {
    const user = actor(res); const input = materialFields.partial().extend({ version: versionSchema }).parse(req.body);
    const before = await found(s.get<Material>('materials', String(req.params.id))); owned(before, user); requireVersion(before.version, input.version);
    const { version: _version, ...parsedFields } = input;
    // Zod defaults also run inside partial objects; omitted PATCH fields must stay intact.
    const fields = Object.fromEntries(Object.entries(parsedFields).filter(([key]) => Object.hasOwn(req.body, key))) as typeof parsedFields;
    for (const id of fields.personIds ?? []) await found(s.get<Person>('people', id));
    const bodyChanged = fields.body !== undefined && fields.body !== before.body;
    const after = await s.put<Material>('materials', { ...before, ...fields, personIds: fields.personIds ? [...new Set(fields.personIds)] : before.personIds, version: before.version + 1, updatedAt: now(), ...(bodyChanged && !before.transcript ? { proposals: invalidatePending(before.proposals), extractionStatus: 'idle' as const, extractionRejectedCount: 0, processingError: null } : {}) });
    await s.history('materials', after.id, user.id, 'edit', before, after); return after;
  }));
  app.patch('/api/materials/:id/transcript', route(async (s, req, res) => {
    const input = z.object({ text: z.string().max(1000000), version: z.number().int().nonnegative() }).parse(req.body); const user = actor(res);
    const before = await found(s.get<Material>('materials', String(req.params.id))); owned(before, user);
    requireVersion(before.transcript?.version ?? 0, input.version);
    // Edited text no longer shares reliable timestamps with automatic segments.
    const transcript: Transcript = { text: input.text, segments: [], version: (before.transcript?.version ?? 0) + 1, automatic: false, updatedAt: now() };
    const after = await s.put<Material>('materials', { ...before, transcript, proposals: invalidatePending(before.proposals), transcriptionStatus: 'done', extractionStatus: 'idle', extractionRejectedCount: 0, processingError: null, version: before.version + 1, updatedAt: now() });
    await s.history('materials', after.id, user.id, 'edit_transcript', before, after); return after;
  }));
  for (const type of ['transcribe', 'extract'] as const) app.post(`/api/materials/:id/${type}`, route(async (s, req, res) => {
    const user = actor(res);
    const material = await found(s.get<Material>('materials', String(req.params.id))); owned(material, user);
    if (!isAiConfigured()) fail(503, 'Обработка недоступна: администратору нужно настроить ключ API.');
    if (type === 'transcribe' && (!material.file || !['audio', 'video'].includes(material.kind))) fail(400, 'Расшифровка доступна для аудио и видео.');
    if (type === 'extract' && !sourceText(material).trim()) fail(400, 'Сначала создайте расшифровку или добавьте текст истории.');
    if (['queued', 'processing'].includes(material.extractionStatus) || ['queued', 'processing'].includes(material.transcriptionStatus)) fail(409, 'Материал уже обрабатывается. Дождитесь результата.');
    if (await s.exists('jobs', "data->>'materialId' = $2 AND data->>'status' IN ('queued', 'processing')", material.id)) fail(409, 'Материал уже обрабатывается. Дождитесь результата.');
    await s.put<Job>('jobs', { id: randomUUID(), materialId: material.id, actorId: user.id, type, status: 'queued', sourceVersion: material.transcript?.version ?? null, sourceHash: hash(sourceText(material)), createdAt: now() });
    await s.put<Material>('materials', { ...material, [type === 'transcribe' ? 'transcriptionStatus' : 'extractionStatus']: 'queued', processingError: null });
    return { ok: true };
  }));
  const nullableId = z.string().min(1).nullable();
  const proposalSchema = z.object({ id: z.string().min(1), action: z.enum(['create_person', 'set_fact', 'create_relation', 'link_material']), status: z.enum(['pending', 'accepted', 'rejected']), personId: nullableId, personName: z.string().max(302).nullable(), nameParts: namePartsSchema.optional(), key: factKey.nullable(), value: z.string().max(10000).nullable(), fromId: nullableId, toId: nullableId, fromName: z.string().max(302).nullable(), toName: z.string().max(302).nullable(), relationType: z.enum(['parent', 'partner']).nullable(), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).nullable(), sourceQuote: z.string().max(20000), sourceStart: z.number().nonnegative().nullable(), sourceEnd: z.number().nonnegative().nullable(), baseVersion: versionSchema.nullable() });
  app.post('/api/materials/:id/proposals', route(async (s, req, res) => {
    const input = z.object({ accept: z.array(proposalSchema).max(200), reject: z.array(z.string()).max(200), transcriptVersion: versionSchema.nullable() }).parse(req.body); const user = actor(res);
    const t = tree(s);
    const before = await found(s.get<Material>('materials', String(req.params.id))); owned(before, user);
    const proposals = before.proposals ?? [];
    const submitted = [...input.accept.map(p => p.id), ...input.reject];
    if (new Set(submitted).size !== submitted.length) fail(400, 'Предложение нельзя принять и отклонить одновременно.');
    for (const id of submitted) if (!proposals.some(item => item.id === id)) fail(400, 'Предложение не найдено в этом материале.');
    const accepted = input.accept.filter(item => proposals.find(p => p.id === item.id)?.status === 'pending');
    const rejected = input.reject.filter(id => proposals.find(p => p.id === id)?.status === 'pending');
    if (!accepted.length && !rejected.length) return before;
    if ((before.transcript?.version ?? null) !== input.transcriptVersion) fail(409, 'Расшифровка изменилась. Запросите новые предложения.');
    for (const item of accepted) if (item.action !== proposals.find(p => p.id === item.id)!.action) fail(400, 'Тип предложения нельзя менять.');
    const nameMap = new Map<string, string>();
    const createdPeople = new Set<string>();
    const links = new Set(before.personIds);
    const normalized = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
    for (const item of proposals) if (item.status === 'accepted' && item.action === 'create_person' && item.personId && item.personName) nameMap.set(normalized(item.personName), item.personId);
    const originalFor = (proposal: Proposal) => proposals.find(item => item.id === proposal.id)!;
    const provenance = (proposal: Proposal): Partial<Reviewed> => { const original = originalFor(proposal); return { sourceMaterialId: before.id, sourceQuote: original.sourceQuote, sourceStart: original.sourceStart }; };
    const resolve = async (id: string | null, personName: string | null) => {
      if (id) return (await found(s.get<Person>('people', id))).id;
      const resolved = personName ? nameMap.get(normalized(personName)) : undefined;
      if (!resolved) fail(400, `Выберите человека${personName ? ` «${personName}»` : ''} или примите предложение о его создании.`);
      return resolved;
    };
    // Explicit creation/resolution first makes related proposals independent of list order.
    for (const item of accepted.filter(p => p.action === 'create_person')) {
      const personName = (item.nameParts ? fullName(item.nameParts) : item.personName?.trim()) || (item.personId ? (await found(s.get<Person>('people', item.personId))).name : '');
      if (!personName) fail(400, 'Укажите имя нового человека.');
      const normalizedName = normalized(personName);
      // The same name may already point to this very person (re-extraction, or two quotes about one relative).
      const mapped = nameMap.get(normalizedName);
      if (mapped && mapped !== item.personId) fail(409, 'Два предложения создают одинаковое имя. Выберите существующего человека или уточните имена.');
      const person = item.personId ? await found(s.get<Person>('people', item.personId)) : await t.newPerson(user, personName, before.title, provenance(item), item.nameParts);
      if (!item.personId) createdPeople.add(person.id);
      nameMap.set(normalizedName, person.id);
      const originalName = originalFor(item).personName;
      if (originalName && !nameMap.has(normalized(originalName))) nameMap.set(normalized(originalName), person.id);
      item.personId = person.id; item.personName = personName; if (item.nameParts) item.nameParts = cleanNameParts(item.nameParts); links.add(person.id);
    }
    const factTargets = new Set<string>();
    for (const item of accepted) {
      if (item.action === 'create_person') continue;
      if (item.action === 'set_fact') {
        const personId = await resolve(item.personId, item.personName); item.personId = personId;
        const key = factKey.parse(item.key);
        if (factTargets.has(`${personId}:${key}`)) fail(409, 'Два выбранных предложения меняют одно и то же сведение. Оставьте одно из них.');
        factTargets.add(`${personId}:${key}`);
        const current = await t.findFact(personId, key);
        const fields = factFields(key, item.value ?? undefined, item.nameParts, current); item.value = fields.value; item.nameParts = fields.nameParts;
        const original = originalFor(item);
        // A reviewer may correct a suggestion; the quote then no longer proves the stored value verbatim.
        const sourceEdited = original.key !== key || normalized(original.value ?? '') !== normalized(fields.value);
        if (current) {
          owned(current, user);
          // Resolving an ambiguous name or deliberately selecting another field uses
          // the version the user just reviewed; the original target cannot rebase itself.
          const expectedVersion = original.personId === personId && original.key === key ? original.baseVersion : item.baseVersion;
          if (!createdPeople.has(personId) && expectedVersion !== current.version) fail(409, 'Сведение уже изменилось. Проверьте текущую запись и запросите предложения заново.');
          const after = await s.put('facts', t.revised(current, user, { ...fields, source: before.title, ...provenance(item), sourceEdited }));
          await t.syncName(after);
          await s.history('facts', after.id, user.id, 'accept_proposal', current, after);
        } else {
          if (original.personId === personId && original.key === key && original.baseVersion !== null) fail(409, 'Исходное сведение изменилось. Запросите предложения заново.');
          await t.newFact(user, personId, key, fields.value, before.title, { ...provenance(item), sourceEdited }, fields.nameParts);
        }
        links.add(personId);
      } else if (item.action === 'create_relation') {
        const fromId = await resolve(item.fromId, item.fromName); const toId = await resolve(item.toId, item.toName);
        await t.newRelation(user, relationSchema.parse({ fromId, toId, type: item.relationType, parentKind: item.parentKind ?? 'unspecified', source: before.title }), provenance(item));
        item.fromId = fromId; item.toId = toId; links.add(fromId); links.add(toId);
      } else if (item.action === 'link_material') { const personId = await resolve(item.personId, item.personName); item.personId = personId; links.add(personId); }
    }
    const acceptedMap = new Map(accepted.map(item => [item.id, item]));
    const after = await s.put<Material>('materials', { ...before, personIds: [...links], proposals: proposals.map(item => acceptedMap.has(item.id) ? { ...acceptedMap.get(item.id)!, sourceQuote: item.sourceQuote, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, baseVersion: item.baseVersion, status: 'accepted' } : rejected.includes(item.id) ? { ...item, status: 'rejected' } : item), version: before.version + 1, updatedAt: now() });
    await s.history('materials', after.id, user.id, 'review_proposals', before, after); return after;
  }));
  return { familyBytes };
}

/**
 * Background work across all families. Claims use row locks (FOR UPDATE SKIP LOCKED),
 * so several application processes can share the queues without doing a job twice.
 */
export function createWorkers({ db, blobs }: ArchiveContext) {
  const concurrency = Math.min(4, Math.max(1, Number(process.env.MEDIA_PREVIEW_CONCURRENCY) || 1));
  const running = new Set<Promise<void>>();
  const controller = new AbortController();
  let stopped = false; let busy = false;
  const claimPreview = () => db.system(async g => {
    const row = (await g.raw(`UPDATE files SET data = data || jsonb_build_object('previewStatus', 'processing', 'previewAttempts', coalesce((data->>'previewAttempts')::int, 0) + 1, 'previewError', null)
      WHERE id = (SELECT id FROM files WHERE data->>'previewStatus' = 'pending' ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING family_id, data`))[0];
    return row ? { familyId: row.family_id as string, file: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as FileRecord } : undefined;
  });
  async function preview({ familyId, file }: { familyId: string; file: FileRecord }) {
    try {
      const result = await createPreview(blobs.localPath(familyId, file.path), controller.signal);
      await db.family(familyId, async s => { const current = await s.get<FileRecord>('files', file.id); if (current) await s.put('files', { ...current, ...result, previewStatus: 'ready', previewError: null }); });
    } catch (error) {
      await db.family(familyId, async s => {
        const current = await s.get<FileRecord>('files', file.id); if (!current) return;
        if (controller.signal.aborted) await s.put('files', { ...current, previewStatus: 'pending', previewAttempts: Math.max(0, (current.previewAttempts ?? 1) - 1) });
        else await s.put('files', { ...current, previewStatus: 'failed', previewError: error instanceof MediaError ? error.message : 'Не удалось подготовить версию для просмотра. Оригинал сохранён и доступен для скачивания.' });
      });
      if (!(error instanceof MediaError)) console.error('Preview failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  }
  let kicking: Promise<void> | null = null;
  function kick() {
    if (kicking || stopped || running.size >= concurrency) return;
    let current: Promise<void> | undefined;
    current = (async () => {
      await null; // let `kicking` be assigned before the body can finish
      try {
        while (!stopped && running.size < concurrency) {
          const next = await claimPreview(); if (!next) break;
          const task: Promise<void> = preview(next).catch(() => {}).finally(() => { running.delete(task); kick(); });
          running.add(task);
        }
      } catch (error) { if (!stopped) console.error('Preview queue failed:', error instanceof Error ? error.message : 'Unknown error'); }
      finally { if (kicking === current) kicking = null; }
    })();
    kicking = current;
  }
  async function runJob(familyId: string, job: Job) {
    const field = job.type === 'transcribe' ? 'transcriptionStatus' : 'extractionStatus';
    const { before, people, facts, file } = await db.family(familyId, async s => {
      const before = await found(s.get<Material>('materials', job.materialId));
      const file = job.type === 'transcribe' && before.file ? await s.get<FileRecord>('files', before.file.id) : undefined;
      await s.put('materials', { ...before, [field]: 'processing', processingError: null });
      return { before, file, people: await s.all<Person>('people'), facts: await s.all<Fact>('facts') };
    });
    try {
      if ((before.transcript?.version ?? null) !== job.sourceVersion || hash(sourceText(before)) !== job.sourceHash) fail(409, 'Текст изменился до начала обработки. Запустите её заново.');
      let transcript: Transcript | null = null; let proposals: Proposal[] | null = null; let extractionRejectedCount = 0;
      if (job.type === 'transcribe') {
        if (!file) fail(400, 'Исходный файл не найден.');
        const result = await transcribeFile(blobs.localPath(familyId, file.path), file.mime);
        transcript = { ...result, version: (before.transcript?.version ?? 0) + 1, automatic: true, updatedAt: now() };
      } else {
        const result = await extractProposals(sourceText(before), before.transcript?.segments ?? [], { people, facts });
        extractionRejectedCount = result.rejectedCount;
        proposals = result.proposals.map(item => ({ ...item, id: randomUUID(), status: 'pending', baseVersion: item.action === 'set_fact' && item.personId && item.key ? facts.find(fact => fact.personId === item.personId && fact.key === item.key)?.version ?? null : null }));
      }
      await db.family(familyId, async s => {
        const current = await found(s.get<Material>('materials', job.materialId));
        if ((current.transcript?.version ?? null) !== job.sourceVersion || hash(sourceText(current)) !== job.sourceHash) fail(409, 'Текст изменился во время обработки. Запустите её заново.');
        const after = await s.put<Material>('materials', { ...current, [field]: 'done', processingError: null, ...(transcript ? { transcript, proposals: invalidatePending(current.proposals), extractionStatus: 'idle', extractionRejectedCount: 0 } : {}), ...(proposals ? { extractionRejectedCount, proposals: [...invalidatePending(current.proposals), ...proposals] } : {}), version: current.version + 1, updatedAt: now() });
        await s.put('jobs', { ...job, status: 'done' }); await s.history('materials', after.id, job.actorId, job.type, current, after);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Не удалось обработать материал.';
      await db.family(familyId, async s => { const current = await s.get<Material>('materials', job.materialId); if (current) await s.put('materials', { ...current, [field]: 'error', processingError: message }); await s.put('jobs', { ...job, status: 'error', error: message }); });
    }
  }
  async function processNextJob() {
    if (busy || stopped) return;
    busy = true;
    try {
      const claimed = await db.system(async g => {
        const row = (await g.raw(`UPDATE jobs SET data = data || '{"status":"processing"}'::jsonb
          WHERE id = (SELECT id FROM jobs WHERE data->>'status' = 'queued' ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING family_id, data`))[0];
        return row ? { familyId: row.family_id as string, job: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Job } : undefined;
      });
      if (claimed) await runJob(claimed.familyId, claimed.job);
    } finally { busy = false; }
  }
  return {
    kick, processNextJob,
    /** Tests and shutdown: wait until no preview is pending or running. */
    async drain() { for (;;) { kick(); await kicking; if (!running.size) return; await Promise.all([...running]); } },
    async close() { stopped = true; controller.abort(); await kicking; await Promise.all([...running]); while (busy) await new Promise(resolve => setTimeout(resolve, 20)); },
    /** Startup: interrupted paid work becomes an explicit error; interrupted conversions return to the queue a bounded number of times. */
    async recover() {
      const interruption = 'Обработка прервана перезапуском сервера. Запустите её вручную.';
      const jobs = await db.system(g => g.raw("SELECT family_id, data FROM jobs WHERE data->>'status' = 'processing'"));
      for (const row of jobs) await db.family(row.family_id as string, async s => {
        const job = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Job;
        await s.put('jobs', { ...job, status: 'error', error: interruption });
        const field = job.type === 'transcribe' ? 'transcriptionStatus' : 'extractionStatus';
        const material = await s.get<Material>('materials', job.materialId);
        if (material && ['queued', 'processing'].includes(material[field])) await s.put('materials', { ...material, [field]: 'error', processingError: interruption });
      });
      await db.system(g => g.raw(`UPDATE files SET data = CASE WHEN coalesce((data->>'previewAttempts')::int, 0) >= 3
        THEN data || jsonb_build_object('previewStatus', 'failed', 'previewError', $1::text) ELSE data || '{"previewStatus":"pending"}'::jsonb END
        WHERE data->>'previewStatus' = 'processing'`, [PREVIEW_INTERRUPTED]));
    },
  };
}
