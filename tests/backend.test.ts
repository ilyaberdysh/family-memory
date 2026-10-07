import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../server/app.js';
import type { FamilyStore } from '../server/db.js';
import type { AppState, Fact, Material, Proposal, Person } from '../shared/types.js';

type Who = { cookie: string; family?: string; id?: string };
type Table = Parameters<FamilyStore['all']>[0];

async function fixture(extra: Partial<AppOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-space-test-'));
  const runtime = await createApp({ memoryDatabase: true, databaseUrl: '', dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false, ...extra });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, who: Who | string = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const { cookie, family } = typeof who === 'string' ? { cookie: who, family: undefined } : who;
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(family ? { 'X-Family-Id': family } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  let familyId = '';
  const login = async (email: string) => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const result = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { cookie: result.cookie, id: result.body.id as string, body: result.body, family: familyId || undefined };
  };
  const admin = await login('admin@example.test');
  const created = await request('/api/families', admin, { name: 'Синтетическая семья' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  familyId = created.body.id; admin.family = familyId;
  const inFamily = <T>(fn: (s: FamilyStore) => Promise<T>) => runtime.db.family(familyId, fn);
  const upload = async (who: Who, bytes: Uint8Array, name: string, type = '') => {
    const data = new FormData(); data.append('file', new Blob([new Uint8Array(bytes)], type ? { type } : {}), name);
    const response = await fetch(base + '/api/files', { method: 'POST', headers: { Cookie: who.cookie, 'X-Family-Id': who.family ?? '', 'X-Requested-With': 'family-space' }, body: data });
    return { status: response.status, body: await response.json() as { id: string; url: string; mime: string; previewStatus: string; error?: string } };
  };
  return {
    ...runtime, request, login, admin, base, familyId, upload,
    familyDir: join(dataDir, 'files', familyId), filesRoot: join(dataDir, 'files'),
    all: <T = Record<string, unknown>>(table: Table) => inFamily(s => s.all<T>(table)),
    get: <T = Record<string, unknown>>(table: Table, id: string) => inFamily(s => s.get<T>(table, id)),
    put: <T extends { id: string }>(table: Table, value: T) => inFamily(s => s.put(table, value)),
    cleanup: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('family membership, role enforcement, CSRF, family header and last administrator', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/state')).status, 401);
    // Any account may sign in locally, but it reaches no family it was not admitted to.
    const stranger = await f.login('stranger@example.test');
    const outside = await f.request('/api/state', { ...stranger, family: f.familyId });
    assert.equal(outside.status, 404); assert.equal(outside.body.code, 'not_member');
    const missing = await f.request('/api/state', { cookie: f.admin.cookie });
    assert.equal(missing.status, 400); assert.equal(missing.body.code, 'family_required');
    assert.equal((await f.request('/api/state', { cookie: f.admin.cookie, family: 'not-a-uuid' })).body.code, 'family_required');
    assert.equal((await f.request(`/api/users/${f.admin.id}`, f.admin, { role: 'member' }, 'PATCH')).status, 409);
    const csrf = await fetch(f.base + '/api/people', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Family-Id': f.familyId, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Blocked' }) });
    assert.equal(csrf.status, 403);
    const cross = await fetch(f.base + '/api/people', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Family-Id': f.familyId, 'Content-Type': 'application/json', 'X-Requested-With': 'family-space', Origin: 'https://another.example' }, body: JSON.stringify({ name: 'Blocked' }) });
    assert.equal(cross.status, 403);
    assert.equal((await f.request('/api/invitations', f.admin, { email: 'viewer@example.test', role: 'viewer' })).status, 201);
    const viewer = await f.login('viewer@example.test');
    assert.equal((await f.request('/api/people', viewer, { name: 'Blocked' })).status, 403);
    assert.equal((await f.request('/api/export', viewer)).status, 403);
    assert.equal((await f.request('/api/state', viewer)).status, 200);
    assert.equal((await f.request('/api/state', f.admin)).body.people.length, 0);
    // Family settings name the family in the path.
    const renamed = await f.request(`/api/families/${f.familyId}`, { cookie: f.admin.cookie }, { name: 'Переименованная семья' }, 'PATCH');
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body)); assert.equal(renamed.body.name, 'Переименованная семья');
    assert.equal((await f.request(`/api/families/${f.familyId}`, { cookie: viewer.cookie }, { name: 'Чужое имя' }, 'PATCH')).status, 403);
    const remoteDir = await mkdtemp(join(tmpdir(), 'family-space-remote-'));
    const remote = await createApp({ memoryDatabase: true, databaseUrl: '', dataDir: remoteDir, devAuth: true, production: true, bindHost: '0.0.0.0', startWorker: false });
    const remoteServer = remote.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => remoteServer.once('listening', resolve));
    const remoteCode = await fetch(`http://127.0.0.1:${(remoteServer.address() as { port: number }).port}/api/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }, body: JSON.stringify({ email: 'a@example.test', name: 'Remote' }) });
    assert.equal(remoteCode.status, 410);
    await new Promise<void>(resolve => remoteServer.close(() => resolve()));
    await remote.close(); await rm(remoteDir, { recursive: true, force: true });
  } finally { await f.cleanup(); }
});

test('review belongs to a version; self confirmation, dispute, and stale edits are rejected', async () => {
  const f = await fixture();
  try {
    await f.request('/api/invitations', f.admin, { email: 'member@example.test', role: 'member' });
    const member = await f.login('member@example.test');
    const person = await f.request('/api/people', f.admin, { name: 'Test person', facts: { place: 'Initial place' } });
    const state = (await f.request('/api/state', f.admin)).body as AppState;
    const fact = state.facts.find(item => item.personId === person.body.id && item.key === 'place')!;
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, f.admin, { action: 'confirm', version: 1 })).status, 403);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member, { action: 'confirm', version: 1 })).body.status, 'confirmed');
    assert.equal((await f.request(`/api/facts/${fact.id}`, member, { value: 'Unauthorized', source: '', version: 1 }, 'PATCH')).status, 403);
    const edited = await f.request(`/api/facts/${fact.id}`, f.admin, { value: 'Corrected place', source: 'Family record', version: 1 }, 'PATCH');
    assert.equal(edited.body.version, 2); assert.equal(edited.body.status, 'unconfirmed'); assert.equal(edited.body.confirmedBy, null);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member, { action: 'confirm', version: 1 })).status, 409);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member, { action: 'dispute', note: 'Check spelling', version: 2 })).body.status, 'disputed');
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member, { action: 'confirm', version: 2 })).status, 409);
    const history = await f.request(`/api/history/facts/${fact.id}`, member);
    assert.deepEqual(history.body.map((entry: { action: string }) => entry.action), ['create', 'confirm', 'edit', 'dispute']);
  } finally { await f.cleanup(); }
});

test('parent ancestry stays acyclic and initial relationships are atomic', async () => {
  const f = await fixture();
  try {
    const a = (await f.request('/api/people', f.admin, { name: 'A' })).body;
    const b = (await f.request('/api/people', f.admin, { name: 'B', relation: { relativeId: a.id, type: 'child' } })).body;
    const c = (await f.request('/api/people', f.admin, { name: 'C', relation: { relativeId: b.id, type: 'child' } })).body;
    assert.equal((await f.request('/api/relations', f.admin, { fromId: c.id, toId: a.id, type: 'parent' })).status, 409);
    assert.equal((await f.request('/api/relations', f.admin, { fromId: c.id, toId: a.id, type: 'partner' })).status, 201);
    assert.equal((await f.request('/api/people', f.admin, { name: 'Invalid', relation: { relativeId: 'missing', type: 'child' } })).status, 404);
    assert.equal((await f.request('/api/state', f.admin)).body.people.length, 3);
  } finally { await f.cleanup(); }
});

const proposal = (id: string, action: Proposal['action'], values: Partial<Proposal> = {}): Proposal => ({ id, action, status: 'pending', personId: null, personName: null, key: null, value: null, fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote: 'Source text', sourceStart: null, sourceEnd: null, baseVersion: null, ...values });
test('proposal acceptance resolves explicit names, rolls back missing dependencies and never replays', async () => {
  const f = await fixture();
  try {
    const material = (await f.request('/api/materials', f.admin, { title: 'Test source', kind: 'story', body: 'Source text' })).body as Material;
    const creation = proposal('new-person', 'create_person', { personName: 'Named person' });
    const fact = proposal('new-fact', 'set_fact', { personName: 'Named person', key: 'place', value: 'A place' });
    await f.put('materials', { ...material, proposals: [creation, fact] });
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin, { accept: [fact], reject: [creation.id], transcriptVersion: null })).status, 400);
    assert.equal((await f.all('people')).length, 0);
    const batch = { accept: [fact, creation], reject: [], transcriptVersion: null };
    const accepted = await f.request(`/api/materials/${material.id}/proposals`, f.admin, batch);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.proposals.filter((p: Proposal) => p.status === 'accepted').length, 2);
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin, batch)).status, 200);
    assert.equal((await f.all('people')).length, 1); assert.equal((await f.all<Fact>('facts')).length, 2);
    assert.ok((await f.all<Fact>('facts')).every(item => item.status === 'unconfirmed' && item.createdBy === f.admin.id));
    const existing = (await f.all<Fact>('facts')).find(item => item.key === 'place')!;
    const stale = proposal('stale', 'set_fact', { personId: existing.personId, key: 'place', value: 'Stale value', baseVersion: existing.version });
    await f.put('materials', { ...(await f.get<Material>('materials', material.id))!, proposals: [stale] });
    await f.request(`/api/facts/${existing.id}`, f.admin, { value: 'New value', source: '', version: existing.version }, 'PATCH');
    const forged = { ...stale, baseVersion: existing.version + 1 };
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin, { accept: [forged], reject: [], transcriptVersion: null })).status, 409);
    assert.equal((await f.get<Fact>('facts', existing.id))?.value, 'New value');
    const transcript = await f.request(`/api/materials/${material.id}/transcript`, f.admin, { text: 'Manually entered transcript', version: 0 }, 'PATCH');
    assert.equal(transcript.status, 200); assert.equal(transcript.body.transcript.automatic, false);
    assert.equal(transcript.body.proposals[0].status, 'rejected');
    assert.equal((await f.request(`/api/materials/${material.id}/transcript`, f.admin, { text: 'A concurrent first version', version: 0 }, 'PATCH')).status, 409);
    assert.equal((await f.get<Fact>('facts', existing.id))?.value, 'New value');
  } finally { await f.cleanup(); }
});

test('private original files require a session, validate content, and support byte ranges', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.upload(f.admin, Buffer.from('<svg><script>alert(1)</script></svg>'), 'fake.png', 'image/png')).status, 400);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const missingFamily = await f.upload({ cookie: f.admin.cookie }, bytes, 'pixel.png', 'image/png');
    assert.equal(missingFamily.status, 400);
    const upload = await f.upload(f.admin, bytes, 'pixel.png', 'image/png');
    const file = upload.body;
    assert.equal(upload.status, 201, file.error ?? 'Expected a valid upload');
    assert.equal((await fetch(f.base + file.url)).status, 401);
    // Media URLs carry no family header: the file names its family.
    const ranged = await fetch(f.base + file.url, { headers: { Cookie: f.admin.cookie, Range: 'bytes=0-7' } });
    assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 8));
    assert.deepEqual(await readFile(f.blobs.localPath(f.familyId, (await f.get<{ path: string }>('files', file.id))!.path)), bytes);
    const material = await f.request('/api/materials', f.admin, { title: 'Wrong kind', kind: 'audio', fileId: file.id });
    assert.equal(material.status, 400);
  } finally { await f.cleanup(); }
});

test('browser previews normalize recordings and video while authenticated originals stay byte-exact', async () => {
  const f = await fixture();
  const generated = await mkdtemp(join(tmpdir(), 'family-space-media-'));
  const execute = promisify(execFile);
  try {
    const samples = [
      { name: 'recording.webm', inputMime: 'audio/webm', previewMime: 'audio/mpeg', args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'libopus'] },
      { name: 'recording.mov', inputMime: 'video/quicktime', previewMime: 'video/mp4', args: ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.3', '-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:pools=1:frame-threads=1'] },
    ];
    for (const sample of samples) {
      const path = join(generated, sample.name);
      await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', ...sample.args, '-y', path], { timeout: 15000 });
      const bytes = await readFile(path);
      const { status, body: file } = await f.upload(f.admin, bytes, sample.name);
      // The original is accepted first; the browser copy follows in the background.
      assert.equal(status, 201, file.error ?? 'The original should be accepted'); assert.equal(file.mime, sample.inputMime); assert.equal(file.previewStatus, 'pending');
      await f.processMedia();
      const record = (await f.get<{ mime: string; path: string; previewPath: string; previewStatus: string; sha256: string }>('files', file.id))!;
      assert.equal(record.mime, sample.inputMime); assert.ok(record.previewPath); assert.equal(record.previewStatus, 'ready');
      assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
      const original = await fetch(f.base + file.url + '?original=1', { headers: { Cookie: f.admin.cookie } });
      assert.equal(original.headers.get('content-type'), sample.inputMime);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      assert.equal((await fetch(f.base + file.url + '/original')).status, 401);
      const preview = await fetch(f.base + file.url, { headers: { Cookie: f.admin.cookie, Range: 'bytes=0-31' } });
      assert.equal(preview.status, 206); assert.equal(preview.headers.get('content-type'), sample.previewMime);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), (await readFile(join(f.familyDir, record.previewPath))).subarray(0, 32));
    }
  } finally { await f.cleanup(); await rm(generated, { recursive: true, force: true }); }
});

test('an original survives a failed browser copy and digitised archive formats are accepted', async () => {
  const f = await fixture();
  const generated = await mkdtemp(join(tmpdir(), 'family-space-formats-'));
  const execute = promisify(execFile);
  const send = (bytes: Buffer, name: string) => f.upload(f.admin, bytes, name);
  try {
    const samples = [
      { name: 'scan.tif', mime: 'image/tiff', args: ['-f', 'lavfi', '-i', 'color=c=gray:s=48x32:d=1', '-frames:v', '1', '-c:v', 'tiff'] },
      { name: 'scan.bmp', mime: 'image/bmp', args: ['-f', 'lavfi', '-i', 'color=c=gray:s=48x32:d=1', '-frames:v', '1', '-c:v', 'bmp'] },
      { name: 'camcorder.avi', mime: 'video/x-msvideo', args: ['-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=0.4', '-c:v', 'mpeg4'] },
      { name: 'dvd.mpg', mime: 'video/mpeg', args: ['-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=0.4', '-c:v', 'mpeg2video', '-f', 'mpeg'] },
      { name: 'avchd.mts', mime: 'video/mp2t', args: ['-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=0.4', '-c:v', 'mpeg2video', '-f', 'mpegts'] },
      { name: 'home.mkv', mime: 'video/x-matroska', args: ['-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=0.4', '-c:v', 'mpeg4', '-f', 'matroska'] },
      { name: 'voice.aac', mime: 'audio/aac', args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-c:a', 'aac', '-f', 'adts'] },
    ];
    for (const sample of samples) {
      const path = join(generated, sample.name);
      await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', ...sample.args, '-y', path], { timeout: 15000 });
      const upload = await send(await readFile(path), sample.name);
      assert.equal(upload.status, 201, `${sample.name}: ${upload.body.error}`); assert.equal(upload.body.mime, sample.mime, sample.name);
      assert.equal(upload.body.previewStatus, 'pending', sample.name);
    }
    await f.processMedia();
    for (const record of await f.all<{ name: string; previewStatus: string; previewError?: string }>('files')) assert.equal(record.previewStatus, 'ready', `${record.name}: ${record.previewError}`);

    // A preview that cannot be prepared (here: longer than the configured limit) must not cost the original.
    const long = join(generated, 'long.webm');
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-c:a', 'libopus', '-y', long], { timeout: 15000 });
    const bytes = await readFile(long);
    const previous = process.env.MEDIA_MAX_DURATION_SECONDS; process.env.MEDIA_MAX_DURATION_SECONDS = '1';
    try {
      const upload = await send(bytes, 'long.webm');
      assert.equal(upload.status, 201, upload.body.error ?? '');
      await f.processMedia();
      const record = (await f.get<{ path: string; previewStatus: string; previewError: string; sha256: string }>('files', upload.body.id))!;
      assert.equal(record.previewStatus, 'failed'); assert.match(record.previewError, /Оригинал сохранён/);
      assert.deepEqual(await readFile(join(f.familyDir, record.path)), bytes);
      const served = await fetch(f.base + upload.body.url, { headers: { Cookie: f.admin.cookie } });
      assert.equal(served.headers.get('content-type'), 'audio/webm'); assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
      const state = await f.request('/api/conversations', f.admin, {});
      const message = await f.request(`/api/conversations/${state.body.id}/messages`, f.admin, { id: randomUUID(), text: '', fileId: upload.body.id, version: state.body.version });
      assert.equal(message.status, 202, JSON.stringify(message.body));
      assert.equal(message.body.messages[0].file.previewStatus, 'failed');
    } finally { if (previous === undefined) delete process.env.MEDIA_MAX_DURATION_SECONDS; else process.env.MEDIA_MAX_DURATION_SECONDS = previous; }

    // Rejected content leaves nothing behind in the family's files or the staging area.
    assert.equal((await send(Buffer.from('<html><script>alert(1)</script></html>'), 'page.html')).status, 400);
    const stored = new Set((await f.all<{ path: string; previewPath?: string }>('files')).flatMap(record => [record.path, record.previewPath].filter(Boolean)));
    assert.deepEqual((await readdir(f.familyDir)).filter(name => !name.startsWith('.') && !stored.has(name)), []);
    assert.deepEqual(await readdir(join(f.filesRoot, '.incoming')), []);
  } finally { await f.cleanup(); await rm(generated, { recursive: true, force: true }); }
});
