import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { TelegramProvider, TelegramIdentity } from '../server/telegram.js';
import type { FamilySummary, InvitationLink, User } from '../shared/types.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const profile = { nameParts: { firstName: 'Тест', lastName: 'Проверка', patronymic: '' }, phone: '+7 (999) 123-45-67' };
type Who = { cookie: string; family?: string };
type Membership = { id: string; familyId: string; userId: string; role: string; status: string; personId: string | null; createdAt: string };

async function fixture(options: { adminTelegramId?: string; production?: boolean; legacy?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-membership-'));
  let identity: TelegramIdentity = { subject: 'telegram:100', telegramId: '100', name: 'Test', phone: '+79991234567', phoneVerified: true };
  let exchanges = 0;
  const provider: TelegramProvider = {
    configured: true,
    authorizationUrl: async input => `https://telegram.example.test/authorize?state=${input.state}`,
    exchange: async input => { exchanges++; assert.ok(input.nonce); assert.ok(input.verifier.length >= 43); assert.equal(new URL(input.callbackUrl).searchParams.get('state'), input.state); return identity; },
  };
  const runtime = await createApp({ memoryDatabase: true, databaseUrl: '', dataDir, telegramProvider: provider, adminTelegramId: options.adminTelegramId || '', devAuth: true, production: options.production || false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, who: Who | string = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const { cookie, family } = typeof who === 'string' ? { cookie: who, family: undefined } : who;
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Cookie: cookie, ...(family ? { 'X-Family-Id': family } : {}), 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers, cookie: response.headers.getSetCookie().find(value => value.startsWith('family_session='))?.split(';')[0] || '' };
  };
  const session = async (userId: string) => { const token = randomUUID(); await runtime.db.global(g => g.put('sessions', { id: digest(token), userId, expires: Date.now() + 100000 })); return `family_session=${token}`; };
  const start = async () => {
    const result = await request('/api/auth/telegram/start', '', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { state: new URL(result.body.url).searchParams.get('state')!, cookie: result.headers.getSetCookie().find(value => value.startsWith('family_telegram='))!.split(';')[0] };
  };
  const telegram = async (next?: Partial<TelegramIdentity>) => {
    identity = { ...identity, ...next };
    const flow = await start();
    return request(`/api/auth/telegram/callback?state=${flow.state}&code=test`, flow.cookie);
  };
  const login = async (email: string) => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const result = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { cookie: result.cookie, id: result.body.id as string };
  };
  const createFamily = async (cookie: string, name: string) => { const created = await request('/api/families', cookie, { name }); assert.equal(created.status, 201, JSON.stringify(created.body)); return created.body.id as string; };
  // Production has no local login, so there is no administrator to create there.
  const account = options.production ? { cookie: '', id: '' } : await login('admin@example.test');
  const familyId = options.production ? '' : await createFamily(account.cookie, 'Синтетическая семья');
  const admin = { id: account.id, cookie: account.cookie, family: familyId };
  const sessionInfo = async (cookie: string) => (await request('/api/auth/session', cookie)).body as { user: User | null; families: FamilySummary[] };
  const users = () => runtime.db.global(g => g.where<User>('users', 'true'));
  const membership = async (userId: string, family = familyId) => (await runtime.db.global(g => g.where<Membership>('memberships', 'family_id = $1 AND user_id = $2', family, userId)))[0];
  /** Pending memberships come only from migrated single-family data; tests insert them directly. */
  const addMembership = (userId: string, status: string, role = 'member', family = familyId) => runtime.db.global(g => g.put('memberships', { id: randomUUID(), familyId: family, userId, role, status, personId: null, createdAt: new Date().toISOString() }));
  const setMembership = async (userId: string, changes: Partial<Membership>, family = familyId) => { const current = (await membership(userId, family))!; await runtime.db.global(g => g.put('memberships', { ...current, ...changes })); };
  return { ...runtime, base, admin, familyId, request, session, start, telegram, login, createFamily, sessionInfo, users, membership, addMembership, setMembership,
    exchanges: () => exchanges,
    cleanup: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('Telegram profile sessions reach no family APIs; admission is per family and grants only the selected role', async () => {
  const f = await fixture();
  try {
    const login = await f.telegram(); assert.equal(login.headers.get('location'), '/');
    const before = await f.sessionInfo(login.cookie);
    assert.equal(before.user!.status, 'profile'); assert.deepEqual(before.families, []);
    const visitor = { cookie: login.cookie, family: f.familyId };
    for (const path of ['/api/state', '/api/conversations', '/api/materials/missing', '/api/files/missing']) {
      const blocked = await f.request(path, visitor); assert.equal(blocked.status, 403, path); assert.equal(blocked.body.code, 'profile_required');
    }
    assert.equal((await f.request('/api/families', login.cookie, { name: 'Ранняя семья' })).status, 403);
    // Not a member of the administrator's family: nothing to approve or promote there.
    assert.equal((await f.request(`/api/users/${before.user!.id}/approve`, f.admin, { role: 'member' })).status, 404);
    assert.equal((await f.request(`/api/users/${before.user!.id}`, f.admin, { role: 'admin' }, 'PATCH')).status, 404);
    const submitted = await f.request('/api/auth/profile', login.cookie, { ...profile, role: 'admin', status: 'active' });
    assert.equal(submitted.body.status, 'active'); assert.equal(submitted.body.role, 'member'); assert.equal(submitted.body.phone, '+79991234567'); assert.equal(submitted.body.phoneVerified, true);
    const outside = await f.request('/api/state', visitor); assert.equal(outside.status, 404); assert.equal(outside.body.code, 'not_member');
    await f.addMembership(before.user!.id, 'pending');
    assert.equal((await f.request('/api/state', visitor)).status, 403);
    assert.equal((await f.request(`/api/users/${before.user!.id}/approve`, f.admin, { role: 'admin' })).status, 400);
    const approved = await f.request(`/api/users/${before.user!.id}/approve`, f.admin, { role: 'viewer' });
    assert.equal(approved.body.status, 'active'); assert.equal(approved.body.role, 'viewer');
    const repeatLogin = await f.telegram();
    const repeated = await f.sessionInfo(repeatLogin.cookie);
    assert.equal(repeated.user!.id, before.user!.id); assert.deepEqual(repeated.families.map(item => [item.id, item.role, item.status]), [[f.familyId, 'viewer', 'active']]);
    assert.equal((await f.request('/api/state', visitor)).body.user.role, 'viewer');
    assert.equal((await f.request('/api/people', visitor, { name: 'Cannot write' })).status, 403);
    assert.equal((await f.request('/api/auth/profile', login.cookie, { ...profile, phone: '+79990000000' })).body.phoneVerified, false);
    await f.setMembership(before.user!.id, { status: 'rejected' });
    assert.equal((await f.request('/api/state', visitor)).status, 403);
    assert.equal((await f.sessionInfo(login.cookie)).families[0].status, 'rejected');
  } finally { await f.cleanup(); }
});

test('Telegram flow is browser-bound and consumed once; designated Telegram admin attaches to the legacy account with a 365-day session', async () => {
  const f = await fixture({ adminTelegramId: '100' });
  try {
    const legacy: User = { id: 'legacy-admin', name: 'Local admin', email: 'admin@local.invalid', role: 'admin', status: 'active' };
    await f.db.global(g => g.put('users', legacy));
    await f.addMembership(legacy.id, 'active', 'admin');
    const accounts = (await f.users()).length;
    const wrongBrowser = await f.start();
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${wrongBrowser.state}&code=test`)).headers.get('location'), '/?auth=telegram_failed');
    const mismatch = await f.request('/api/auth/telegram/callback?state=wrong&code=test', wrongBrowser.cookie);
    assert.equal(mismatch.headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 0);
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${wrongBrowser.state}&code=test`, wrongBrowser.cookie)).headers.get('location'), '/?auth=telegram_failed');
    const flow = await f.start();
    const login = await f.request(`/api/auth/telegram/callback?state=${flow.state}&code=test`, flow.cookie);
    assert.equal(login.headers.get('location'), '/'); assert.equal(f.exchanges(), 1);
    const info = await f.sessionInfo(login.cookie);
    assert.equal(info.user!.id, legacy.id); assert.equal(info.user!.telegramId, '100'); assert.equal((await f.users()).length, accounts);
    assert.deepEqual(info.families.map(item => [item.id, item.role]), [[f.familyId, 'admin']]);
    const sessionHeader = login.headers.getSetCookie().find(value => value.startsWith('family_session='))!;
    assert.match(sessionHeader, /Max-Age=31536000/); assert.match(sessionHeader, /HttpOnly/); assert.match(sessionHeader, /SameSite=Lax/);
    const sessions = await f.db.global(g => g.where<{ id: string; expires: number }>('sessions', 'user_id = $1', legacy.id));
    assert.ok(sessions.some(item => item.expires > Date.now() + 364 * 86400000));
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${flow.state}&code=test`, flow.cookie)).headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 1);
    const expired = await f.start();
    const stored = (await f.db.global(g => g.where<{ id: string; expires: number }>('auth_flows', 'true')))[0];
    await f.db.global(g => g.put('auth_flows', { ...stored, expires: Date.now() - 1 }));
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${expired.state}&code=test`, expired.cookie)).headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 1);
  } finally { await f.cleanup(); }
});

