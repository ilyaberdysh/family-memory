import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createTelegramProvider, type TelegramProvider } from './telegram.js';
import { Store, TABLES, type Table } from './store.js';
import { isAiConfigured, transcribeFile, extractProposals } from './ai.js';
import { registerConversations, ConversationError, type ConversationAI } from './conversations.js';
import { prepareMedia, MediaError, type PreparedMedia } from './media.js';
import type { User, Person, Fact, Relation, Reviewed, Material, UploadedFile, Invitation, InvitationLink, Proposal, FactKey, HistoryEntry, Transcript, NameParts } from '../shared/types.js';
import { cleanNameParts, fullName, NAME_PART_MAX_LENGTH, dateInputError, formatFamilyDate, isDateFact } from '../shared/person-fields.js';

type FileRecord = UploadedFile & { createdBy: string; path: string; previewPath?: string; previewMime?: string; previewSize?: number };
type Session = { id: string; userId: string; expires: number };
type Code = { id: string; name: string; hash: string; role: User['role']; expires: number; attempts: number; sentAt: number };
type AuthFlow = { id: string; state: string; nonce: string; verifier: string; redirectUri: string; expires: number };
type InvitationLinkRecord = InvitationLink & { tokenHash: string };
type Job = { id: string; materialId: string; actorId: string; type: 'transcribe' | 'extract'; status: 'queued' | 'processing' | 'done' | 'error'; sourceVersion: number | null; sourceHash: string; createdAt: string; error?: string };
type AppOptions = { telegramProvider?: TelegramProvider; adminTelegramId?: string; conversationAI?: Partial<ConversationAI>; dataDir?: string; bindHost?: string; devAuth?: boolean; production?: boolean; startWorker?: boolean; adminEmail?: string };
const now = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(host);
const factKey = z.enum(['name', 'previousName', 'birthDate', 'deathDate', 'place', 'bio']);
const roleSchema = z.enum(['admin', 'member', 'viewer']);
const relationSchema = z.object({ fromId: z.string().min(1), toId: z.string().min(1), type: z.enum(['parent', 'partner']), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).default('unspecified'), source: z.string().max(5000).default('') });
const textValue = z.string().trim().min(1).max(10000);
const versionSchema = z.number().int().positive();
const namePartsSchema = z.object({ firstName: z.string().max(NAME_PART_MAX_LENGTH).default(''), lastName: z.string().max(NAME_PART_MAX_LENGTH).default(''), patronymic: z.string().max(NAME_PART_MAX_LENGTH).default('') });
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new ApiError(status, message); }
const requireVersion = (actual: number, expected: number) => { if (actual !== expected) fail(409, 'Запись уже изменилась. Обновите страницу и проверьте новую версию.'); };
function checkedDate(value: string): string { const error = dateInputError(value); if (error) fail(400, error); return formatFamilyDate(value.trim()); }
function factFields(key: FactKey, rawValue: string | undefined, parts?: NameParts, previous?: Fact): Pick<Fact, 'value' | 'nameParts'> {
  if (parts && key !== 'name') fail(400, 'Отдельные части ФИО можно сохранить только в поле имени.');
  const nameParts = parts ? cleanNameParts(parts) : key === 'name' && rawValue === previous?.value ? previous?.nameParts : undefined;
  const value = parts ? fullName(parts) : rawValue?.trim() ?? '';
  if (!value) fail(400, key === 'name' ? 'Укажите хотя бы одну известную часть имени.' : 'Укажите значение сведения.');
  return { value: isDateFact(key) ? checkedDate(value) : value, ...(key === 'name' ? { nameParts } : {}) };
}

