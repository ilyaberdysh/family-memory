import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { TelegramProvider, TelegramIdentity } from '../server/telegram.js';
import type { InvitationLink, User } from '../shared/types.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const profile = { nameParts: { firstName: 'Тест', lastName: 'Проверка', patronymic: '' }, phone: '+7 (999) 123-45-67' };
async function fixture(options: { empty?: boolean; adminTelegramId?: string; production?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-membership-'));
  let identity: TelegramIdentity = { subject: 'telegram:100', telegramId: '100', name: 'Test', phone: '+79991234567', phoneVerified: true };
  let exchanges = 0;
  const provider: TelegramProvider = {
    configured: true,
    authorizationUrl: async input => `https://telegram.example.test/authorize?state=${input.state}`,
    exchange: async input => { exchanges++; assert.ok(input.nonce); assert.ok(input.verifier.length >= 43); assert.equal(new URL(input.callbackUrl).searchParams.get('state'), input.state); return identity; },
  };
  const runtime = createApp({ dataDir, telegramProvider: provider, adminTelegramId: options.adminTelegramId || '', devAuth: true, production: options.production || false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
  const admin: User = { id: 'legacy-admin', name: 'Local admin', email: 'admin@local.invalid', role: 'admin' };
  if (!options.empty) runtime.store.put('users', admin);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = (user: User) => { const token = randomUUID(); runtime.store.put('sessions', { id: digest(token), userId: user.id, expires: Date.now() + 100000 }); return `family_session=${token}`; };
  const adminCookie = options.empty ? '' : session(admin);
  const request = async (path: string, cookie = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers, cookie: response.headers.getSetCookie().find(value => value.startsWith('family_session='))?.split(';')[0] || '' };
  };
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
  return { ...runtime, admin, adminCookie, request, session, start, telegram, exchanges: () => exchanges, setIdentity: (next: TelegramIdentity) => { identity = next; }, cleanup: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('Telegram profile and pending sessions cannot reach family APIs; approval grants only selected role', async () => {
  const f = await fixture();
  try {
    const login = await f.telegram(); assert.equal(login.headers.get('location'), '/');
    const before = (await f.request('/api/auth/session', login.cookie)).body.user;
    assert.equal(before.status, 'profile'); assert.equal(before.role, 'member');
    for (const path of ['/api/state', '/api/conversations', '/api/materials/missing', '/api/files/missing']) assert.equal((await f.request(path, login.cookie)).status, 403);
    assert.equal((await f.request(`/api/users/${before.id}/approve`, f.adminCookie, { role: 'member' })).status, 409);
    assert.equal((await f.request(`/api/users/${before.id}`, f.adminCookie, { role: 'admin' }, 'PATCH')).status, 409);
    const submitted = await f.request('/api/auth/profile', login.cookie, { ...profile, role: 'admin', status: 'active' });
    assert.equal(submitted.body.status, 'pending'); assert.equal(submitted.body.role, 'member'); assert.equal(submitted.body.phone, '+79991234567'); assert.equal(submitted.body.phoneVerified, true);
    assert.equal((await f.request('/api/state', login.cookie)).status, 403);
    assert.equal((await f.request(`/api/users/${before.id}/approve`, f.adminCookie, { role: 'admin' })).status, 400);
    assert.equal((await f.request(`/api/users/${before.id}/approve`, f.adminCookie, { role: 'viewer' })).body.status, 'active');
    const repeatLogin = await f.telegram();
    const repeatedUser = (await f.request('/api/auth/session', repeatLogin.cookie)).body.user;
    assert.equal(repeatedUser.id, before.id); assert.equal(repeatedUser.role, 'viewer');
    assert.equal((await f.request('/api/state', login.cookie)).status, 200);
    assert.equal((await f.request('/api/people', login.cookie, { name: 'Cannot write' })).status, 403);
    assert.equal((await f.request('/api/auth/profile', login.cookie, { ...profile, phone: '+79990000000' })).body.phoneVerified, false);
    f.store.put('users', { ...f.store.get<User>('users', before.id)!, status: 'rejected' });
    assert.equal((await f.request('/api/state', login.cookie)).status, 403);
    assert.equal((await f.request('/api/auth/session', login.cookie)).body.user.status, 'rejected');
  } finally { await f.cleanup(); }
});

test('Telegram flow is browser-bound and consumed once; designated Telegram admin attaches to legacy ID with a 365-day session', async () => {
  const f = await fixture({ adminTelegramId: '100' });
  try {
    const wrongBrowser = await f.start();
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${wrongBrowser.state}&code=test`)).headers.get('location'), '/?auth=telegram_failed');
    const mismatch = await f.request('/api/auth/telegram/callback?state=wrong&code=test', wrongBrowser.cookie);
    assert.equal(mismatch.headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 0);
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${wrongBrowser.state}&code=test`, wrongBrowser.cookie)).headers.get('location'), '/?auth=telegram_failed');
    const flow = await f.start();
    const login = await f.request(`/api/auth/telegram/callback?state=${flow.state}&code=test`, flow.cookie);
    assert.equal(login.headers.get('location'), '/'); assert.equal(f.exchanges(), 1);
    const user = (await f.request('/api/auth/session', login.cookie)).body.user;
    assert.equal(user.id, f.admin.id); assert.equal(user.role, 'admin'); assert.equal(user.telegramId, '100'); assert.equal(f.store.all('users').length, 1);
    const sessionHeader = login.headers.getSetCookie().find(value => value.startsWith('family_session='))!;
    assert.match(sessionHeader, /Max-Age=31536000/); assert.match(sessionHeader, /HttpOnly/); assert.match(sessionHeader, /SameSite=Lax/);
    const sessions = f.store.all<{ id: string; expires: number }>('sessions');
    assert.ok(sessions.some(item => item.expires > Date.now() + 364 * 86400000));
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${flow.state}&code=test`, flow.cookie)).headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 1);
    const expired = await f.start(); const stored = f.store.all<{ id: string; expires: number }>('auth_flows')[0]; f.store.put('auth_flows', { ...stored, expires: Date.now() - 1 });
    assert.equal((await f.request(`/api/auth/telegram/callback?state=${expired.state}&code=test`, expired.cookie)).headers.get('location'), '/?auth=telegram_failed'); assert.equal(f.exchanges(), 1);
  } finally { await f.cleanup(); }
});

test('guest links are one-use, preapprove a bounded role, preserve guest identity on re-login and keep secrets out of state/export', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/guest-links', '', {})).status, 401);
    assert.equal((await f.request('/api/guest-links', f.adminCookie, { role: 'admin' })).status, 400);
    const created = await f.request('/api/guest-links', f.adminCookie, { role: 'viewer' }); assert.equal(created.status, 201);
    const { token, invitation } = created.body; assert.match(token, /^[a-f0-9]{64}$/);
    for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/auth/guest-preview', '', { token })).status, 200);
    assert.equal(f.store.all('users').length, 1); assert.equal(f.store.get<InvitationLink>('invitation_links', invitation.id)!.uses, 0);
    const login = await f.request('/api/auth/guest', '', { token }); assert.equal(login.status, 200); assert.equal(login.body.role, 'viewer'); assert.equal(login.body.status, 'profile');
    assert.equal((await f.request('/api/auth/guest', '', { token })).status, 410);
    assert.equal((await f.request('/api/state', login.cookie)).status, 403);
    const ready = await f.request('/api/auth/profile', login.cookie, profile); assert.equal(ready.body.status, 'active'); assert.equal(ready.body.phoneVerified, false);
    assert.equal((await f.request(`/api/users/${login.body.id}`, f.adminCookie, { role: 'admin' }, 'PATCH')).status, 400);
    assert.equal((await f.request('/api/guest-links', login.cookie, {})).status, 403);
    assert.equal((await f.request('/api/people', login.cookie, { name: 'Cannot write' })).status, 403);
    const relogin = await f.request('/api/guest-links', f.adminCookie, { userId: login.body.id, role: 'member' });
    const existing = await f.request('/api/auth/guest', '', { token: relogin.body.token }); assert.equal(existing.body.id, login.body.id); assert.equal(existing.body.role, 'viewer'); assert.equal(existing.body.status, 'active');
    assert.equal((await f.request('/api/guest-links', f.adminCookie, { userId: f.admin.id })).status, 400);
    const second = await f.request('/api/guest-links', f.adminCookie, {}); assert.equal((await f.request('/api/auth/guest', '', { token: second.body.token })).status, 200); assert.equal(f.store.all('users').length, 3);
    const state = await f.request('/api/state', f.adminCookie); const exported = await f.request('/api/export', f.adminCookie);
    assert.equal(state.body.invitationLinks.length, 3); assert.ok(!('invitation_links' in exported.body)); assert.ok(!('auth_flows' in exported.body));
    for (const output of [JSON.stringify(state.body), JSON.stringify(exported.body)]) { assert.ok(!output.includes(token)); assert.ok(!output.includes(digest(token))); assert.ok(!output.includes('tokenHash')); }
    assert.equal(f.store.get<{ id: string; tokenHash: string }>('invitation_links', invitation.id)!.tokenHash, digest(token));
    assert.equal((await f.request('/api/state', login.cookie)).body.invitationLinks.length, 0);
  } finally { await f.cleanup(); }
});

test('guest expiry/revocation blocks redemption and rejected Telegram applicants remain outside the family', async () => {
  const f = await fixture();
  try {
    const expired = await f.request('/api/guest-links', f.adminCookie, {});
    const record = f.store.get<InvitationLink & { tokenHash: string }>('invitation_links', expired.body.invitation.id)!;
    f.store.put('invitation_links', { ...record, expiresAt: new Date(Date.now() - 1).toISOString() });
    const revoked = await f.request('/api/guest-links', f.adminCookie, {});
    const once = await f.request(`/api/guest-links/${revoked.body.invitation.id}/revoke`, f.adminCookie, {});
    assert.deepEqual((await f.request(`/api/guest-links/${revoked.body.invitation.id}/revoke`, f.adminCookie, {})).body, once.body);
    let friendly = '';
    for (const token of [expired.body.token, revoked.body.token, 'bad']) {
      const preview = await f.request('/api/auth/guest-preview', '', { token }); assert.equal(preview.status, 410);
      friendly ||= preview.body.error; assert.equal(preview.body.error, friendly);
      assert.equal((await f.request('/api/auth/guest', '', { token })).body.error, friendly);
    }
    const login = await f.telegram(); const user = (await f.request('/api/auth/session', login.cookie)).body.user;
    assert.equal((await f.request(`/api/users/${user.id}/reject`, f.adminCookie, {})).body.status, 'rejected');
    assert.equal((await f.request('/api/auth/profile', login.cookie, profile)).status, 403);
    assert.equal((await f.request(`/api/users/${user.id}/approve`, f.adminCookie, { role: 'member' })).status, 409);
    assert.equal((await f.request('/api/state', login.cookie)).status, 403);
  } finally { await f.cleanup(); }
});

test('person matching changes only account metadata, rejects duplicate claims, and hides pending people and contacts from members', async () => {
  const f = await fixture();
  try {
    const login = await f.telegram(); const user = (await f.request('/api/auth/session', login.cookie)).body.user;
    await f.request('/api/auth/profile', login.cookie, profile); await f.request(`/api/users/${user.id}/approve`, f.adminCookie, { role: 'member' });
    const pending = await f.telegram({ subject: 'telegram:200', telegramId: '200', name: 'Pending' }); assert.ok(pending.cookie);
    const person = (await f.request('/api/people', f.adminCookie, { name: 'Existing family card' })).body;
    const before = f.store.get('people', person.id);
    const matching = await f.request('/api/me/person', login.cookie, { personId: person.id }, 'PATCH'); assert.equal(matching.body.personId, person.id); assert.deepEqual(f.store.get('people', person.id), before);
    assert.equal((await f.request('/api/me/person', f.adminCookie, { personId: person.id }, 'PATCH')).status, 409);
    assert.equal((await f.request('/api/me/person', login.cookie, { personId: 'missing' }, 'PATCH')).status, 404);
    assert.equal((await f.request('/api/me/person', login.cookie, { personId: null }, 'PATCH')).body.personId, null);
    const visible = (await f.request('/api/state', login.cookie)).body.users;
    assert.equal(visible.length, 2); const other = visible.find((item: User) => item.id === f.admin.id); assert.equal(other.email, ''); assert.equal(other.phone, undefined); assert.equal(other.telegramId, undefined);
    assert.equal((await f.request('/api/state', f.adminCookie)).body.users.length, 3);
  } finally { await f.cleanup(); }
});

test('unknown first Telegram login is not admin and production email login is gone', async () => {
  const f = await fixture({ empty: true });
  try {
    const login = await f.telegram(); const user = (await f.request('/api/auth/session', login.cookie)).body.user;
    assert.equal(user.role, 'member'); assert.equal(user.status, 'profile'); assert.equal((await f.request('/api/state', login.cookie)).status, 403);
    assert.deepEqual((await f.request('/api/auth/session')).body, { user: null });
  } finally { await f.cleanup(); }
  const production = await fixture({ production: true });
  try {
    assert.equal((await production.request('/api/auth/request-code', '', { email: 'admin@local.invalid', name: 'Admin' })).status, 410);
    assert.equal((await production.request('/api/auth/verify', '', { email: 'admin@local.invalid', code: '123456' })).status, 410);
    assert.equal((await production.request('/api/auth/config')).body.devMode, false);
  } finally { await production.cleanup(); }
});