test('guest links are one-use, preapprove a bounded role, preserve guest identity on re-login and keep secrets out of state/export', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/guest-links', '', {})).status, 401);
    assert.equal((await f.request('/api/guest-links', f.admin, { role: 'admin' })).status, 400);
    const created = await f.request('/api/guest-links', f.admin, { role: 'viewer' }); assert.equal(created.status, 201);
    const { token, invitation } = created.body; assert.match(token, /^[a-f0-9]{64}$/);
    for (let i = 0; i < 2; i++) {
      const preview = await f.request('/api/auth/guest-preview', '', { token });
      assert.equal(preview.status, 200); assert.equal(preview.body.role, 'viewer'); assert.equal(preview.body.family.name, 'Синтетическая семья'); assert.ok(Array.isArray(preview.body.family.surnames));
    }
    const accounts = (await f.users()).length;
    const linkRecord = async (id: string) => (await f.db.global(g => g.get<InvitationLink & { tokenHash: string }>('invitation_links', id)))!;
    assert.equal((await linkRecord(invitation.id)).uses, 0);
    const login = await f.request('/api/auth/guest', '', { token });
    assert.equal(login.status, 200); assert.equal(login.body.familyId, f.familyId); assert.equal(login.body.user.status, 'profile');
    assert.equal((await f.membership(login.body.user.id))!.role, 'viewer');
    const guest = { cookie: login.cookie, family: f.familyId };
    assert.equal((await f.request('/api/auth/guest', '', { token })).status, 410);
    assert.equal((await f.request('/api/state', guest)).status, 403);
    const ready = await f.request('/api/auth/profile', login.cookie, profile); assert.equal(ready.body.status, 'active'); assert.equal(ready.body.phoneVerified, false);
    assert.equal((await f.request(`/api/users/${login.body.user.id}`, f.admin, { role: 'admin' }, 'PATCH')).status, 400);
    assert.equal((await f.request('/api/guest-links', guest, {})).status, 403);
    assert.equal((await f.request('/api/people', guest, { name: 'Cannot write' })).status, 403);
    const relogin = await f.request('/api/guest-links', f.admin, { userId: login.body.user.id, role: 'member' });
    assert.equal(relogin.status, 201, JSON.stringify(relogin.body));
    const existing = await f.request('/api/auth/guest', '', { token: relogin.body.token });
    assert.equal(existing.body.user.id, login.body.user.id); assert.equal(existing.body.user.status, 'active');
    assert.equal((await f.sessionInfo(existing.cookie)).families[0].role, 'viewer');
    assert.equal((await f.request('/api/guest-links', f.admin, { userId: f.admin.id })).status, 400);
    const second = await f.request('/api/guest-links', f.admin, {});
    assert.equal((await f.request('/api/auth/guest', '', { token: second.body.token })).status, 200); assert.equal((await f.users()).length, accounts + 2);
    const state = await f.request('/api/state', f.admin); const exported = await f.request('/api/export', f.admin);
    assert.equal(state.body.invitationLinks.length, 3);
    for (const key of ['invitation_links', 'auth_flows', 'sessions', 'codes', 'memberships']) assert.ok(!(key in exported.body), key);
    for (const output of [JSON.stringify(state.body), JSON.stringify(exported.body)]) { assert.ok(!output.includes(token)); assert.ok(!output.includes(digest(token))); assert.ok(!output.includes('tokenHash')); }
    assert.equal((await linkRecord(invitation.id)).tokenHash, digest(token));
    assert.equal((await f.request('/api/state', guest)).body.invitationLinks.length, 0);
  } finally { await f.cleanup(); }
});

