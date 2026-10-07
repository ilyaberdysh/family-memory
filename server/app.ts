import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { createTelegramProvider, type TelegramProvider } from './telegram.js';
import { Database, FAMILY_TABLES, type FamilyStore, type GlobalStore } from './db.js';
import { isAiConfigured } from './ai.js';
import { registerConversations, ConversationError, type ConversationAI } from './conversations.js';
import { MediaError } from './media.js';
import { startBackupScheduler, type BackupScheduler } from './backups.js';
import { LocalBlobStore, sweepIncoming, storageStatus } from './files.js';
import { ApiError, actor, admin, asMember, fail, familyOf, hash, now, type Family, type Membership } from './http.js';
import { createWorkers, freshFile, namePartsSchema, registerArchive, registerTree, type ArchiveContext } from './archive.js';
import type { User, Material, Invitation, InvitationLink, FamilySummary } from '../shared/types.js';
import { cleanNameParts, fullName, NAME_PART_MAX_LENGTH } from '../shared/person-fields.js';

type Session = { id: string; userId: string; expires: number };
type Code = { id: string; name: string; hash: string; expires: number; attempts: number; sentAt: number };
type AuthFlow = { id: string; state: string; nonce: string; verifier: string; redirectUri: string; expires: number };
type InvitationLinkRecord = InvitationLink & { tokenHash: string; familyId: string };
export type AppOptions = { telegramProvider?: TelegramProvider; adminTelegramId?: string; conversationAI?: Partial<ConversationAI>; dataDir?: string; databaseUrl?: string; memoryDatabase?: boolean; bindHost?: string; devAuth?: boolean; production?: boolean; startWorker?: boolean; adminEmail?: string; minFreeDiskMb?: number; backupDir?: string };
export type Runtime = Awaited<ReturnType<typeof createApp>>;
const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(host);
const loopbackHostHeader = (host = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
const roleSchema = z.enum(['admin', 'member', 'viewer']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FAMILIES_PER_ACCOUNT = 20;

/** Profile and Telegram identity are the person's own; roles and admission belong to each family membership. */
const accountActive = (user: User) => !user.status || user.status === 'active';

export async function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const bindHost = options.bindHost ?? process.env.HOST ?? '127.0.0.1';
  const devMode = !production && (options.devAuth ?? process.env.DEV_AUTH === '1') && loopback(bindHost);
  const adminEmail = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data');
  const db = await Database.open(options.memoryDatabase ? { memory: true } : { url: options.databaseUrl ?? process.env.DATABASE_URL, directory: dataDir });
  const blobs = new LocalBlobStore(join(dataDir, 'files'));
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  const maxUploadMb = Math.min(2048, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 250));
  const serviceName = process.env.SERVICE_NAME || 'Семейная память';
  const telegram = options.telegramProvider ?? createTelegramProvider();
  const adminTelegramId = (options.adminTelegramId ?? process.env.ADMIN_TELEGRAM_ID ?? '').trim();
  const incoming = join(dataDir, 'files', '.incoming');
  const minFreeBytes = Math.max(0, options.minFreeDiskMb ?? (Number(process.env.MIN_FREE_DISK_MB) || 1024)) * 1024 * 1024;
  const familyLimitMb = Number(process.env.FAMILY_STORAGE_LIMIT_MB) || 0;
  const familyLimitBytes = familyLimitMb > 0 ? familyLimitMb * 1024 * 1024 : null;
  // Local preview trusts loopback sockets, so a rebound DNS name must not reach it through the browser.
  if (devMode) app.use((req, res, next) => loopbackHostHeader(req.get('host')) ? next() : void res.status(421).json({ error: 'Локальный просмотр открывается только по адресу 127.0.0.1 или localhost.' }));
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

  const cookieValue = (req: Request, key: string) => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
  const sessionId = (req: Request) => cookieValue(req, 'family_session');
  const previewRequest = (req: Request) => devMode && loopback(req.socket.remoteAddress || '');
  const serviceOwner = (user: User) => (!!adminTelegramId && user.telegramId === adminTelegramId) || (devMode && !production);
  const sessionLifetime = 365 * 86400000;
  const sessionCookie = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: '/' };
  const flowCookie = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: '/api/auth/telegram' };
  const newSession = async (g: GlobalStore, user: User) => {
    const token = randomBytes(32).toString('hex');
    await g.put<Session & { userId: string }>('sessions', { id: hash(token), userId: user.id, expires: Date.now() + sessionLifetime });
    return token;
  };
  const setSession = (res: Response, token: string) => res.cookie('family_session', token, { ...sessionCookie, maxAge: sessionLifetime });
  const sessionUser = async (req: Request): Promise<User | undefined> => {
    const token = sessionId(req); if (!token) return undefined;
    return db.global(async g => {
      const session = await g.get<Session>('sessions', hash(token));
      return session && session.expires > Date.now() ? g.get<User>('users', session.userId) : undefined;
    });
  };
  const requireSession = async (req: Request) => (await sessionUser(req)) ?? fail(401, 'Войдите в семейное пространство.');
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
  const invitationFromToken = async (g: GlobalStore, token: unknown) => activeInvitationLink(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? (await g.where<InvitationLinkRecord>('invitation_links', "data->>'tokenHash' = $1", hash(token)))[0] : undefined);
  const loginRates = new Map<string, { count: number; until: number }>();
  function loginRate(req: Request, kind: string) {
    const key = `${kind}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const rate = loginRates.get(key);
    if (rate && rate.until > Date.now() && rate.count >= 20) fail(429, 'Слишком много попыток. Попробуйте через 15 минут.');
    loginRates.set(key, rate && rate.until > Date.now() ? { ...rate, count: rate.count + 1 } : { count: 1, until: Date.now() + 900000 });
    if (loginRates.size > 1000) for (const [key, item] of loginRates) if (item.until < Date.now()) loginRates.delete(key);
  }
  /** Public on invitations: only surnames the family admin chose plus current tree surnames; never maiden names. */
  const familySurnames = async (s: FamilyStore, family: Family) => {
    const names = [...(family.surnames ?? []), ...(await s.raw("SELECT data->'nameParts'->>'lastName' AS name FROM people WHERE family_id = $1 ORDER BY seq LIMIT 200", [s.familyId])).map(row => String(row.name ?? ''))];
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
  const summaries = async (g: GlobalStore, userId: string): Promise<FamilySummary[]> => (await g.raw(
    `SELECT f.data AS family, m.data AS membership, (SELECT count(*) FROM memberships x WHERE x.family_id = f.id AND x.data->>'status' = 'active') AS members
     FROM memberships m JOIN families f ON f.id = m.family_id WHERE m.user_id = $1 ORDER BY m.seq`, [userId]))
    .map(row => { const family = row.family as Family; const membership = row.membership as Membership; return { id: family.id, name: family.name, role: membership.role, status: membership.status, memberCount: Number(row.members) }; });
  const joinFamily = async (g: GlobalStore, familyId: string, user: User, role: Membership['role'], status: Membership['status'] = 'active') => {
    const existing = (await g.where<Membership>('memberships', 'family_id = $1 AND user_id = $2', familyId, user.id))[0];
    if (existing) { if (existing.status === 'removed' || existing.status === 'rejected') fail(410, 'Доступ к этой семье закрыт администратором.'); return existing; }
    return g.put<Membership & { familyId: string; userId: string }>('memberships', { id: randomUUID(), familyId, userId: user.id, role, status, personId: null, createdAt: now() });
  };

  // Unauthenticated liveness: no family data, only whether storage answers.
  app.get('/api/health', async (_req, res) => {
    try { await db.global(g => g.raw('SELECT 1')); res.json({ ok: true, diskLow: storageStatus(blobs.root, minFreeBytes).low }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.get('/api/auth/config', (req, res) => res.json({ devMode: previewRequest(req), mailAvailable: false, telegramAvailable: telegram.configured, name: serviceName }));
  app.get('/api/auth/session', async (req, res) => {
    const user = await sessionUser(req);
    res.json({ user: user ?? null, families: user ? await db.global(g => summaries(g, user.id)) : [] });
  });
  app.post('/api/auth/telegram/start', async (req, res) => {
    if (!telegram.configured) fail(503, 'Вход через Telegram ещё не настроен.');
    loginRate(req, 'telegram');
    const origin = process.env.PUBLIC_ORIGIN || (!production ? `${req.protocol}://${req.get('host')}` : '');
    if (!origin || (production && new URL(origin).protocol !== 'https:')) fail(503, 'Администратору нужно настроить адрес входа через Telegram.');
    const token = randomBytes(32).toString('hex');
    const flow: AuthFlow = { id: hash(token), state: randomBytes(32).toString('hex'), nonce: randomBytes(32).toString('hex'), verifier: randomBytes(32).toString('base64url'), redirectUri: new URL('/api/auth/telegram/callback', origin).href, expires: Date.now() + 600000 };
    const url = await telegram.authorizationUrl(flow);
    const previousCookie = cookieValue(req, 'family_telegram');
    await db.global(async g => {
      await g.delete('auth_flows', "(data->>'expires')::bigint <= $1", Date.now());
      if (previousCookie) await g.delete('auth_flows', 'id = $1', hash(previousCookie));
      await g.put('auth_flows', flow);
    });
    res.cookie('family_telegram', token, { ...flowCookie, maxAge: 600000 });
    res.json({ url });
  });
  app.get('/api/auth/telegram/callback', async (req, res) => {
    res.clearCookie('family_telegram', flowCookie);
    try {
      const token = cookieValue(req, 'family_telegram');
      if (!token) fail(400, 'Missing flow');
      const flow = await db.global(async g => { const value = await g.get<AuthFlow>('auth_flows', hash(token)); if (value) await g.delete('auth_flows', 'id = $1', value.id); return value; });
      if (!flow || flow.expires <= Date.now() || typeof req.query.state !== 'string' || req.query.state !== flow.state) fail(400, 'Invalid flow');
      const identity = await telegram.exchange({ callbackUrl: new URL(req.originalUrl, flow.redirectUri).href, state: flow.state, nonce: flow.nonce, verifier: flow.verifier, redirectUri: flow.redirectUri });
      const tokenForSession = await db.global(async g => {
        if (!identity.telegramId || !identity.subject) fail(400, 'Missing identity');
        const matches = await g.where<User>('users', "data->>'telegramSubject' = $1 OR data->>'telegramId' = $2", identity.subject, identity.telegramId);
        if (matches.length > 1) fail(409, 'Conflicting identity');
        let account = matches[0];
        if (account && ((account.telegramId && account.telegramId !== identity.telegramId) || (account.telegramSubject && account.telegramSubject !== identity.subject))) fail(409, 'Conflicting identity');
        // A migrated single-family install has one local administrator; its designated owner binds to it once.
        if (!account && adminTelegramId && identity.telegramId === adminTelegramId) {
          const legacy = (await g.where<User>('users', "coalesce(data->>'telegramId', '') = '' AND coalesce(data->>'telegramSubject', '') = '' AND (data->>'email' = 'admin@local.invalid' OR ($1 <> '' AND data->>'email' = $1))", adminEmail));
          if (legacy.length === 1) account = legacy[0];
        }
        if (account) account = await g.put('users', { ...account, telegramId: identity.telegramId, telegramSubject: identity.subject, authProvider: 'telegram' as const });
        else account = await g.put<User>('users', { id: randomUUID(), email: '', name: identity.name, role: 'member', status: 'profile', authProvider: 'telegram', telegramId: identity.telegramId, telegramSubject: identity.subject, ...(identity.phone ? { phone: normalizePhone(identity.phone), phoneVerified: identity.phoneVerified } : {}) });
        return newSession(g, account);
      });
      setSession(res, tokenForSession); res.redirect('/');
    } catch { res.redirect('/?auth=telegram_failed'); }
  });
  app.post('/api/auth/guest-preview', async (req, res) => {
    const { link, family } = await db.global(async g => { const link = await invitationFromToken(g, req.body?.token); return { link, family: (await g.get<Family>('families', link.familyId))! }; });
    const surnames = await db.family(family.id, s => familySurnames(s, family));
    res.json({ role: link.role, expiresAt: link.expiresAt, family: { name: family.name, surnames } });
  });
  /** Redeeming a link joins its family: with the signed-in account if there is one, otherwise as a new guest account. */
  app.post('/api/auth/guest', async (req, res) => {
    loginRate(req, 'guest');
    const current = await sessionUser(req);
    const result = await db.global(async g => {
      const link = await invitationFromToken(g, req.body?.token);
      let account: User;
      if (link.userId) {
        account = (await g.get<User>('users', link.userId)) ?? fail(410, 'Ссылка больше не действует. Попросите администратора прислать новую.');
        if (account.authProvider !== 'guest' || await g.exists('memberships', "user_id = $1 AND family_id <> $2 AND data->>'status' IN ('active', 'pending')", account.id, link.familyId)) fail(410, 'Ссылка больше не действует. Попросите администратора прислать новую.');
      } else account = current ?? await g.put<User>('users', { id: randomUUID(), name: '', email: '', role: 'member', status: 'profile', authProvider: 'guest', phoneVerified: false });
      const membership = await joinFamily(g, link.familyId, account, link.role);
      if (membership.role === 'admin' && link.userId) fail(410, 'Ссылка больше не действует. Попросите администратора прислать новую.');
      await g.put('invitation_links', { ...link, userId: account.id, usedAt: now(), uses: 1 });
      return { account, familyId: link.familyId, token: current?.id === account.id ? null : await newSession(g, account) };
    });
    if (result.token) setSession(res, result.token);
    res.json({ user: result.account, familyId: result.familyId });
  });
  app.post('/api/auth/profile', async (req, res) => {
    const user = await requireSession(req);
    const input = z.object({ nameParts: namePartsSchema.extend({ firstName: z.string().trim().min(1).max(NAME_PART_MAX_LENGTH), lastName: z.string().trim().min(1).max(NAME_PART_MAX_LENGTH) }), phone: z.string().trim().max(40) }).parse(req.body);
    const phone = normalizePhone(input.phone);
    const nameParts = cleanNameParts(input.nameParts);
    res.json(await db.global(g => g.put('users', { ...user, name: fullName(nameParts), nameParts, phone, phoneVerified: user.phone === phone && !!user.phoneVerified, status: 'active' as const })));
  });
  // Explicit loopback preview login; never an alternate production login.
  app.post('/api/auth/request-code', async (req, res) => {
    if (!previewRequest(req)) fail(410, 'Вход по email больше не используется. Войдите через Telegram или гостевую ссылку.');
    const input = z.object({ email: z.email().max(254).transform(v => v.trim().toLowerCase()), name: z.string().trim().min(2).max(150) }).parse(req.body);
    loginRate(req, 'local');
    const code = String(randomInt(100000, 1000000));
    await db.global(async g => {
      const previous = await g.get<Code>('codes', input.email);
      if (previous && Date.now() - previous.sentAt < 30000) fail(429, 'Код уже отправлен. Повторить можно через 30 секунд.');
      await g.put<Code>('codes', { id: input.email, name: input.name, hash: hash(`${input.email}:${code}`), expires: Date.now() + 600000, attempts: 0, sentAt: Date.now() });
    });
    res.json({ ok: true, devCode: code });
  });
  app.post('/api/auth/verify', async (req, res) => {
    if (!previewRequest(req)) fail(410, 'Вход по email больше не используется. Войдите через Telegram или гостевую ссылку.');
    const { email, code } = z.object({ email: z.email().transform(v => v.toLowerCase().trim()), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const record = await db.global(async g => {
      const record = await g.get<Code>('codes', email);
      if (!record || record.expires < Date.now() || record.attempts >= 5) fail(400, 'Код истёк или больше не действует. Запросите новый.');
      await g.put('codes', { ...record, attempts: record.attempts + 1 });
      return record;
    });
    if (!timingSafeEqual(Buffer.from(record.hash), Buffer.from(hash(`${email}:${code}`)))) fail(400, 'Неверный код.');
    // Pending email invitations live inside families; accepting them is deliberate cross-family maintenance.
    const invitations = await db.system(g => g.raw("SELECT id, family_id, data FROM invitations WHERE data->>'email' = $1 AND (data->>'accepted')::boolean IS NOT TRUE", [email]));
    const result = await db.global(async g => {
      const account = (await g.where<User>('users', "lower(data->>'email') = $1", email))[0] ?? await g.put<User>('users', { id: randomUUID(), email, name: record.name, role: 'member', authProvider: 'local', status: 'active' });
      for (const row of invitations) await joinFamily(g, row.family_id as string, account, (row.data as Invitation).role);
      await g.delete('codes', 'id = $1', email);
      return { account, token: await newSession(g, account) };
    });
    for (const row of invitations) await db.family(row.family_id as string, s => s.put('invitations', { ...(row.data as Invitation), accepted: true }));
    setSession(res, result.token); res.json(result.account);
  });
  app.post('/api/auth/logout-all', async (req, res) => {
    const user = await requireSession(req);
    await db.global(g => g.delete('sessions', 'user_id = $1', user.id));
    res.clearCookie('family_session', sessionCookie); res.json({ ok: true });
  });
  app.post('/api/auth/logout', async (req, res) => { const token = sessionId(req); if (token) await db.global(g => g.delete('sessions', 'id = $1', hash(token))); res.clearCookie('family_session', sessionCookie); res.json({ ok: true }); });

  // Everything below requires a signed-in account with a completed profile.
  app.use('/api', async (req, res, next) => {
    try {
      const user = await sessionUser(req);
      if (!user) return next(new ApiError(401, 'Войдите в семейное пространство.'));
      if (!accountActive(user)) return next(new ApiError(403, 'Сначала заполните профиль.', 'profile_required'));
      res.locals.user = user; next();
    } catch (error) { next(error); }
  });
  app.post('/api/families', async (req, res) => {
    const user = res.locals.user as User;
    const { name } = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    const summary = await db.global(async g => {
      if ((await g.where<Membership>('memberships', "user_id = $1 AND data->>'role' = 'admin'", user.id)).length >= MAX_FAMILIES_PER_ACCOUNT) fail(429, 'Слишком много семейных пространств у одного аккаунта.');
      const family = await g.put<Family>('families', { id: randomUUID(), name, surnames: [], createdBy: user.id, createdAt: now() });
      await joinFamily(g, family.id, user, 'admin');
      return (await summaries(g, user.id)).find(item => item.id === family.id)!;
    });
    res.status(201).json(summary);
  });
  // Media URLs (img/audio src) cannot carry a header; their route resolves the family from the file itself.
  const media = { kick: () => workers.kick() };
  const route: ArchiveContext['route'] = handler => async (req, res) => {
    const result = await db.family(familyOf(res), store => handler(store, req, res));
    if (!res.headersSent) res.json(result);
  };
  const context: ArchiveContext = { app, db, blobs, incoming, maxUploadMb, minFreeBytes, familyLimitBytes, route };
  const workers = createWorkers(context);
  // The family is chosen per request; membership is checked against the database every time.
  app.use('/api', async (req, res, next) => {
    try {
      if (req.method === 'GET' && /^\/files\/[^/]+(\/original)?$/.test(req.path)) return next();
      // Family settings name their family in the path; everything else uses the header.
      const familyId = req.get('X-Family-Id') ?? /^\/families\/([^/]+)$/.exec(req.path)?.[1] ?? '';
      if (!uuid.test(familyId)) return next(new ApiError(400, 'Выберите семейное пространство.', 'family_required'));
      const user = res.locals.user as User;
      const membership = await db.global(g => g.where<Membership>('memberships', 'family_id = $1 AND user_id = $2', familyId, user.id));
      if (!membership[0]) return next(new ApiError(404, 'Семейное пространство не найдено.', 'not_member'));
      if (membership[0].status !== 'active') return next(new ApiError(403, membership[0].status === 'removed' ? 'Доступ к семейному пространству закрыт администратором.' : membership[0].status === 'rejected' ? 'Заявка отклонена. Обратитесь к администратору.' : 'Доступ к семейному пространству откроется после одобрения администратора.', 'not_member'));
      res.locals.familyId = familyId; res.locals.member = asMember(user, membership[0]); next();
    } catch (error) { next(error); }
  });
  app.patch('/api/families/:id', route(async (s, req, res) => {
    if (req.params.id !== s.familyId) fail(404, 'Семейное пространство не найдено.'); admin(actor(res));
    const input = z.object({ name: z.string().trim().min(2).max(120).optional(), surnames: z.array(z.string().trim().min(1).max(NAME_PART_MAX_LENGTH)).max(5).optional() }).parse(req.body);
    const family = (await s.global.get<Family>('families', s.familyId))!;
    const after = await s.global.put('families', { ...family, ...input });
    await s.history('families', family.id, actor(res).id, 'edit', family, after);
    return (await summaries(s.global, actor(res).id)).find(item => item.id === s.familyId);
  }));
  /** Members of this family with their membership role/status; contacts are visible to administrators only. */
  const members = async (s: FamilyStore) => (await s.raw('SELECT u.data AS user, m.data AS membership FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.family_id = $1 ORDER BY m.seq', [s.familyId]))
    .map(row => asMember(row.user as User, row.membership as Membership));
  app.get('/api/state', route(async (s, _req, res) => {
    const user = actor(res);
    const family = (await s.global.get<Family>('families', s.familyId))!;
    const storageBytes = Number((await s.raw("SELECT coalesce(sum((data->>'size')::bigint + coalesce((data->>'previewSize')::bigint, 0)), 0) AS n FROM files WHERE family_id = $1", [s.familyId]))[0].n);
    const operations = serviceOwner(user) ? { backup: backups?.status() ?? null, storage: storageStatus(blobs.root, minFreeBytes) } : {};
    const users = (await members(s)).filter(item => user.role === 'admin' || item.status === 'active').map(item => {
      if (user.role === 'admin' || item.id === user.id) return item;
      const { phone, phoneVerified, telegramId, telegramSubject, email, ...publicUser } = item;
      return { ...publicUser, email: '' };
    });
    const materials = await Promise.all((await s.all<Material>('materials', "data - 'transcript' - 'proposals'")).map(async material => ({ ...material, file: await freshFile(s, material.file) })));
    return {
      user, users, people: await s.all('people'), facts: await s.all('facts'), relations: await s.all('relations'), materials,
      invitations: user.role === 'admin' ? await s.all('invitations') : [],
      invitationLinks: user.role === 'admin' ? (await s.global.where<InvitationLinkRecord>('invitation_links', 'family_id = $1', s.familyId)).map(clientInvitationLink) : [],
      family: { id: family.id, name: family.name, surnames: await familySurnames(s, family), storageBytes, storageLimitBytes: familyLimitBytes },
      settings: { name: family.name, surnames: await familySurnames(s, family), devMode, aiAvailable: isAiConfigured(), maxUploadMb, ...operations },
    };
  }));
  registerTree(context);
  registerArchive(context, media);
  registerAdministration();
  const conversations = registerConversations(app, db, blobs, route, options.conversationAI);
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Такого API-адреса нет.')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return void res.status(400).json({ error: 'Проверьте заполненные поля.', details: error.issues.map(item => ({ path: item.path.join('.'), message: item.message })) });
    if (error instanceof multer.MulterError) return void res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${maxUploadMb} МБ.` : 'Не удалось принять файл. Проверьте формат загрузки.' });
    if (error instanceof ConversationError) return void res.status(error.status).json({ error: error.message });
    if (error instanceof ApiError) return void res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    if (error instanceof MediaError) return void res.status(error.status).json({ error: error.message });
    if ((error as { type?: string })?.type === 'entity.too.large') return void res.status(413).json({ error: 'Текст слишком большой.' });
    if (error instanceof SyntaxError && 'body' in error) return void res.status(400).json({ error: 'Не удалось прочитать данные запроса.' });
    if ((error as { code?: string })?.code === '23505') return void res.status(409).json({ error: 'Такая запись уже существует.' });
    console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Не удалось сохранить изменения. Попробуйте ещё раз.' });
  });

  await db.global(g => g.delete('sessions', "(data->>'expires')::bigint < $1", Date.now()));
  void sweepIncoming(incoming);
  await workers.recover();
  await conversations.recover();
  if (options.startWorker !== false) workers.kick();
  // Without BACKUP_DIR the scheduler only reports manual CLI backups from backup-status.json.
  const setting = (key: string) => process.env[key]?.trim() ? Number(process.env[key]) : undefined;
  const firstDelayMinutes = setting('BACKUP_FIRST_DELAY_MINUTES');
  const backups: BackupScheduler | null = startBackupScheduler({
    db, dataDir,
    backupDir: options.startWorker === false ? options.backupDir : options.backupDir ?? (process.env.BACKUP_DIR?.trim() || undefined),
    intervalHours: setting('BACKUP_INTERVAL_HOURS'), keep: setting('BACKUP_KEEP'),
    firstDelayMs: firstDelayMinutes === undefined ? undefined : firstDelayMinutes * 60_000,
  });
  const timer = options.startWorker === false ? null : setInterval(() => { void workers.processNextJob().catch(error => console.error('Processing failed:', error instanceof Error ? error.message : error)); }, 1000);
  timer?.unref();
  let closed = false;
  return {
    app, db, blobs, dataDir,
    processNextJob: () => workers.processNextJob(), processMedia: () => workers.drain(),
    close: async () => { if (closed) return; closed = true; await conversations.close(); if (timer) clearInterval(timer); await workers.close(); await backups?.close(); await db.close(); },
  };

  function registerAdministration() {
    // Authority changes are audited without copying contact details into history.
    const audit = (s: FamilyStore, actorId: string, before: Membership, after: Membership, action: string) => s.history('users', after.userId, actorId, action, { role: before.role, status: before.status }, { role: after.role, status: after.status });
    const membershipOf = async (s: FamilyStore, userId: string) => (await s.global.where<Membership>('memberships', 'family_id = $1 AND user_id = $2', s.familyId, userId))[0] ?? fail(404, 'Участник не найден.');
    const activeAdmins = async (s: FamilyStore) => (await s.global.where<Membership>('memberships', "family_id = $1 AND data->>'role' = 'admin' AND data->>'status' = 'active'", s.familyId)).length;
    const memberView = async (s: FamilyStore, membership: Membership) => asMember((await s.global.get<User>('users', membership.userId))!, membership);
    app.post('/api/guest-links', route(async (s, req, res) => {
      const user = actor(res); admin(user);
      const input = z.object({ role: z.enum(['member', 'viewer']).default('member'), userId: z.string().min(1).optional() }).parse(req.body ?? {});
      let role = input.role;
      if (input.userId) {
        const target = await s.global.get<User>('users', input.userId); const membership = target && await membershipOf(s, target.id);
        if (!target || !membership || target.authProvider !== 'guest' || membership.role === 'admin' || ['removed', 'rejected'].includes(membership.status)) fail(400, 'Гостевую ссылку можно создать только для гостя без прав администратора.');
        // A re-login link signs the guest in everywhere, so one family must not be able to issue it for a guest of another.
        if (await s.global.exists('memberships', "user_id = $1 AND family_id <> $2 AND data->>'status' IN ('active', 'pending')", target.id, s.familyId)) fail(409, 'Этот гость состоит и в другой семье. Новую ссылку для входа может выдать только единственная семья гостя.');
        role = membership.role as 'member' | 'viewer';
      }
      const token = randomBytes(32).toString('hex');
      const invitation = await s.global.put<InvitationLinkRecord>('invitation_links', { id: randomUUID(), familyId: s.familyId, role, createdBy: user.id, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null, uses: 0, userId: input.userId ?? null, usedAt: null, tokenHash: hash(token) });
      res.status(201); return { invitation: clientInvitationLink(invitation), token };
    }));
    app.post('/api/guest-links/:id/revoke', route(async (s, req, res) => {
      admin(actor(res));
      const invitation = (await s.global.where<InvitationLinkRecord>('invitation_links', 'id = $1 AND family_id = $2', String(req.params.id), s.familyId))[0] ?? fail(404, 'Запись не найдена.');
      return clientInvitationLink(invitation.revokedAt ? invitation : await s.global.put('invitation_links', { ...invitation, revokedAt: now() }));
    }));
    app.post('/api/users/:id/approve', route(async (s, req, res) => {
      admin(actor(res));
      const { role } = z.object({ role: z.enum(['member', 'viewer']) }).parse(req.body);
      const membership = await membershipOf(s, String(req.params.id)); const user = await memberView(s, membership);
      if (membership.status !== 'pending' || !user.nameParts?.firstName || !user.nameParts.lastName || !user.phone) fail(409, 'Одобрить можно заявку с заполненными ФИО и телефоном.');
      const after = await s.global.put('memberships', { ...membership, role, status: 'active' as const }); await audit(s, actor(res).id, membership, after, 'approve'); return asMember(user, after);
    }));
    app.post('/api/users/:id/reject', route(async (s, req, res) => {
      admin(actor(res));
      const membership = await membershipOf(s, String(req.params.id));
      if (membership.status !== 'pending') fail(409, 'Отклонить можно только новую заявку.');
      const after = await s.global.put('memberships', { ...membership, status: 'rejected' as const }); await audit(s, actor(res).id, membership, after, 'reject'); return asMember(await memberView(s, membership), after);
    }));
    // Closing access keeps every contribution and its authorship. Sessions are global, so they end only when
    // the person has no other active family; otherwise this family is simply no longer reachable for them.
    app.post('/api/users/:id/deactivate', route(async (s, req, res) => {
      const actingAdmin = actor(res); admin(actingAdmin);
      const membership = await membershipOf(s, String(req.params.id));
      if (membership.userId === actingAdmin.id) fail(409, 'Нельзя закрыть доступ самому себе.');
      if (membership.status !== 'active') fail(409, 'Закрыть доступ можно только активному участнику.');
      if (membership.role === 'admin' && await activeAdmins(s) === 1) fail(409, 'В пространстве должен остаться хотя бы один администратор.');
      const after = await s.global.put('memberships', { ...membership, status: 'removed' as const });
      if (!await s.global.exists('memberships', "user_id = $1 AND data->>'status' = 'active'", membership.userId)) await s.global.delete('sessions', 'user_id = $1', membership.userId);
      await audit(s, actingAdmin.id, membership, after, 'deactivate'); return asMember(await memberView(s, membership), after);
    }));
    app.post('/api/users/:id/reactivate', route(async (s, req, res) => {
      admin(actor(res));
      const membership = await membershipOf(s, String(req.params.id));
      if (membership.status !== 'removed') fail(409, 'Вернуть доступ можно участнику, у которого он был закрыт.');
      const after = await s.global.put('memberships', { ...membership, status: 'active' as const }); await audit(s, actor(res).id, membership, after, 'reactivate'); return asMember(await memberView(s, membership), after);
    }));
    app.patch('/api/me/person', route(async (s, req, res) => {
      const { personId } = z.object({ personId: z.string().min(1).nullable() }).parse(req.body);
      const membership = await membershipOf(s, actor(res).id);
      if (personId) {
        if (!await s.get('people', personId)) fail(404, 'Запись не найдена.');
        if (await s.global.exists('memberships', "family_id = $1 AND user_id <> $2 AND data->>'personId' = $3", s.familyId, membership.userId, personId)) fail(409, 'Эта карточка уже связана с другим участником.');
      }
      return asMember(res.locals.user as User, await s.global.put('memberships', { ...membership, personId }));
    }));
    app.post('/api/invitations', route(async (s, req, res) => {
      const user = actor(res); admin(user); const input = z.object({ email: z.email().max(254).transform(v => v.toLowerCase().trim()), role: roleSchema }).parse(req.body);
      if ((await members(s)).some(item => item.email === input.email)) fail(409, 'Этот человек уже в пространстве. Его роль можно изменить в списке участников.');
      const existing = (await s.where<Invitation>('invitations', "data->>'email' = $2 AND (data->>'accepted')::boolean IS NOT TRUE", input.email))[0];
      const invitation = await s.put<Invitation>('invitations', { id: existing?.id ?? randomUUID(), email: input.email, role: input.role, accepted: false, createdAt: existing?.createdAt ?? now() });
      res.status(existing ? 200 : 201); return invitation;
    }));
    app.patch('/api/users/:id', route(async (s, req, res) => {
      admin(actor(res)); const input = z.object({ role: roleSchema }).parse(req.body);
      const membership = await membershipOf(s, String(req.params.id)); const user = await memberView(s, membership);
      if (membership.status !== 'active') fail(409, 'Сначала рассмотрите заявку участника.');
      if (user.authProvider === 'guest' && input.role === 'admin') fail(400, 'Гость не может быть администратором. Для этой роли нужен вход через Telegram.');
      if (membership.role === 'admin' && input.role !== 'admin' && await activeAdmins(s) === 1) fail(409, 'В пространстве должен остаться хотя бы один администратор.');
      const after = await s.global.put('memberships', { ...membership, role: input.role }); await audit(s, actor(res).id, membership, after, 'role'); return asMember(user, after);
    }));
    /** Streams one family's records (no sessions, links or other families) so large archives do not build one huge string. */
    app.get('/api/export', async (_req, res) => {
      admin(actor(res));
      await db.family(familyOf(res), async s => {
        const family = (await s.global.get<Family>('families', s.familyId))!;
        res.attachment(`family-space-${new Date().toISOString().slice(0, 10)}.json`).type('application/json');
        res.write(`{"format":"family-space-export","schemaVersion":2,"exportedAt":${JSON.stringify(now())},"family":${JSON.stringify(family)},"members":${JSON.stringify((await members(s)).map(({ phone, telegramId, telegramSubject, ...member }) => member))}`);
        for (const table of FAMILY_TABLES.filter(table => table !== 'jobs')) {
          res.write(`,${JSON.stringify(table)}:[`);
          (await s.all(table)).forEach((row, index) => res.write((index ? ',' : '') + JSON.stringify(row)));
          res.write(']');
        }
        res.end('}');
      });
    });
  }
}