export function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const bindHost = options.bindHost ?? process.env.HOST ?? '127.0.0.1';
  const devMode = !production && (options.devAuth ?? process.env.DEV_AUTH === '1') && loopback(bindHost);
  const adminEmail = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const store = new Store(options.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data'));
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  const maxUploadMb = Math.min(2048, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 250));
  const name = process.env.SPACE_NAME || 'Семейное пространство';
  const telegram = options.telegramProvider ?? createTelegramProvider();
  const adminTelegramId = (options.adminTelegramId ?? process.env.ADMIN_TELEGRAM_ID ?? '').trim();
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'family-space') return next(new ApiError(403, 'Запрос не прошёл проверку безопасности. Обновите страницу.'));
    const origin = req.get('Origin');
    const allowed = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== allowed) || req.get('Sec-Fetch-Site') === 'cross-site') return next(new ApiError(403, 'Запрос с другого сайта запрещён.'));
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  const get = <T>(table: Table, id: string): T => store.get<T>(table, id) ?? fail(404, 'Запись не найдена.');
  const actor = (res: Response): User => res.locals.user as User;
  const writable = (user: User) => { if (user.role === 'viewer') fail(403, 'Наблюдатель может только смотреть.'); };
  const owned = (record: { createdBy: string }, user: User) => { writable(user); if (record.createdBy !== user.id && user.role !== 'admin') fail(403, 'Редактировать может автор или администратор.'); };
  const admin = (user: User) => { if (user.role !== 'admin') fail(403, 'Это действие доступно администратору.'); };
  const clientFile = (record: FileRecord): UploadedFile => ({ id: record.id, name: record.name, mime: record.previewMime ?? record.mime, size: record.previewSize ?? record.size, url: record.url });
  const cookieValue = (req: Request, key: string) => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
  const sessionId = (req: Request) => cookieValue(req, 'family_session');
  const previewRequest = (req: Request) => devMode && loopback(req.socket.remoteAddress || '');
  const active = (user: User) => !user.status || user.status === 'active';
  const sessionLifetime = 365 * 86400000;
  const sessionCookie = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: '/' };
  const flowCookie = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: '/api/auth/telegram' };
  const newSession = (user: User) => {
    const token = randomBytes(32).toString('hex');
    store.put<Session>('sessions', { id: hash(token), userId: user.id, expires: Date.now() + sessionLifetime });
    return token;
  };
  const setSession = (res: Response, token: string) => res.cookie('family_session', token, { ...sessionCookie, maxAge: sessionLifetime });
  const sessionUser = (req: Request): User | undefined => {
    const token = sessionId(req);
    const session = token ? store.get<Session>('sessions', hash(token)) : undefined;
    return session && session.expires > Date.now() ? store.get<User>('users', session.userId) : undefined;
  };
  const requireSession = (req: Request) => sessionUser(req) ?? fail(401, 'Войдите в семейное пространство.');
  const normalizePhone = (phone: string) => {
    if (!/^\+?[\d\s().-]+$/.test(phone.trim())) fail(400, 'Укажите телефон с кодом страны.');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) fail(400, 'Телефон должен содержать от 7 до 15 цифр с кодом страны.');
    return `+${digits}`;
  };
  const clientInvitationLink = (link: InvitationLinkRecord): InvitationLink => ({ id: link.id, role: link.role, createdBy: link.createdBy, createdAt: link.createdAt, expiresAt: link.expiresAt, revokedAt: link.revokedAt, uses: link.uses, userId: link.userId ?? null, usedAt: link.usedAt ?? null });
  const activeInvitationLink = (link: InvitationLinkRecord | undefined): InvitationLinkRecord => {
    if (!link || link.revokedAt || link.usedAt || link.uses > 0 || !Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now() || !['member', 'viewer'].includes(link.role)) fail(410, 'Ссылка больше не действует. Попросите администратора прислать новую.');
    return link;
  };
  const invitationFromToken = (token: unknown) => activeInvitationLink(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? store.all<InvitationLinkRecord>('invitation_links').find(link => link.tokenHash === hash(token)) : undefined);
  const loginRates = new Map<string, { count: number; until: number }>();
  function loginRate(req: Request, kind: string) {
    const key = `${kind}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const rate = loginRates.get(key);
    if (rate && rate.until > Date.now() && rate.count >= 20) fail(429, 'Слишком много попыток. Попробуйте через 15 минут.');
    loginRates.set(key, rate && rate.until > Date.now() ? { ...rate, count: rate.count + 1 } : { count: 1, until: Date.now() + 900000 });
    if (loginRates.size > 1000) for (const [key, item] of loginRates) if (item.until < Date.now()) loginRates.delete(key);
  }
  const familySurnames = () => {
    const names = [...(process.env.FAMILY_SURNAMES || '').split(','),
      ...store.all<Person>('people').map(person => person.nameParts?.lastName || ''),
      ...store.all<Fact>('facts').filter(fact => fact.key === 'previousName').map(fact => fact.value)];
    const unique = new Map<string, string>();
    for (const raw of names) {
      const surname = raw.trim().replace(/\s+/g, ' ');
      if (!surname || surname.length > NAME_PART_MAX_LENGTH) continue;
      const key = surname.toLocaleLowerCase('ru').replace(/ё/g, 'е');
      if (!unique.has(key)) unique.set(key, surname);
      if (unique.size === 5) break;
    }
    return [...unique.values()];
  };
  app.get('/api/auth/config', (req, res) => res.json({ devMode: previewRequest(req), mailAvailable: false, telegramAvailable: telegram.configured, name, surnames: familySurnames() }));
  app.get('/api/auth/session', (req, res) => res.json({ user: sessionUser(req) ?? null }));
  app.post('/api/auth/telegram/start', async (req, res) => {
    if (!telegram.configured) fail(503, 'Вход через Telegram ещё не настроен.');
    loginRate(req, 'telegram');
    const origin = process.env.PUBLIC_ORIGIN || (!production ? `${req.protocol}://${req.get('host')}` : '');
    if (!origin || (production && new URL(origin).protocol !== 'https:')) fail(503, 'Администратору нужно настроить адрес входа через Telegram.');
    const token = randomBytes(32).toString('hex');
    const flow: AuthFlow = { id: hash(token), state: randomBytes(32).toString('hex'), nonce: randomBytes(32).toString('hex'), verifier: randomBytes(32).toString('base64url'), redirectUri: new URL('/api/auth/telegram/callback', origin).href, expires: Date.now() + 600000 };
    const url = await telegram.authorizationUrl(flow);
    for (const previous of store.all<AuthFlow>('auth_flows')) if (previous.expires <= Date.now()) store.delete('auth_flows', previous.id);
    const previousCookie = cookieValue(req, 'family_telegram');
    if (previousCookie) store.delete('auth_flows', hash(previousCookie));
    store.put('auth_flows', flow);
    res.cookie('family_telegram', token, { ...flowCookie, maxAge: 600000 });
    res.json({ url });
  });
  app.get('/api/auth/telegram/callback', async (req, res) => {
    res.clearCookie('family_telegram', flowCookie);
    try {
      const token = cookieValue(req, 'family_telegram');
      if (!token) fail(400, 'Missing flow');
      const flow = store.transaction(() => {
        const value = store.get<AuthFlow>('auth_flows', hash(token));
        if (value) store.delete('auth_flows', value.id);
        return value;
      });
      if (!flow || flow.expires <= Date.now() || typeof req.query.state !== 'string' || req.query.state !== flow.state) fail(400, 'Invalid flow');
      const identity = await telegram.exchange({ callbackUrl: new URL(req.originalUrl, flow.redirectUri).href, state: flow.state, nonce: flow.nonce, verifier: flow.verifier, redirectUri: flow.redirectUri });
      const tokenForSession = store.transaction(() => {
        if (!identity.telegramId || !identity.subject) fail(400, 'Missing identity');
        const users = store.all<User>('users');
        const matches = users.filter(user => user.telegramSubject === identity.subject || user.telegramId === identity.telegramId);
        if (matches.length > 1) fail(409, 'Conflicting identity');
        let account = matches[0];
        if (account && ((account.telegramId && account.telegramId !== identity.telegramId) || (account.telegramSubject && account.telegramSubject !== identity.subject))) fail(409, 'Conflicting identity');
        const designatedAdmin = !!adminTelegramId && identity.telegramId === adminTelegramId;
        if (!account && designatedAdmin) {
          const legacy = users.filter(user => user.role === 'admin' && !user.telegramId && !user.telegramSubject && (user.email === 'admin@local.invalid' || (!!adminEmail && user.email === adminEmail)));
          if (legacy.length === 1) account = legacy[0];
        }
        if (account) account = store.put('users', { ...account, telegramId: identity.telegramId, telegramSubject: identity.subject, authProvider: 'telegram' as const });
        else {
          const bootstrap = designatedAdmin && users.length === 0;
          account = store.put<User>('users', { id: randomUUID(), email: '', name: identity.name, role: bootstrap ? 'admin' : 'member', status: bootstrap ? 'active' : 'profile', authProvider: 'telegram', telegramId: identity.telegramId, telegramSubject: identity.subject, ...(identity.phone ? { phone: normalizePhone(identity.phone), phoneVerified: identity.phoneVerified } : {}) });
        }
        return newSession(account);
      });
      setSession(res, tokenForSession); res.redirect('/');
    } catch { res.redirect('/?auth=telegram_failed'); }
  });
  app.post('/api/auth/guest-preview', (req, res) => {
    const link = invitationFromToken(req.body?.token);
    res.json({ role: link.role, expiresAt: link.expiresAt });
  });
  app.post('/api/auth/guest', (req, res) => {
    loginRate(req, 'guest');
    const result = store.transaction(() => {
      const link = invitationFromToken(req.body?.token);
      let account: User;
      if (link.userId) {
        account = get<User>('users', link.userId);
        if (account.authProvider !== 'guest' || account.role === 'admin' || account.status === 'rejected') fail(410, 'Ссылка больше не действует. Попросите администратора прислать новую.');
      } else account = store.put<User>('users', { id: randomUUID(), name: '', email: '', role: link.role, status: 'profile', authProvider: 'guest', phoneVerified: false });
      store.put('invitation_links', { ...link, userId: account.id, usedAt: now(), uses: 1 });
      return { account, token: newSession(account) };
    });
    setSession(res, result.token); res.json(result.account);
  });
  app.post('/api/auth/profile', (req, res) => {
    const user = requireSession(req);
    if (user.status === 'rejected') fail(403, 'Заявка отклонена. Обратитесь к администратору.');
    const input = z.object({ nameParts: namePartsSchema.extend({ firstName: z.string().trim().min(1).max(NAME_PART_MAX_LENGTH), lastName: z.string().trim().min(1).max(NAME_PART_MAX_LENGTH) }), phone: z.string().trim().max(40) }).parse(req.body);
    const phone = normalizePhone(input.phone);
    const nameParts = cleanNameParts(input.nameParts);
    const status = user.status === 'profile' ? user.authProvider === 'guest' ? 'active' : 'pending' : user.status;
    res.json(store.put('users', { ...user, name: fullName(nameParts), nameParts, phone, phoneVerified: user.phone === phone && !!user.phoneVerified, status }));
  });
  // Explicit loopback preview compatibility; never an alternate production login.
  app.post('/api/auth/request-code', (req, res) => {
    if (!previewRequest(req)) fail(410, 'Вход по email больше не используется. Войдите через Telegram или гостевую ссылку.');
    const input = z.object({ email: z.email().max(254).transform(v => v.trim().toLowerCase()), name: z.string().trim().min(2).max(150) }).parse(req.body);
    loginRate(req, 'local');
    const users = store.all<User>('users');
    const user = users.find(item => item.email === input.email);
    const invitation = store.all<Invitation>('invitations').find(item => item.email === input.email && !item.accepted);
    const bootstrap = users.length === 0 && (adminEmail ? input.email === adminEmail : previewRequest(req));
    if (!user && !invitation && !bootstrap) fail(403, 'Этот email пока не приглашён. Попросите администратора добавить его.');
    const previous = store.get<Code>('codes', input.email);
    if (previous && Date.now() - previous.sentAt < 30000) fail(429, 'Код уже отправлен. Повторить можно через 30 секунд.');
    const code = String(randomInt(100000, 1000000));
    store.put<Code>('codes', { id: input.email, name: input.name, role: user?.role ?? (bootstrap ? 'admin' : invitation!.role), hash: hash(`${input.email}:${code}`), expires: Date.now() + 600000, attempts: 0, sentAt: Date.now() });
    res.json({ ok: true, devCode: code });
  });
  app.post('/api/auth/verify', (req, res) => {
    if (!previewRequest(req)) fail(410, 'Вход по email больше не используется. Войдите через Telegram или гостевую ссылку.');
    const { email, code } = z.object({ email: z.email().transform(v => v.toLowerCase().trim()), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const record = store.get<Code>('codes', email);
    if (!record || record.expires < Date.now() || record.attempts >= 5) fail(400, 'Код истёк или больше не действует. Запросите новый.');
    store.put('codes', { ...record, attempts: record.attempts + 1 });
    if (!timingSafeEqual(Buffer.from(record.hash), Buffer.from(hash(`${email}:${code}`)))) fail(400, 'Неверный код.');
    const result = store.transaction(() => {
      const existing = store.all<User>('users').find(item => item.email === email);
      const invitation = store.all<Invitation>('invitations').find(item => item.email === email && !item.accepted);
      const bootstrap = store.all<User>('users').length === 0 && (adminEmail ? email === adminEmail : previewRequest(req));
      if (!existing && !invitation && !bootstrap) fail(403, 'Приглашение больше не действует.');
      const account = existing ?? store.put<User>('users', { id: randomUUID(), email, name: record.name, role: bootstrap ? 'admin' : invitation!.role, authProvider: 'local', status: 'active' });
      if (invitation) store.put('invitations', { ...invitation, accepted: true });
      store.delete('codes', email);
      return { account, token: newSession(account) };
    });
    setSession(res, result.token); res.json(result.account);
  });
  app.post('/api/auth/logout', (req, res) => { const token = sessionId(req); if (token) store.delete('sessions', hash(token)); res.clearCookie('family_session', sessionCookie); res.json({ ok: true }); });
  app.use('/api', (req, res, next) => {
    const user = sessionUser(req);
    if (!user) return next(new ApiError(401, 'Войдите в семейное пространство.'));
    if (!active(user)) return next(new ApiError(403, user.status === 'rejected' ? 'Заявка отклонена. Обратитесь к администратору.' : 'Доступ к семейному пространству откроется после одобрения администратора.'));
    res.locals.user = user; next();
  });
  app.get('/api/state', (_req, res) => {
    const user = actor(res);
    const users = store.all<User>('users').filter(item => user.role === 'admin' || active(item)).map(item => {
      if (user.role === 'admin' || item.id === user.id) return item;
      const { phone, phoneVerified, telegramId, telegramSubject, email, ...publicUser } = item;
      return { ...publicUser, email: '' };
    });
    res.json({ user, users, people: store.all('people'), facts: store.all('facts'), relations: store.all('relations'), materials: store.all<Material>('materials').map(({ transcript, proposals, ...material }) => material), invitations: user.role === 'admin' ? store.all('invitations') : [], invitationLinks: user.role === 'admin' ? store.all<InvitationLinkRecord>('invitation_links').map(clientInvitationLink) : [], settings: { name, surnames: familySurnames(), devMode, aiAvailable: isAiConfigured(), maxUploadMb } });
  });
  const reviewed = (user: User, source = '', extra: Partial<Reviewed> = {}): Reviewed => ({ id: randomUUID(), version: 1, status: 'unconfirmed', createdBy: user.id, updatedBy: user.id, createdAt: now(), updatedAt: now(), confirmedBy: null, confirmedAt: null, source, disputedBy: null, disputeNote: null, ...extra });
  const revised = <T extends Reviewed>(record: T, user: User, changes: Partial<T>): T => ({ ...record, ...changes, version: record.version + 1, updatedBy: user.id, updatedAt: now(), status: 'unconfirmed', confirmedBy: null, confirmedAt: null, disputedBy: null, disputeNote: null });
  const syncName = (fact: Fact) => { if (fact.key === 'name') store.put('people', { ...get<Person>('people', fact.personId), name: fact.value, nameParts: fact.nameParts }); };
  const newFact = (user: User, personId: string, key: FactKey, value: string | undefined, source = '', provenance: Partial<Reviewed> = {}, nameParts?: NameParts) => {
    get<Person>('people', personId);
    if (store.all<Fact>('facts').some(fact => fact.personId === personId && fact.key === key)) fail(409, 'Это поле уже заполнено. Отредактируйте существующее сведение.');
    const fact = store.put<Fact>('facts', { ...reviewed(user, source, provenance), personId, key, ...factFields(key, value, nameParts) });
    syncName(fact);
    store.history('facts', fact.id, user.id, 'create', null, fact); return fact;
  };
  const newPerson = (user: User, personName: string | undefined, source = '', provenance: Partial<Reviewed> = {}, nameParts?: NameParts) => {
    const fields = factFields('name', personName, nameParts);
    const person = store.put<Person>('people', { id: randomUUID(), name: fields.value, nameParts: fields.nameParts, avatarFileId: null, createdBy: user.id, createdAt: now() });
    newFact(user, person.id, 'name', fields.value, source, provenance, fields.nameParts); return person;
  };
  const validateRelation = (input: z.infer<typeof relationSchema>, except?: string) => {
    get<Person>('people', input.fromId); get<Person>('people', input.toId);
    if (input.fromId === input.toId) fail(400, 'Нельзя связать человека с самим собой.');
    const relations = store.all<Relation>('relations').filter(item => item.id !== except);
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
  };
  const newRelation = (user: User, input: z.infer<typeof relationSchema>, provenance: Partial<Reviewed> = {}) => {
    validateRelation(input);
    const relation = store.put<Relation>('relations', { ...reviewed(user, input.source, provenance), ...input });
    store.history('relations', relation.id, user.id, 'create', null, relation); return relation;
  };
  app.post('/api/people', (req, res) => {
    const user = actor(res); writable(user);
    const input = z.object({ name: z.string().trim().max(302).optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000).default(''), facts: z.partialRecord(factKey, z.string().trim().max(10000)).optional(), relation: z.object({ relativeId: z.string(), type: z.enum(['parent', 'child', 'partner']), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).optional() }).optional() }).parse(req.body);
    const person = store.transaction(() => {
      const person = newPerson(user, input.name, input.source, {}, input.nameParts);
      for (const [key, value] of Object.entries(input.facts ?? {})) if (key !== 'name' && value) newFact(user, person.id, key as FactKey, value, input.source);
      if (input.relation) {
        const { relativeId, type, parentKind } = input.relation;
        newRelation(user, { fromId: type === 'child' ? relativeId : person.id, toId: type === 'child' ? person.id : relativeId, type: type === 'partner' ? 'partner' : 'parent', parentKind: parentKind ?? 'unspecified', source: input.source });
      }
      return person;
    }); res.status(201).json(person);
  });
  app.patch('/api/people/:id', (req, res) => {
    const user = actor(res); const before = get<Person>('people', String(req.params.id)); owned(before, user);
    const input = z.object({ avatarFileId: z.string().nullable() }).parse(req.body);
    if (input.avatarFileId) { const file = get<FileRecord>('files', input.avatarFileId); if (!file.mime.startsWith('image/')) fail(400, 'Для портрета нужна фотография.'); if (file.createdBy !== user.id && user.role !== 'admin') fail(403, 'Выберите загруженный вами файл.'); }
    res.json(store.put('people', { ...before, ...input }));
  });
  app.post('/api/facts', (req, res) => {
    const user = actor(res); writable(user);
    const input = z.object({ personId: z.string(), key: factKey, value: textValue.optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000).default(''), sourceMaterialId: z.string().nullable().optional() }).parse(req.body);
    if (input.sourceMaterialId) get<Material>('materials', input.sourceMaterialId);
    res.status(201).json(store.transaction(() => newFact(user, input.personId, input.key, input.value, input.source, { sourceMaterialId: input.sourceMaterialId }, input.nameParts)));
  });
  app.patch('/api/facts/:id', (req, res) => {
    const input = z.object({ value: textValue.optional(), nameParts: namePartsSchema.optional(), source: z.string().max(5000), version: versionSchema }).parse(req.body); const user = actor(res);
    res.json(store.transaction(() => {
      const before = get<Fact>('facts', String(req.params.id)); owned(before, user); requireVersion(before.version, input.version);
      const after = store.put('facts', revised(before, user, { ...factFields(before.key, input.value, input.nameParts, before), source: input.source }));
      syncName(after);
      store.history('facts', after.id, user.id, 'edit', before, after); return after;
    }));
  });
  app.post('/api/relations', (req, res) => { const user = actor(res); writable(user); const input = relationSchema.parse(req.body); res.status(201).json(store.transaction(() => newRelation(user, input))); });
  app.patch('/api/relations/:id', (req, res) => {
    const input = relationSchema.extend({ version: versionSchema }).parse(req.body); const user = actor(res);
    res.json(store.transaction(() => { const before = get<Relation>('relations', String(req.params.id)); owned(before, user); requireVersion(before.version, input.version); validateRelation(input, before.id); const after = store.put('relations', revised(before, user, { fromId: input.fromId, toId: input.toId, type: input.type, parentKind: input.parentKind, source: input.source })); store.history('relations', after.id, user.id, 'edit', before, after); return after; }));
  });
  app.post('/api/review/:kind/:id', (req, res) => {
    const kind = z.enum(['facts', 'relations']).parse(req.params.kind); const user = actor(res); writable(user);
    const input = z.object({ action: z.enum(['confirm', 'dispute']), version: versionSchema, note: z.string().trim().max(2000).optional() }).parse(req.body);
    res.json(store.transaction(() => {
      const before = get<Fact | Relation>(kind, String(req.params.id)); requireVersion(before.version, input.version);
      if (input.action === 'confirm' && before.updatedBy === user.id) fail(403, 'Ваше изменение должен подтвердить другой участник.');
      if (input.action === 'confirm' && before.status === 'disputed') fail(409, 'Сначала нужно исправить спорное сведение.');
      if (input.action === 'dispute' && !input.note) fail(400, 'Напишите, что кажется неточным.');
      if (input.action === 'confirm' && before.status === 'confirmed') return before;
      const after = store.put(kind, { ...before, status: input.action === 'confirm' ? 'confirmed' : 'disputed', confirmedBy: input.action === 'confirm' ? user.id : null, confirmedAt: input.action === 'confirm' ? now() : null, disputedBy: input.action === 'dispute' ? user.id : null, disputeNote: input.action === 'dispute' ? input.note : null });
      store.history(kind, before.id, user.id, input.action, before, after); return after;
    }));
  });
  app.get('/api/history/:kind/:id', (req, res) => { const kind = z.enum(['facts', 'relations', 'materials']).parse(req.params.kind); get(kind, String(req.params.id)); res.json(store.all<HistoryEntry>('history').filter(item => item.entityType === kind && item.entityId === req.params.id)); });

  // Archive routes and durable processing are registered below.
  return finishApp();

  function finishApp() {
    registerArchive();
    registerAdministration();
    const conversations = registerConversations(app, store, options.conversationAI);
    app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Такого API-адреса нет.')));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) return void res.status(400).json({ error: 'Проверьте заполненные поля.', details: error.issues.map(item => ({ path: item.path.join('.'), message: item.message })) });
      if (error instanceof multer.MulterError) return void res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${maxUploadMb} МБ.` : 'Не удалось принять файл. Проверьте формат загрузки.' });
      if (error instanceof ConversationError) return void res.status(error.status).json({ error: error.message });
      if (error instanceof ApiError) return void res.status(error.status).json({ error: error.message });
      if (error instanceof MediaError) return void res.status(error.status).json({ error: error.message });
      if ((error as { type?: string })?.type === 'entity.too.large') return void res.status(413).json({ error: 'Текст слишком большой.' });
      if (error instanceof SyntaxError && 'body' in error) return void res.status(400).json({ error: 'Не удалось прочитать данные запроса.' });
      console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
      res.status(500).json({ error: 'Не удалось сохранить изменения. Попробуйте ещё раз.' });
    });
    let closed = false; let busy = false;
    for (const job of store.all<Job>('jobs')) if (job.status === 'processing') store.put('jobs', { ...job, status: 'queued' });
    async function processNextJob() {
      if (busy || closed) return; const job = store.all<Job>('jobs').find(item => item.status === 'queued'); if (!job) return;
      busy = true;
      try { await runJob(job); } finally { busy = false; }
    }
    const timer = options.startWorker === false ? null : setInterval(() => { void processNextJob().catch(error => console.error('Processing failed:', error instanceof Error ? error.message : error)); }, 1000);
    timer?.unref();
    return { app, store, processNextJob, close: async () => { closed = true; conversations.close(); if (timer) clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 20)); store.close(); } };
  }

  function registerArchive() {
    const upload = multer({ dest: store.filesDir, limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 0 } });
    app.post('/api/files', (_req, res, next) => { try { writable(actor(res)); next(); } catch (error) { next(error); } }, upload.single('file'), async (req, res) => {
      const file = req.file; if (!file) fail(400, 'Выберите файл.');
      let prepared: PreparedMedia | undefined;
      try {
        prepared = await prepareMedia(file.path);
        const id = randomUUID();
        const record: FileRecord = { id, name: file.originalname.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'Файл', ...prepared, size: file.size, url: `/api/files/${id}`, createdBy: actor(res).id, path: file.filename };
        store.put('files', record); res.status(201).json(clientFile(record));
      } catch (error) { await unlink(file.path).catch(() => {}); if (prepared?.previewPath) await unlink(join(store.filesDir, prepared.previewPath)).catch(() => {}); throw error; }
    });
    app.get(['/api/files/:id', '/api/files/:id/original'], (req, res, next) => {
      const file = get<FileRecord>('files', String(req.params.id));
      const account = actor(res);
      if (file.createdBy !== account.id && account.role !== 'admin' &&
          !store.all<Material>('materials').some(m => m.file?.id === file.id) &&
          !store.all<Person>('people').some(p => p.avatarFileId === file.id)) fail(404, 'Файл не найден.');
      const original = req.query.original === '1' || req.path.endsWith('/original');
      const preview = !original && file.previewPath && file.previewMime && file.previewSize;
      const size = preview ? file.previewSize! : file.size;
      const mime = preview ? file.previewMime! : file.mime;
      const filePath = preview ? file.previewPath! : file.path;
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
      const stream = createReadStream(join(store.filesDir, filePath), { start, end });
      stream.on('error', error => { if (res.headersSent) res.destroy(); else next(error); });
      res.on('close', () => stream.destroy()); stream.pipe(res);
    });
    const materialFields = z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(1000000).default(''), narrator: z.string().max(200).default(''), occurredAt: z.string().max(200).default('').transform(checkedDate), personIds: z.array(z.string()).max(1000).default([]) });
    app.post('/api/materials', (req, res) => {
      const user = actor(res); writable(user);
      const input = materialFields.extend({ kind: z.enum(['story', 'photo', 'audio', 'video']), fileId: z.string().nullable().optional() }).parse(req.body);
      const material = store.transaction(() => {
        for (const id of input.personIds) get<Person>('people', id);
        const file = input.fileId ? get<FileRecord>('files', input.fileId) : null;
        if (file && file.createdBy !== user.id && user.role !== 'admin') fail(403, 'Выберите загруженный вами файл.');
        if (input.kind !== 'story' && !file) fail(400, 'Для этого материала нужен файл.');
        if (file && ((input.kind === 'photo' && !file.mime.startsWith('image/')) || (input.kind === 'audio' && !file.mime.startsWith('audio/')) || (input.kind === 'video' && !file.mime.startsWith('video/')) || (input.kind === 'story' && !file.mime.startsWith('image/')))) fail(400, 'Тип материала не соответствует файлу.');
        const record = store.put<Material>('materials', { id: randomUUID(), title: input.title, kind: input.kind, body: input.body, narrator: input.narrator, occurredAt: input.occurredAt, personIds: [...new Set(input.personIds)], file: file ? clientFile(file) : null, createdBy: user.id, createdAt: now(), updatedAt: now(), version: 1, transcriptionStatus: 'idle', extractionStatus: 'idle', extractionRejectedCount: 0, processingError: null, transcript: null, proposals: [] });
        store.history('materials', record.id, user.id, 'create', null, record); return record;
      }); res.status(201).json(material);
    });
    app.get('/api/materials/:id', (req, res) => res.json(get<Material>('materials', String(req.params.id))));
    app.patch('/api/materials/:id', (req, res) => {
      const user = actor(res); const input = materialFields.partial().extend({ version: versionSchema }).parse(req.body);
      res.json(store.transaction(() => {
        const before = get<Material>('materials', String(req.params.id)); owned(before, user); requireVersion(before.version, input.version);
        const { version: _version, ...parsedFields } = input;
        // Zod defaults also run inside partial objects; omitted PATCH fields must stay intact.
        const fields = Object.fromEntries(Object.entries(parsedFields).filter(([key]) => Object.hasOwn(req.body, key))) as typeof parsedFields;
        for (const id of fields.personIds ?? []) get<Person>('people', id);
        const bodyChanged = fields.body !== undefined && fields.body !== before.body;
        const after = store.put<Material>('materials', { ...before, ...fields, personIds: fields.personIds ? [...new Set(fields.personIds)] : before.personIds, version: before.version + 1, updatedAt: now(), ...(bodyChanged && !before.transcript ? { proposals: invalidatePending(before.proposals), extractionStatus: 'idle' as const, extractionRejectedCount: 0, processingError: null } : {}) });
        store.history('materials', after.id, user.id, 'edit', before, after); return after;
      }));
    });
    app.patch('/api/materials/:id/transcript', (req, res) => {
      const input = z.object({ text: z.string().max(1000000), version: z.number().int().nonnegative() }).parse(req.body); const user = actor(res);
      res.json(store.transaction(() => {
        const before = get<Material>('materials', String(req.params.id)); owned(before, user);
        requireVersion(before.transcript?.version ?? 0, input.version);
        // Edited text no longer shares reliable timestamps with automatic segments.
        const transcript: Transcript = { text: input.text, segments: [], version: (before.transcript?.version ?? 0) + 1, automatic: false, updatedAt: now() };
        const after = store.put<Material>('materials', { ...before, transcript, proposals: invalidatePending(before.proposals), transcriptionStatus: 'done', extractionStatus: 'idle', extractionRejectedCount: 0, processingError: null, version: before.version + 1, updatedAt: now() });
        store.history('materials', after.id, user.id, 'edit_transcript', before, after); return after;
      }));
    });
    for (const type of ['transcribe', 'extract'] as const) app.post(`/api/materials/:id/${type}`, (req, res) => {
      const user = actor(res);
      store.transaction(() => {
        const material = get<Material>('materials', String(req.params.id)); owned(material, user);
        if (!isAiConfigured()) fail(503, 'Обработка недоступна: администратору нужно настроить ключ API.');
        if (type === 'transcribe' && (!material.file || !['audio', 'video'].includes(material.kind))) fail(400, 'Расшифровка доступна для аудио и видео.');
        if (type === 'extract' && !sourceText(material).trim()) fail(400, 'Сначала создайте расшифровку или добавьте текст истории.');
        if (['queued', 'processing'].includes(material.extractionStatus) || ['queued', 'processing'].includes(material.transcriptionStatus)) fail(409, 'Материал уже обрабатывается. Дождитесь результата.');
        if (store.all<Job>('jobs').some(job => job.materialId === material.id && ['queued', 'processing'].includes(job.status))) fail(409, 'Материал уже обрабатывается. Дождитесь результата.');
        store.put<Job>('jobs', { id: randomUUID(), materialId: material.id, actorId: user.id, type, status: 'queued', sourceVersion: material.transcript?.version ?? null, sourceHash: hash(sourceText(material)), createdAt: now() });
        store.put<Material>('materials', { ...material, [type === 'transcribe' ? 'transcriptionStatus' : 'extractionStatus']: 'queued', processingError: null });
      }); res.json({ ok: true });
    });
    const nullableId = z.string().min(1).nullable();
    const proposalSchema = z.object({ id: z.string().min(1), action: z.enum(['create_person', 'set_fact', 'create_relation', 'link_material']), status: z.enum(['pending', 'accepted', 'rejected']), personId: nullableId, personName: z.string().max(302).nullable(), nameParts: namePartsSchema.optional(), key: factKey.nullable(), value: z.string().max(10000).nullable(), fromId: nullableId, toId: nullableId, fromName: z.string().max(302).nullable(), toName: z.string().max(302).nullable(), relationType: z.enum(['parent', 'partner']).nullable(), parentKind: z.enum(['biological', 'adoptive', 'unspecified']).nullable(), sourceQuote: z.string().max(20000), sourceStart: z.number().nonnegative().nullable(), sourceEnd: z.number().nonnegative().nullable(), baseVersion: versionSchema.nullable() });
    app.post('/api/materials/:id/proposals', (req, res) => {
      const input = z.object({ accept: z.array(proposalSchema).max(200), reject: z.array(z.string()).max(200), transcriptVersion: versionSchema.nullable() }).parse(req.body); const user = actor(res);
      res.json(store.transaction(() => {
        const before = get<Material>('materials', String(req.params.id)); owned(before, user);
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
        const resolve = (id: string | null, personName: string | null) => {
          if (id) return get<Person>('people', id).id;
          const resolved = personName ? nameMap.get(normalized(personName)) : undefined;
          if (!resolved) fail(400, `Выберите человека${personName ? ` «${personName}»` : ''} или примите предложение о его создании.`);
          return resolved;
        };
        // Explicit creation/resolution first makes related proposals independent of list order.
        for (const item of accepted.filter(p => p.action === 'create_person')) {
          const personName = (item.nameParts ? fullName(item.nameParts) : item.personName?.trim()) || (item.personId ? get<Person>('people', item.personId).name : '');
          if (!personName) fail(400, 'Укажите имя нового человека.');
          const normalizedName = normalized(personName);
          if (nameMap.has(normalizedName)) fail(409, 'Два предложения создают одинаковое имя. Выберите существующего человека или уточните имена.');
          const person = item.personId ? get<Person>('people', item.personId) : newPerson(user, personName, before.title, provenance(item), item.nameParts);
          if (!item.personId) createdPeople.add(person.id);
          nameMap.set(normalizedName, person.id);
          const originalName = originalFor(item).personName;
          if (originalName && !nameMap.has(normalized(originalName))) nameMap.set(normalized(originalName), person.id);
          item.personId = person.id; item.personName = personName; if (item.nameParts) item.nameParts = cleanNameParts(item.nameParts); links.add(person.id);
        }
        for (const item of accepted) {
          if (item.action === 'create_person') continue;
          if (item.action === 'set_fact') {
            const personId = resolve(item.personId, item.personName); item.personId = personId;
            const key = factKey.parse(item.key);
            const current = store.all<Fact>('facts').find(fact => fact.personId === personId && fact.key === key);
            const fields = factFields(key, item.value ?? undefined, item.nameParts, current); item.value = fields.value; item.nameParts = fields.nameParts;
            const original = originalFor(item);
            if (current) {
              owned(current, user);
              // Resolving an ambiguous name or deliberately selecting another field uses
              // the version the user just reviewed; the original target cannot rebase itself.
              const expectedVersion = original.personId === personId && original.key === key ? original.baseVersion : item.baseVersion;
              if (!createdPeople.has(personId) && expectedVersion !== current.version) fail(409, 'Сведение уже изменилось. Проверьте текущую запись и запросите предложения заново.');
              const after = store.put('facts', revised(current, user, { ...fields, source: before.title, ...provenance(item) }));
              syncName(after);
              store.history('facts', after.id, user.id, 'accept_proposal', current, after);
            } else {
              if (original.personId === personId && original.key === key && original.baseVersion !== null) fail(409, 'Исходное сведение изменилось. Запросите предложения заново.');
              newFact(user, personId, key, fields.value, before.title, provenance(item), fields.nameParts);
            }
            links.add(personId);
          } else if (item.action === 'create_relation') {
            const fromId = resolve(item.fromId, item.fromName); const toId = resolve(item.toId, item.toName);
            newRelation(user, relationSchema.parse({ fromId, toId, type: item.relationType, parentKind: item.parentKind ?? 'unspecified', source: before.title }), provenance(item));
            item.fromId = fromId; item.toId = toId; links.add(fromId); links.add(toId);
          } else if (item.action === 'link_material') { const personId = resolve(item.personId, item.personName); item.personId = personId; links.add(personId); }
        }
        const acceptedMap = new Map(accepted.map(item => [item.id, item]));
        const after = store.put<Material>('materials', { ...before, personIds: [...links], proposals: proposals.map(item => acceptedMap.has(item.id) ? { ...acceptedMap.get(item.id)!, sourceQuote: item.sourceQuote, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, baseVersion: item.baseVersion, status: 'accepted' } : rejected.includes(item.id) ? { ...item, status: 'rejected' } : item), version: before.version + 1, updatedAt: now() });
        store.history('materials', after.id, user.id, 'review_proposals', before, after); return after;
      }));
    });
  }
  function registerAdministration() {
    app.post('/api/guest-links', (req, res) => {
      const user = actor(res); admin(user);
      const input = z.object({ role: z.enum(['member', 'viewer']).default('member'), userId: z.string().min(1).optional() }).parse(req.body ?? {});
      const target = input.userId ? get<User>('users', input.userId) : undefined;
      if (target && (target.authProvider !== 'guest' || target.role === 'admin' || target.status === 'rejected')) fail(400, 'Гостевую ссылку можно создать только для гостя без прав администратора.');
      const token = randomBytes(32).toString('hex');
      const invitation = store.put<InvitationLinkRecord>('invitation_links', { id: randomUUID(), role: target ? target.role as 'member' | 'viewer' : input.role, createdBy: user.id, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null, uses: 0, userId: target?.id ?? null, usedAt: null, tokenHash: hash(token) });
      res.status(201).json({ invitation: clientInvitationLink(invitation), token });
    });
    app.post('/api/guest-links/:id/revoke', (req, res) => {
      admin(actor(res));
      const invitation = get<InvitationLinkRecord>('invitation_links', String(req.params.id));
      res.json(clientInvitationLink(invitation.revokedAt ? invitation : store.put('invitation_links', { ...invitation, revokedAt: now() })));
    });
    app.post('/api/users/:id/approve', (req, res) => {
      admin(actor(res));
      const { role } = z.object({ role: z.enum(['member', 'viewer']) }).parse(req.body);
      res.json(store.transaction(() => {
        const user = get<User>('users', String(req.params.id));
        if (user.status !== 'pending' || !user.nameParts?.firstName || !user.nameParts.lastName || !user.phone) fail(409, 'Одобрить можно заявку с заполненными ФИО и телефоном.');
        return store.put('users', { ...user, role, status: 'active' as const });
      }));
    });
    app.post('/api/users/:id/reject', (req, res) => {
      admin(actor(res));
      res.json(store.transaction(() => {
        const user = get<User>('users', String(req.params.id));
        if (!['profile', 'pending'].includes(user.status || '')) fail(409, 'Отклонить можно только новую заявку.');
        return store.put('users', { ...user, status: 'rejected' as const });
      }));
    });
    app.patch('/api/me/person', (req, res) => {
      const { personId } = z.object({ personId: z.string().min(1).nullable() }).parse(req.body);
      res.json(store.transaction(() => {
        const user = get<User>('users', actor(res).id);
        if (personId) {
          get<Person>('people', personId);
          if (store.all<User>('users').some(item => item.id !== user.id && item.personId === personId)) fail(409, 'Эта карточка уже связана с другим участником.');
        }
        return store.put('users', { ...user, personId });
      }));
    });
    app.post('/api/invitations', (req, res) => {
      const user = actor(res); admin(user); const input = z.object({ email: z.email().max(254).transform(v => v.toLowerCase().trim()), role: roleSchema }).parse(req.body);
      if (store.all<User>('users').some(item => item.email === input.email)) fail(409, 'Этот человек уже в пространстве. Его роль можно изменить в списке участников.');
      const existing = store.all<Invitation>('invitations').find(item => item.email === input.email && !item.accepted);
      const invitation = store.put<Invitation>('invitations', { id: existing?.id ?? randomUUID(), email: input.email, role: input.role, accepted: false, createdAt: existing?.createdAt ?? now() }); res.status(existing ? 200 : 201).json(invitation);
    });
    app.patch('/api/users/:id', (req, res) => {
      admin(actor(res)); const input = z.object({ role: roleSchema }).parse(req.body);
      res.json(store.transaction(() => {
        const user = get<User>('users', String(req.params.id));
        if (!active(user)) fail(409, 'Сначала рассмотрите заявку участника.');
        if (user.authProvider === 'guest' && input.role === 'admin') fail(400, 'Гость не может быть администратором. Для этой роли нужен вход через Telegram.');
        if (user.role === 'admin' && input.role !== 'admin' && store.all<User>('users').filter(item => item.role === 'admin' && active(item)).length === 1) fail(409, 'В пространстве должен остаться хотя бы один администратор.');
        return store.put('users', { ...user, role: input.role });
      }));
    });
    app.get('/api/export', (_req, res) => {
      admin(actor(res));
      const data = Object.fromEntries(TABLES.filter(table => !['sessions', 'codes', 'auth_flows', 'jobs', 'invitation_links'].includes(table)).map(table => [table, store.all(table)]));
      res.attachment(`family-space-${new Date().toISOString().slice(0, 10)}.json`).json({ format: 'family-space-export', schemaVersion: 1, exportedAt: now(), name, ...data });
    });
  }
  async function runJob(job: Job) {
    const field = job.type === 'transcribe' ? 'transcriptionStatus' : 'extractionStatus';
    const before = get<Material>('materials', job.materialId);
    const people = store.all<Person>('people'); const facts = store.all<Fact>('facts');
    store.transaction(() => { store.put('jobs', { ...job, status: 'processing' }); store.put('materials', { ...before, [field]: 'processing', processingError: null }); });
    try {
      if ((before.transcript?.version ?? null) !== job.sourceVersion || hash(sourceText(before)) !== job.sourceHash) fail(409, 'Текст изменился до начала обработки. Запустите её заново.');
      let transcript: Transcript | null = null; let proposals: Proposal[] | null = null; let extractionRejectedCount = 0;
      if (job.type === 'transcribe') {
        if (!before.file) fail(400, 'Исходный файл не найден.');
        const file = get<FileRecord>('files', before.file.id);
        const result = await transcribeFile(join(store.filesDir, file.path), file.mime);
        transcript = { ...result, version: (before.transcript?.version ?? 0) + 1, automatic: true, updatedAt: now() };
      } else {
        const result = await extractProposals(sourceText(before), before.transcript?.segments ?? [], { people, facts });
        extractionRejectedCount = result.rejectedCount;
        proposals = result.proposals.map(item => ({ ...item, id: randomUUID(), status: 'pending', baseVersion: item.action === 'set_fact' && item.personId && item.key ? facts.find(fact => fact.personId === item.personId && fact.key === item.key)?.version ?? null : null }));
      }
      store.transaction(() => {
        const current = get<Material>('materials', job.materialId);
        if ((current.transcript?.version ?? null) !== job.sourceVersion || hash(sourceText(current)) !== job.sourceHash) fail(409, 'Текст изменился во время обработки. Запустите её заново.');
        const after = store.put<Material>('materials', { ...current, [field]: 'done', processingError: null, ...(transcript ? { transcript, proposals: invalidatePending(current.proposals), extractionStatus: 'idle', extractionRejectedCount: 0 } : {}), ...(proposals ? { extractionRejectedCount, proposals: [...invalidatePending(current.proposals), ...proposals] } : {}), version: current.version + 1, updatedAt: now() });
        store.put('jobs', { ...job, status: 'done' }); store.history('materials', after.id, job.actorId, job.type, current, after);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Не удалось обработать материал.';
      store.transaction(() => { const current = get<Material>('materials', job.materialId); store.put('materials', { ...current, [field]: 'error', processingError: message }); store.put('jobs', { ...job, status: 'error', error: message }); });
    }
  }
}

function sourceText(material: Material) { return material.transcript?.text ?? (material.kind === 'story' ? material.body : ''); }
function invalidatePending(proposals: Proposal[] = []): Proposal[] { return proposals.map(item => item.status === 'pending' ? { ...item, status: 'rejected' } : item); }