test('guest expiry/revocation blocks redemption and rejected applicants remain outside the family', async () => {
  const f = await fixture();
  try {
    const expired = await f.request('/api/guest-links', f.admin, {});
    await f.db.global(async g => { const record = (await g.get<InvitationLink & { familyId: string }>('invitation_links', expired.body.invitation.id))!; await g.put('invitation_links', { ...record, expiresAt: new Date(Date.now() - 1).toISOString() }); });
    const revoked = await f.request('/api/guest-links', f.admin, {});
    const once = await f.request(`/api/guest-links/${revoked.body.invitation.id}/revoke`, f.admin, {});
    assert.deepEqual((await f.request(`/api/guest-links/${revoked.body.invitation.id}/revoke`, f.admin, {})).body, once.body);
    let friendly = '';
    for (const token of [expired.body.token, revoked.body.token, 'bad']) {
      const preview = await f.request('/api/auth/guest-preview', '', { token }); assert.equal(preview.status, 410);
      friendly ||= preview.body.error; assert.equal(preview.body.error, friendly);
      assert.equal((await f.request('/api/auth/guest', '', { token })).body.error, friendly);
    }
    const login = await f.telegram(); const user = (await f.sessionInfo(login.cookie)).user!;
    await f.request('/api/auth/profile', login.cookie, profile);
    await f.addMembership(user.id, 'pending');
    assert.equal((await f.request(`/api/users/${user.id}/reject`, f.admin, {})).body.status, 'rejected');
    assert.equal((await f.request(`/api/users/${user.id}/approve`, f.admin, { role: 'member' })).status, 409);
    assert.equal((await f.request('/api/state', { cookie: login.cookie, family: f.familyId })).status, 403);
    // A fresh link of the same family cannot bring a rejected applicant back in.
    const link = await f.request('/api/guest-links', f.admin, {});
    assert.equal((await f.request('/api/auth/guest', login.cookie, { token: link.body.token })).status, 410);
    assert.equal((await f.membership(user.id))!.status, 'rejected');
  } finally { await f.cleanup(); }
});

