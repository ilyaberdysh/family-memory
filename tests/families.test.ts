import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { FamilySummary, Fact, Material, Proposal, User } from '../shared/types.js';

type Who = { cookie: string; family?: string; id?: string };
const profile = { nameParts: { firstName: 'Гость', lastName: 'Синтетический', patronymic: '' }, phone: '+7 999 000-00-01' };
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

/** Two families, each with its own administrator. */
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-isolation-'));
  const runtime = await createApp({ memoryDatabase: true, databaseUrl: '', dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, who: Who | string = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const { cookie, family } = typeof who === 'string' ? { cookie: who, family: undefined } : who;
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(family ? { 'X-Family-Id': family } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const login = async (email: string): Promise<Who & { id: string }> => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const result = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { cookie: result.cookie, id: result.body.id };
  };
  const family = async (email: string, name: string) => {
    const admin = await login(email);
    const created = await request('/api/families', admin, { name });
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.role, 'admin');
    return { ...admin, family: created.body.id as string };
  };
  const a = await family('admin-a@example.test', 'Семья А');
  const b = await family('admin-b@example.test', 'Семья Б');
  const upload = async (who: Who) => {
    const data = new FormData(); data.append('file', new Blob([pixel], { type: 'image/png' }), 'pixel.png');
    const response = await fetch(base + '/api/files', { method: 'POST', headers: { Cookie: who.cookie, 'X-Family-Id': who.family ?? '', 'X-Requested-With': 'family-space' }, body: data });
    assert.equal(response.status, 201); return await response.json() as { id: string; url: string };
  };
  const families = async (cookie: string) => ((await request('/api/auth/session', cookie)).body.families as FamilySummary[]).map(item => [item.id, item.role, item.status]);
  const users = () => runtime.db.global(g => g.where<User>('users', 'true'));
  return { ...runtime, base, request, login, upload, families, users, a, b,
    cleanup: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

const proposal = (id: string, values: Partial<Proposal>): Proposal => ({ id, action: 'create_person', status: 'pending', personId: null, personName: null, key: null, value: null, fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote: 'Источник', sourceStart: null, sourceEnd: null, baseVersion: null, ...values });

test('one family cannot read, change or invite into another family, even with correct record ids', async () => {
  const f = await fixture();
  try {
    const { a, b } = f;
    // Family A's private records.
    const person = (await f.request('/api/people', a, { name: 'Человек семьи А', facts: { place: 'Город А' } })).body;
    const fact = ((await f.request('/api/state', a)).body.facts as Fact[]).find(item => item.key === 'place')!;
    const file = await f.upload(a);
    const material = (await f.request('/api/materials', a, { title: 'Фото семьи А', kind: 'photo', fileId: file.id, personIds: [person.id] })).body as Material;
    await f.db.family(a.family, s => s.put('materials', { ...material, proposals: [proposal('p', { personName: 'Новый родственник' })] }));
    const conversation = (await f.request('/api/conversations', a, {})).body;
    const link = (await f.request('/api/guest-links', a, {})).body;
    const snapshot = await f.db.family(a.family, async s => JSON.stringify({ people: await s.all('people'), facts: await s.all('facts'), materials: await s.all('materials'), conversations: await s.all('conversations') }));

    // B is no member of A: the header cannot open it.
    const asA = { cookie: b.cookie, family: a.family };
    for (const path of ['/api/state', '/api/conversations', `/api/conversations/${conversation.id}`, `/api/materials/${material.id}`, `/api/history/people/${person.id}`, `/api/history/facts/${fact.id}`, '/api/export']) {
      const refused = await f.request(path, asA); assert.equal(refused.status, 404, path); assert.equal(refused.body.code, 'not_member', path);
    }
    for (const [path, body, method] of [['/api/people', { name: 'Чужой' }, 'POST'], [`/api/facts/${fact.id}`, { value: 'Подмена', source: '', version: 1 }, 'PATCH'], ['/api/guest-links', {}, 'POST'], ['/api/invitations', { email: 'spy@example.test', role: 'admin' }, 'POST'], [`/api/users/${a.id}`, { role: 'viewer' }, 'PATCH'], [`/api/users/${a.id}/deactivate`, {}, 'POST'], [`/api/guest-links/${link.invitation.id}/revoke`, {}, 'POST']] as const) {
      assert.equal((await f.request(path, asA, body, method)).status, 404, path);
    }
    assert.equal((await f.request(`/api/families/${a.family}`, b.cookie, { name: 'Захват' }, 'PATCH')).status, 404);
    assert.equal((await f.request(`/api/families/${a.family}`, b, { name: 'Захват' }, 'PATCH')).status, 404);

    // Inside its own family, B still cannot reach A's records by id.
    for (const path of [`/api/conversations/${conversation.id}`, `/api/materials/${material.id}`, `/api/history/people/${person.id}`, `/api/history/materials/${material.id}`]) assert.equal((await f.request(path, b)).status, 404, path);
    assert.equal((await f.request(`/api/facts/${fact.id}`, b, { value: 'Подмена', source: '', version: 1 }, 'PATCH')).status, 404);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, b, { action: 'confirm', version: 1 })).status, 404);
    assert.equal((await f.request(`/api/materials/${material.id}`, b, { title: 'Подмена', version: 1 }, 'PATCH')).status, 404);
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, b, { accept: [proposal('p', { personName: 'Новый родственник' })], reject: [], transcriptVersion: null })).status, 404);
    assert.equal((await f.request(`/api/people/${person.id}`, b, { avatarFileId: null }, 'PATCH')).status, 404);
    assert.equal((await f.request(`/api/conversations/${conversation.id}/archive`, b, { version: 1 })).status, 404);
    assert.equal((await f.request('/api/relations', b, { fromId: person.id, toId: person.id, type: 'parent' })).status, 404);
    const own = (await f.request('/api/people', b, { name: 'Человек семьи Б' })).body;
    assert.equal((await f.request(`/api/people/${own.id}`, b, { avatarFileId: file.id }, 'PATCH')).status, 404);
    assert.equal((await f.request('/api/materials', b, { title: 'Чужое фото', kind: 'photo', fileId: file.id })).status, 404);
    const bConversation = (await f.request('/api/conversations', b, {})).body;
    assert.equal((await f.request(`/api/conversations/${bConversation.id}/messages`, b, { id: randomUUID(), text: '', fileId: file.id, version: 1 })).status, 404);
    assert.equal((await f.request(`/api/guest-links/${link.invitation.id}/revoke`, b, {})).status, 404);
    for (const path of [`/api/users/${a.id}/approve`, `/api/users/${a.id}/deactivate`]) assert.equal((await f.request(path, b, { role: 'member' })).status, 404, path);
    assert.notEqual((await f.request('/api/guest-links', b, { userId: a.id })).status, 201);
    // Media URLs carry no header, so the file's own family decides.
    for (const url of [file.url, `${file.url}/original`]) assert.equal((await fetch(f.base + url, { headers: { Cookie: b.cookie } })).status, 404, url);
    assert.equal((await fetch(f.base + file.url, { headers: { Cookie: a.cookie } })).status, 200);

    const stateB = (await f.request('/api/state', b)).body;
    assert.deepEqual(stateB.people.map((item: { name: string }) => item.name), ['Человек семьи Б']);
    assert.equal(stateB.materials.length, 0); assert.equal(stateB.facts.length, 1); assert.equal(stateB.invitationLinks.length, 0);
    assert.deepEqual(stateB.users.map((item: User) => item.id), [b.id]);
    assert.deepEqual((await f.request('/api/conversations', b)).body.map((item: { id: string }) => item.id), [bConversation.id]);
    // Nothing of A changed, and A's link still works.
    assert.equal(await f.db.family(a.family, async s => JSON.stringify({ people: await s.all('people'), facts: await s.all('facts'), materials: await s.all('materials'), conversations: await s.all('conversations') })), snapshot);
    assert.equal((await f.request('/api/auth/guest-preview', '', { token: link.token })).status, 200);
  } finally { await f.cleanup(); }
});