test('person matching changes only membership metadata, rejects duplicate claims, and hides pending people and contacts from members', async () => {
  const f = await fixture();
  try {
    const login = await f.telegram(); const user = (await f.sessionInfo(login.cookie)).user!;
    await f.request('/api/auth/profile', login.cookie, profile);
    const link = await f.request('/api/guest-links', f.admin, { role: 'member' });
    assert.equal((await f.request('/api/auth/guest', login.cookie, { token: link.body.token })).status, 200);
    const member = { cookie: login.cookie, family: f.familyId };
    const pending = await f.telegram({ subject: 'telegram:200', telegramId: '200', name: 'Pending' }); assert.ok(pending.cookie);
    await f.addMembership((await f.sessionInfo(pending.cookie)).user!.id, 'pending');
    const person = (await f.request('/api/people', f.admin, { name: 'Existing family card' })).body;
    const before = await f.db.family(f.familyId, s => s.get('people', person.id));
    const matching = await f.request('/api/me/person', member, { personId: person.id }, 'PATCH');
    assert.equal(matching.body.personId, person.id); assert.deepEqual(await f.db.family(f.familyId, s => s.get('people', person.id)), before);
    assert.equal((await f.membership(user.id))!.personId, person.id);
    assert.equal((await f.request('/api/me/person', f.admin, { personId: person.id }, 'PATCH')).status, 409);
    assert.equal((await f.request('/api/me/person', member, { personId: 'missing' }, 'PATCH')).status, 404);
    assert.equal((await f.request('/api/me/person', member, { personId: null }, 'PATCH')).body.personId, null);
    const visible = (await f.request('/api/state', member)).body.users;
    assert.equal(visible.length, 2); const other = visible.find((item: User) => item.id === f.admin.id); assert.equal(other.email, ''); assert.equal(other.phone, undefined); assert.equal(other.telegramId, undefined);
    assert.equal((await f.request('/api/state', f.admin)).body.users.length, 3);
  } finally { await f.cleanup(); }
});

test('Telegram login never creates an administrator and production email login is gone', async () => {
  const f = await fixture({ adminTelegramId: '200' });
  try {
    assert.deepEqual((await f.request('/api/auth/session')).body, { user: null, families: [] });
    const login = await f.telegram(); const info = await f.sessionInfo(login.cookie);
    assert.equal(info.user!.status, 'profile'); assert.deepEqual(info.families, []);
    assert.equal((await f.request('/api/state', { cookie: login.cookie, family: f.familyId })).status, 403);
    // The designated owner binds only a migrated legacy account; without one it is an ordinary new account.
    const owner = await f.telegram({ subject: 'telegram:200', telegramId: '200' });
    const ownerInfo = await f.sessionInfo(owner.cookie);
    assert.notEqual(ownerInfo.user!.id, f.admin.id); assert.deepEqual(ownerInfo.families, []); assert.equal(ownerInfo.user!.status, 'profile');
  } finally { await f.cleanup(); }
  const production = await fixture({ production: true });
  try {
    assert.equal((await production.request('/api/auth/request-code', '', { email: 'admin@local.invalid', name: 'Admin' })).status, 410);
    assert.equal((await production.request('/api/auth/verify', '', { email: 'admin@local.invalid', code: '123456' })).status, 410);
    assert.equal((await production.request('/api/auth/config')).body.devMode, false);
  } finally { await production.cleanup(); }
});