test('one account in two families sees both and has the right role in each; closing one keeps the session', async () => {
  const f = await fixture();
  try {
    const { a, b } = f;
    assert.equal((await f.request('/api/invitations', a, { email: 'both@example.test', role: 'viewer' })).status, 201);
    assert.equal((await f.request('/api/invitations', b, { email: 'both@example.test', role: 'member' })).status, 201);
    const both = await f.login('both@example.test');
    assert.deepEqual((await f.families(both.cookie)).sort(), [[a.family, 'viewer', 'active'], [b.family, 'member', 'active']].sort());
    const inA = { ...both, family: a.family }; const inB = { ...both, family: b.family };
    assert.equal((await f.request('/api/state', inA)).body.user.role, 'viewer');
    assert.equal((await f.request('/api/state', inB)).body.user.role, 'member');
    assert.equal((await f.request('/api/people', inA, { name: 'Нельзя' })).status, 403);
    assert.equal((await f.request('/api/people', inB, { name: 'Можно' })).status, 201);
    // Linking to a card is per family.
    const personB = (await f.request('/api/state', inB)).body.people[0];
    assert.equal((await f.request('/api/me/person', inA, { personId: personB.id }, 'PATCH')).status, 404);
    assert.equal((await f.request('/api/me/person', inB, { personId: personB.id }, 'PATCH')).body.personId, personB.id);
    assert.equal((await f.request('/api/state', inA)).body.user.personId, null);

    // Closing access in A keeps the session, because B is still open to this person.
    assert.equal((await f.request(`/api/users/${both.id}/deactivate`, a, {})).body.status, 'removed');
    assert.equal((await f.request('/api/state', inA)).status, 403);
    assert.equal((await f.request('/api/state', inB)).status, 200);
    assert.deepEqual((await f.families(both.cookie)).sort(), [[a.family, 'viewer', 'removed'], [b.family, 'member', 'active']].sort());
    // Closing the last open family ends every session.
    assert.equal((await f.request(`/api/users/${both.id}/deactivate`, b, {})).body.status, 'removed');
    assert.equal((await f.request('/api/state', inB)).status, 401);
    assert.equal((await f.request('/api/auth/session', both.cookie)).body.user, null);
  } finally { await f.cleanup(); }
});