test('ADMIN_TELEGRAM_ID binds only the legacy administrator, never a stranger who signed in first', async () => {
  const f = await fixture({ adminTelegramId: '200' });
  try {
    const legacy: User = { id: 'legacy-admin', name: 'Local admin', email: 'admin@local.invalid', role: 'admin', status: 'active' };
    await f.db.global(g => g.put('users', legacy)); await f.addMembership(legacy.id, 'active', 'admin');
    const stranger = await f.telegram({ subject: 'telegram:100', telegramId: '100' });
    const strangerInfo = await f.sessionInfo(stranger.cookie);
    assert.notEqual(strangerInfo.user!.id, legacy.id); assert.deepEqual(strangerInfo.families, []);
    const owner = await f.telegram({ subject: 'telegram:200', telegramId: '200' });
    const ownerInfo = await f.sessionInfo(owner.cookie);
    assert.equal(ownerInfo.user!.id, legacy.id); assert.equal(ownerInfo.families[0].role, 'admin');
    const strangerAgain = await f.telegram({ subject: 'telegram:100', telegramId: '100' });
    assert.equal((await f.sessionInfo(strangerAgain.cookie)).user!.id, strangerInfo.user!.id);
  } finally { await f.cleanup(); }
});

test('closing access ends every session when no other family remains but keeps the account and its contributions', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/invitations', f.admin, { email: 'member@example.test', role: 'member' })).status, 201);
    const member = await f.login('member@example.test');
    const phone = member.cookie; const laptop = await f.session(member.id);
    const person = await f.request('/api/people', { cookie: phone, family: f.familyId }, { name: 'Синтетический человек' });
    assert.equal(person.status, 201);
    assert.equal((await f.request(`/api/users/${f.admin.id}/deactivate`, f.admin, {})).status, 409);
    const closed = await f.request(`/api/users/${member.id}/deactivate`, f.admin, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.body)); assert.equal(closed.body.status, 'removed');
    for (const cookie of [phone, laptop]) assert.equal((await f.request('/api/state', { cookie, family: f.familyId })).status, 401);
    const relogin = { cookie: await f.session(member.id), family: f.familyId };
    const blocked = await f.request('/api/state', relogin);
    assert.equal(blocked.status, 403); assert.match(blocked.body.error, /закрыт/);
    assert.equal((await f.db.family(f.familyId, s => s.get<{ createdBy: string }>('people', person.body.id)))!.createdBy, member.id);
    assert.equal((await f.request(`/api/users/${member.id}/reactivate`, f.admin, {})).body.status, 'active');
    assert.equal((await f.request('/api/state', relogin)).status, 200);
    const history = await f.db.family(f.familyId, s => s.where<{ action: string }>('history', "data->>'entityId' = $2", member.id));
    assert.deepEqual(history.map(entry => entry.action), ['deactivate', 'reactivate']);
    // "Sign out everywhere" ends this person's sessions only.
    const other = { cookie: await f.session(member.id), family: f.familyId };
    assert.equal((await f.request('/api/auth/logout-all', relogin.cookie, {})).status, 200);
    assert.equal((await f.request('/api/state', other)).status, 401);
    assert.equal((await f.request('/api/state', f.admin)).status, 200);
  } finally { await f.cleanup(); }
});

test('local preview refuses rebound host names and exposes only a minimal health check', async () => {
  const f = await fixture();
  try {
    const { request: httpRequest } = await import('node:http');
    const health = await f.request('/api/health');
    assert.equal(health.status, 200); assert.deepEqual(Object.keys(health.body).sort(), ['diskLow', 'ok']);
    const base = new URL(f.base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: base.hostname, port: base.port, path: '/api/auth/config', headers: { Host: `rebind.attacker.example:${base.port}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 421);
  } finally { await f.cleanup(); }
});