test('a guest link redeemed while signed in adds the family to the existing account', async () => {
  const f = await fixture();
  try {
    const { a, b } = f;
    const link = (await f.request('/api/guest-links', b, { role: 'viewer' })).body;
    const accounts = (await f.users()).length;
    const redeemed = await f.request('/api/auth/guest', a.cookie, { token: link.token });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.user.id, a.id); assert.equal(redeemed.body.familyId, b.family);
    assert.equal(redeemed.cookie, '', 'the existing session is kept, not replaced');
    assert.equal((await f.users()).length, accounts);
    assert.deepEqual((await f.families(a.cookie)).sort(), [[a.family, 'admin', 'active'], [b.family, 'viewer', 'active']].sort());
    assert.equal((await f.request('/api/state', { cookie: a.cookie, family: b.family })).body.user.role, 'viewer');
    assert.equal((await f.request('/api/state', a)).body.user.role, 'admin');
    assert.equal((await f.request('/api/auth/guest', a.cookie, { token: link.token })).status, 410);
  } finally { await f.cleanup(); }
});

test('a guest re-login link is refused while the guest belongs to another family', async () => {
  const f = await fixture();
  try {
    const { a, b } = f;
    const joinA = (await f.request('/api/guest-links', a, { role: 'member' })).body;
    const guest = await f.request('/api/auth/guest', '', { token: joinA.token });
    assert.equal(guest.status, 200); const guestId = guest.body.user.id as string;
    assert.equal((await f.request('/api/auth/profile', guest.cookie, profile)).status, 200);
    // While the guest is only in A, A may issue a re-login link; it is redeemed later.
    const early = await f.request('/api/guest-links', a, { userId: guestId });
    assert.equal(early.status, 201, JSON.stringify(early.body));
    const joinB = (await f.request('/api/guest-links', b, { role: 'viewer' })).body;
    assert.equal((await f.request('/api/auth/guest', guest.cookie, { token: joinB.token })).status, 200);
    assert.deepEqual((await f.families(guest.cookie)).map(item => item[0]).sort(), [a.family, b.family].sort());
    // Neither family may now mint a session for the guest that would also open the other family.
    for (const admin of [a, b]) assert.equal((await f.request('/api/guest-links', admin, { userId: guestId })).status, 409);
    const late = await f.request('/api/auth/guest', '', { token: early.body.token });
    assert.equal(late.status, 410); assert.equal(late.cookie, '');
  } finally { await f.cleanup(); }
});

test('export contains only the requested family', async () => {
  const f = await fixture();
  try {
    const { a, b } = f;
    await f.request('/api/people', a, { name: 'Только в семье А' });
    await f.request('/api/people', b, { name: 'Только в семье Б' });
    await f.request('/api/materials', b, { title: 'История семьи Б', kind: 'story', body: 'Текст семьи Б' });
    await f.request('/api/invitations', b, { email: 'invitee-b@example.test', role: 'member' });
    await f.upload(b);
    const exported = await f.request('/api/export', a);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.family.id, a.family); assert.equal(exported.body.family.name, 'Семья А');
    assert.deepEqual(exported.body.members.map((item: User) => item.id), [a.id]);
    assert.deepEqual(exported.body.people.map((item: { name: string }) => item.name), ['Только в семье А']);
    for (const table of ['materials', 'files', 'invitations', 'conversations']) assert.deepEqual(exported.body[table], [], table);
    const text = JSON.stringify(exported.body);
    for (const foreign of [b.family, b.id, 'Семья Б', 'Только в семье Б', 'История семьи Б', 'invitee-b@example.test']) assert.ok(!text.includes(foreign), foreign);
    assert.ok(!('sessions' in exported.body) && !('invitation_links' in exported.body) && !('memberships' in exported.body));
  } finally { await f.cleanup(); }
});
