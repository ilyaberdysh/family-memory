import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { AppState, Fact, Material, Proposal, Person } from '../shared/types.js';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-space-test-'));
  const runtime = createApp({ dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, cookie = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'family-space' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const login = async (email: string) => {
    const code = await request('/api/auth/request-code', '', { email, name: email.split('@')[0] });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const result = await request('/api/auth/verify', '', { email, code: code.body.devCode });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
  };
  const admin = await login('admin@example.test');
  return { ...runtime, request, login, admin, base, cleanup: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('closed family membership, role enforcement, CSRF, and last administrator', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/state')).status, 401);
    assert.equal((await f.request('/api/auth/request-code', '', { email: 'stranger@example.test', name: 'Stranger' })).status, 403);
    assert.equal((await f.request(`/api/users/${f.admin.body.id}`, f.admin.cookie, { role: 'member' }, 'PATCH')).status, 409);
    const csrf = await fetch(f.base + '/api/people', { method: 'POST', headers: { Cookie: f.admin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Blocked' }) });
    assert.equal(csrf.status, 403);
    const cross = await fetch(f.base + '/api/people', { method: 'POST', headers: { Cookie: f.admin.cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'family-space', Origin: 'https://another.example' }, body: JSON.stringify({ name: 'Blocked' }) });
    assert.equal(cross.status, 403);
    await f.request('/api/invitations', f.admin.cookie, { email: 'viewer@example.test', role: 'viewer' });
    const viewer = await f.login('viewer@example.test');
    assert.equal((await f.request('/api/people', viewer.cookie, { name: 'Blocked' })).status, 403);
    assert.equal((await f.request('/api/export', viewer.cookie)).status, 403);
    assert.equal((await f.request('/api/state', viewer.cookie)).status, 200);
    assert.equal((await f.request('/api/state', f.admin.cookie)).body.people.length, 0);
    const remote = createApp({ dataDir: await mkdtemp(join(tmpdir(), 'family-space-remote-')), devAuth: true, production: true, bindHost: '0.0.0.0', startWorker: false });
    const directory = remote.store.directory;
    await remote.close(); await rm(directory, { recursive: true, force: true });
  } finally { await f.cleanup(); }
});

test('review belongs to a version; self confirmation, dispute, and stale edits are rejected', async () => {
  const f = await fixture();
  try {
    await f.request('/api/invitations', f.admin.cookie, { email: 'member@example.test', role: 'member' });
    const member = await f.login('member@example.test');
    const person = await f.request('/api/people', f.admin.cookie, { name: 'Test person', facts: { place: 'Initial place' } });
    const state = (await f.request('/api/state', f.admin.cookie)).body as AppState;
    const fact = state.facts.find(item => item.personId === person.body.id && item.key === 'place')!;
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, f.admin.cookie, { action: 'confirm', version: 1 })).status, 403);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member.cookie, { action: 'confirm', version: 1 })).body.status, 'confirmed');
    assert.equal((await f.request(`/api/facts/${fact.id}`, member.cookie, { value: 'Unauthorized', source: '', version: 1 }, 'PATCH')).status, 403);
    const edited = await f.request(`/api/facts/${fact.id}`, f.admin.cookie, { value: 'Corrected place', source: 'Family record', version: 1 }, 'PATCH');
    assert.equal(edited.body.version, 2); assert.equal(edited.body.status, 'unconfirmed'); assert.equal(edited.body.confirmedBy, null);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member.cookie, { action: 'confirm', version: 1 })).status, 409);
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member.cookie, { action: 'dispute', note: 'Check spelling', version: 2 })).body.status, 'disputed');
    assert.equal((await f.request(`/api/review/facts/${fact.id}`, member.cookie, { action: 'confirm', version: 2 })).status, 409);
    const history = await f.request(`/api/history/facts/${fact.id}`, member.cookie);
    assert.deepEqual(history.body.map((entry: { action: string }) => entry.action), ['create', 'confirm', 'edit', 'dispute']);
  } finally { await f.cleanup(); }
});

test('parent ancestry stays acyclic and initial relationships are atomic', async () => {
  const f = await fixture();
  try {
    const a = (await f.request('/api/people', f.admin.cookie, { name: 'A' })).body;
    const b = (await f.request('/api/people', f.admin.cookie, { name: 'B', relation: { relativeId: a.id, type: 'child' } })).body;
    const c = (await f.request('/api/people', f.admin.cookie, { name: 'C', relation: { relativeId: b.id, type: 'child' } })).body;
    assert.equal((await f.request('/api/relations', f.admin.cookie, { fromId: c.id, toId: a.id, type: 'parent' })).status, 409);
    assert.equal((await f.request('/api/relations', f.admin.cookie, { fromId: c.id, toId: a.id, type: 'partner' })).status, 201);
    assert.equal((await f.request('/api/people', f.admin.cookie, { name: 'Invalid', relation: { relativeId: 'missing', type: 'child' } })).status, 404);
    assert.equal((await f.request('/api/state', f.admin.cookie)).body.people.length, 3);
  } finally { await f.cleanup(); }
});

const proposal = (id: string, action: Proposal['action'], values: Partial<Proposal> = {}): Proposal => ({ id, action, status: 'pending', personId: null, personName: null, key: null, value: null, fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote: 'Source text', sourceStart: null, sourceEnd: null, baseVersion: null, ...values });
test('proposal acceptance resolves explicit names, rolls back missing dependencies and never replays', async () => {
  const f = await fixture();
  try {
    const material = (await f.request('/api/materials', f.admin.cookie, { title: 'Test source', kind: 'story', body: 'Source text' })).body as Material;
    const creation = proposal('new-person', 'create_person', { personName: 'Named person' });
    const fact = proposal('new-fact', 'set_fact', { personName: 'Named person', key: 'place', value: 'A place' });
    f.store.put('materials', { ...material, proposals: [creation, fact] });
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [fact], reject: [creation.id], transcriptVersion: null })).status, 400);
    assert.equal(f.store.all('people').length, 0);
    const batch = { accept: [fact, creation], reject: [], transcriptVersion: null };
    const accepted = await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, batch);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.proposals.filter((p: Proposal) => p.status === 'accepted').length, 2);
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, batch)).status, 200);
    assert.equal(f.store.all('people').length, 1); assert.equal(f.store.all<Fact>('facts').length, 2);
    assert.ok(f.store.all<Fact>('facts').every(item => item.status === 'unconfirmed' && item.createdBy === f.admin.body.id));
    const existing = f.store.all<Fact>('facts').find(item => item.key === 'place')!;
    const stale = proposal('stale', 'set_fact', { personId: existing.personId, key: 'place', value: 'Stale value', baseVersion: existing.version });
    f.store.put('materials', { ...f.store.get<Material>('materials', material.id)!, proposals: [stale] });
    await f.request(`/api/facts/${existing.id}`, f.admin.cookie, { value: 'New value', source: '', version: existing.version }, 'PATCH');
    const forged = { ...stale, baseVersion: existing.version + 1 };
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [forged], reject: [], transcriptVersion: null })).status, 409);
    assert.equal(f.store.get<Fact>('facts', existing.id)?.value, 'New value');
    const transcript = await f.request(`/api/materials/${material.id}/transcript`, f.admin.cookie, { text: 'Manually entered transcript', version: 0 }, 'PATCH');
    assert.equal(transcript.status, 200); assert.equal(transcript.body.transcript.automatic, false);
    assert.equal(transcript.body.proposals[0].status, 'rejected');
    assert.equal((await f.request(`/api/materials/${material.id}/transcript`, f.admin.cookie, { text: 'A concurrent first version', version: 0 }, 'PATCH')).status, 409);
    assert.equal(f.store.get<Fact>('facts', existing.id)?.value, 'New value');
  } finally { await f.cleanup(); }
});

test('private original files require a session, validate content, and support byte ranges', async () => {
  const f = await fixture();
  try {
    const invalid = new FormData(); invalid.append('file', new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/png' }), 'fake.png');
    assert.equal((await fetch(f.base + '/api/files', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Requested-With': 'family-space' }, body: invalid })).status, 400);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const data = new FormData(); data.append('file', new Blob([bytes], { type: 'image/png' }), 'pixel.png');
    const upload = await fetch(f.base + '/api/files', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Requested-With': 'family-space' }, body: data });
    const file = await upload.json() as { id: string; url: string; error?: string };
    assert.equal(upload.status, 201, file.error ?? 'Expected a valid upload');
    assert.equal((await fetch(f.base + file.url)).status, 401);
    const ranged = await fetch(f.base + file.url, { headers: { Cookie: f.admin.cookie, Range: 'bytes=0-7' } });
    assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 8));
    const material = await f.request('/api/materials', f.admin.cookie, { title: 'Wrong kind', kind: 'audio', fileId: file.id });
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
      const data = new FormData(); data.append('file', new Blob([bytes]), sample.name);
      const response = await fetch(f.base + '/api/files', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Requested-With': 'family-space' }, body: data });
      const file = await response.json() as { id: string; url: string; mime: string; previewStatus: string; error?: string };
      // The original is accepted first; the browser copy follows in the background.
      assert.equal(response.status, 201, file.error ?? 'The original should be accepted'); assert.equal(file.mime, sample.inputMime); assert.equal(file.previewStatus, 'pending');
      await f.processMedia();
      const record = f.store.get<{ mime: string; path: string; previewPath: string; previewStatus: string; sha256: string }>('files', file.id)!;
      assert.equal(record.mime, sample.inputMime); assert.ok(record.previewPath); assert.equal(record.previewStatus, 'ready');
      assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
      const original = await fetch(f.base + file.url + '?original=1', { headers: { Cookie: f.admin.cookie } });
      assert.equal(original.headers.get('content-type'), sample.inputMime);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      assert.equal((await fetch(f.base + file.url + '/original')).status, 401);
      const preview = await fetch(f.base + file.url, { headers: { Cookie: f.admin.cookie, Range: 'bytes=0-31' } });
      assert.equal(preview.status, 206); assert.equal(preview.headers.get('content-type'), sample.previewMime);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), (await readFile(join(f.store.filesDir, record.previewPath))).subarray(0, 32));
    }
  } finally { await f.cleanup(); await rm(generated, { recursive: true, force: true }); }
});

test('an original survives a failed browser copy and digitised archive formats are accepted', async () => {
  const f = await fixture();
  const generated = await mkdtemp(join(tmpdir(), 'family-space-formats-'));
  const execute = promisify(execFile);
  const send = async (bytes: Buffer, name: string) => {
    const data = new FormData(); data.append('file', new Blob([new Uint8Array(bytes)]), name);
    const response = await fetch(f.base + '/api/files', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Requested-With': 'family-space' }, body: data });
    return { status: response.status, body: await response.json() as { id: string; url: string; mime: string; previewStatus: string; error?: string } };
  };
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
    for (const record of f.store.all<{ name: string; previewStatus: string; previewError?: string }>('files')) assert.equal(record.previewStatus, 'ready', `${record.name}: ${record.previewError}`);

    // A preview that cannot be prepared (here: longer than the configured limit) must not cost the original.
    const long = join(generated, 'long.webm');
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-c:a', 'libopus', '-y', long], { timeout: 15000 });
    const bytes = await readFile(long);
    const previous = process.env.MEDIA_MAX_DURATION_SECONDS; process.env.MEDIA_MAX_DURATION_SECONDS = '1';
    try {
      const upload = await send(bytes, 'long.webm');
      assert.equal(upload.status, 201, upload.body.error ?? '');
      await f.processMedia();
      const record = f.store.get<{ path: string; previewStatus: string; previewError: string; sha256: string }>('files', upload.body.id)!;
      assert.equal(record.previewStatus, 'failed'); assert.match(record.previewError, /Оригинал сохранён/);
      assert.deepEqual(await readFile(join(f.store.filesDir, record.path)), bytes);
      const served = await fetch(f.base + upload.body.url, { headers: { Cookie: f.admin.cookie } });
      assert.equal(served.headers.get('content-type'), 'audio/webm'); assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
      const state = await f.request('/api/conversations', f.admin.cookie, {});
      const message = await f.request(`/api/conversations/${state.body.id}/messages`, f.admin.cookie, { id: randomUUID(), text: '', fileId: upload.body.id, version: state.body.version });
      assert.equal(message.status, 202, JSON.stringify(message.body));
      assert.equal(message.body.messages[0].file.previewStatus, 'failed');
    } finally { if (previous === undefined) delete process.env.MEDIA_MAX_DURATION_SECONDS; else process.env.MEDIA_MAX_DURATION_SECONDS = previous; }

    // Rejected content leaves nothing behind in files/ or its staging area.
    assert.equal((await send(Buffer.from('<html><script>alert(1)</script></html>'), 'page.html')).status, 400);
    const stored = new Set(f.store.all<{ path: string; previewPath?: string }>('files').flatMap(record => [record.path, record.previewPath].filter(Boolean)));
    assert.deepEqual((await readdir(f.store.filesDir)).filter(name => !name.startsWith('.') && !stored.has(name)), []);
    assert.deepEqual(await readdir(join(f.store.filesDir, '.incoming')), []);
  } finally { await f.cleanup(); await rm(generated, { recursive: true, force: true }); }
});

test('explicit name parts stay synchronized with reviewed facts without parsing legacy names', async () => {
  const f = await fixture();
  try {
    await f.request('/api/invitations', f.admin.cookie, { email: 'reviewer@example.test', role: 'member' });
    const reviewer = await f.login('reviewer@example.test');
    const parts = { lastName: ' Тестовая ', firstName: 'Мария', patronymic: 'Ивановна' };
    const created = await f.request('/api/people', f.admin.cookie, { nameParts: parts });
    assert.equal(created.status, 201); assert.equal(created.body.name, 'Тестовая Мария Ивановна');
    const fact = f.store.all<Fact>('facts').find(item => item.personId === created.body.id && item.key === 'name')!;
    assert.deepEqual(fact.nameParts, { ...parts, lastName: 'Тестовая' });
    await f.request(`/api/review/facts/${fact.id}`, reviewer.cookie, { action: 'confirm', version: fact.version });
    const changedParts = { ...fact.nameParts!, lastName: 'Уточнённая' };
    const changed = await f.request(`/api/facts/${fact.id}`, f.admin.cookie, { nameParts: changedParts, source: '', version: 1 }, 'PATCH');
    assert.equal(changed.body.status, 'unconfirmed'); assert.equal(changed.body.confirmedBy, null); assert.equal(changed.body.version, 2);
    assert.equal(f.store.get<Person>('people', created.body.id)?.name, changed.body.value);
    assert.deepEqual(f.store.get<Person>('people', created.body.id)?.nameParts, changedParts);
    const legacy = await f.request('/api/people', f.admin.cookie, { name: 'Старая запись без разбора' });
    assert.equal(legacy.body.name, 'Старая запись без разбора'); assert.equal(legacy.body.nameParts, undefined);
    const raw = await f.request(`/api/facts/${fact.id}`, f.admin.cookie, { value: 'Исправление старым клиентом', source: '', version: 2 }, 'PATCH');
    assert.equal(raw.body.nameParts, undefined); assert.equal(f.store.get<Person>('people', created.body.id)?.nameParts, undefined);
    const material = (await f.request('/api/materials', f.admin.cookie, { title: 'Источник имени', kind: 'story', body: 'Исходный рассказ' })).body as Material;
    const proposed = proposal('structured-name', 'set_fact', { personId: created.body.id, key: 'name', value: 'Это значение будет собрано из частей', baseVersion: 3, nameParts: changedParts });
    const proposedPerson = proposal('structured-person', 'create_person', { personName: 'Имя из предложения', nameParts: { firstName: 'Пётр', lastName: '', patronymic: '' } });
    f.store.put('materials', { ...material, proposals: [proposed, proposedPerson] });
    const accepted = await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [proposed, proposedPerson], reject: [], transcriptVersion: null });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(f.store.get<Person>('people', created.body.id)?.nameParts, changedParts);
    assert.equal(f.store.get<Fact>('facts', fact.id)?.status, 'unconfirmed'); assert.equal(f.store.get<Fact>('facts', fact.id)?.version, 4);
    assert.ok(f.store.all<Person>('people').some(item => item.name === 'Пётр' && item.nameParts?.firstName === 'Пётр'));
  } finally { await f.cleanup(); }
});

test('real full dates reject impossible days while optional and approximate dates stay compatible', async () => {
  const f = await fixture();
  try {
    const invalid = await f.request('/api/people', f.admin.cookie, { name: 'Invalid date', facts: { birthDate: '29.02.1900' } });
    assert.equal(invalid.status, 400); assert.match(invalid.body.error, /календаре/); assert.equal(f.store.all('people').length, 0);
    const person = (await f.request('/api/people', f.admin.cookie, { name: 'Dates', facts: { birthDate: '2000-02-29', deathDate: '' } })).body as Person;
    const birth = f.store.all<Fact>('facts').find(item => item.personId === person.id && item.key === 'birthDate')!;
    assert.equal(birth.value, '29.02.2000'); assert.ok(!f.store.all<Fact>('facts').some(item => item.key === 'deathDate'));
    assert.equal((await f.request(`/api/facts/${birth.id}`, f.admin.cookie, { value: '31.04.2000', source: '', version: 1 }, 'PATCH')).status, 400);
    const approximate = await f.request(`/api/facts/${birth.id}`, f.admin.cookie, { value: 'около 1950', source: '', version: 1 }, 'PATCH');
    assert.equal(approximate.body.value, 'около 1950');
    const material = (await f.request('/api/materials', f.admin.cookie, { title: 'Дата воспоминания', kind: 'story', body: 'Сохранённый рассказ', personIds: [person.id], occurredAt: '1987' })).body as Material;
    assert.equal(material.occurredAt, '1987');
    const dateOnly = await f.request(`/api/materials/${material.id}`, f.admin.cookie, { occurredAt: 'лето 1987 года', version: 1 }, 'PATCH');
    assert.equal(dateOnly.body.occurredAt, 'лето 1987 года'); assert.equal(dateOnly.body.body, material.body); assert.deepEqual(dateOnly.body.personIds, [person.id]);
    const badProposal = proposal('bad-date', 'set_fact', { personId: person.id, key: 'deathDate', value: '2023-02-29' });
    f.store.put('materials', { ...dateOnly.body, proposals: [badProposal] });
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [badProposal], reject: [], transcriptVersion: null })).status, 400);
    assert.ok(!f.store.all<Fact>('facts').some(item => item.key === 'deathDate'));
  } finally { await f.cleanup(); }
});

test('proposal review reuses an already mapped person and refuses two values for one fact', async () => {
  const f = await fixture();
  try {
    const material = (await f.request('/api/materials', f.admin.cookie, { title: 'Repeated source', kind: 'story', body: 'Мария родилась в Туле. Мария жила в Туле.' })).body as Material;
    const first = proposal('first', 'create_person', { personName: 'Мария', sourceQuote: 'Мария родилась в Туле.' });
    f.store.put('materials', { ...material, proposals: [first] });
    const created = await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [first], reject: [], transcriptVersion: null });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const maria = f.store.all<Person>('people')[0];
    // Re-extraction mentions the same relative again; mapping it to the existing card is not a duplicate.
    const again = proposal('again', 'create_person', { personName: 'Мария', sourceQuote: 'Мария жила в Туле.' });
    const current = f.store.get<Material>('materials', material.id)!;
    f.store.put('materials', { ...current, proposals: [...current.proposals!, again] });
    const mapped = await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [{ ...again, personId: maria.id }], reject: [], transcriptVersion: null });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
    assert.equal(f.store.all('people').length, 1);
    // Two accepted values for the same field must not silently overwrite each other.
    const birth1920 = proposal('b1920', 'set_fact', { personId: maria.id, key: 'birthDate', value: '1920', sourceQuote: 'Мария родилась в Туле.' });
    const birth1925 = proposal('b1925', 'set_fact', { personId: maria.id, key: 'birthDate', value: '1925', sourceQuote: 'Мария жила в Туле.' });
    const latest = f.store.get<Material>('materials', material.id)!;
    f.store.put('materials', { ...latest, proposals: [...latest.proposals!, birth1920, birth1925] });
    assert.equal((await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [birth1920, birth1925], reject: [], transcriptVersion: null })).status, 409);
    assert.equal(f.store.all<Fact>('facts').filter(fact => fact.key === 'birthDate').length, 0);
    // A reviewer's correction is accepted but marked: the quote no longer proves the value verbatim.
    const corrected = await f.request(`/api/materials/${material.id}/proposals`, f.admin.cookie, { accept: [{ ...birth1920, value: '1921' }], reject: [birth1925.id], transcriptVersion: null });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    const fact = f.store.all<Fact>('facts').find(item => item.key === 'birthDate')!;
    assert.equal(fact.value, '1921'); assert.equal(fact.sourceEdited, true); assert.equal(fact.sourceQuote, 'Мария родилась в Туле.');
  } finally { await f.cleanup(); }
});

test('interrupted paid processing becomes an explicit error after restart instead of running again', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-space-restart-'));
  try {
    const first = createApp({ dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
    first.store.put('materials', { id: 'material', title: 'Synthetic', kind: 'audio', body: '', narrator: '', occurredAt: '', personIds: [], file: null, createdBy: 'admin', createdAt: '', updatedAt: '', version: 1, transcriptionStatus: 'processing', extractionStatus: 'idle', processingError: null });
    first.store.put('jobs', { id: 'job', materialId: 'material', actorId: 'admin', type: 'transcribe', status: 'processing', sourceVersion: null, sourceHash: '', createdAt: '' });
    first.store.put('files', { id: 'file', name: 'x', mime: 'video/x-msvideo', size: 1, url: '/api/files/file', createdBy: 'admin', path: 'missing', previewStatus: 'processing', previewAttempts: 3 });
    await first.close();
    const second = createApp({ dataDir, devAuth: true, production: false, bindHost: '127.0.0.1', adminEmail: '', startWorker: false });
    try {
      assert.equal(second.store.get<{ status: string }>('jobs', 'job')!.status, 'error');
      const material = second.store.get<Material>('materials', 'material')!;
      assert.equal(material.transcriptionStatus, 'error'); assert.match(material.processingError!, /вручную/);
      // A conversion that kept crashing the process is given up after a bounded number of attempts.
      assert.equal(second.store.get<{ previewStatus: string }>('files', 'file')!.previewStatus, 'failed');
    } finally { await second.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('an oversized upload is refused clearly and leaves no partial bytes behind', async () => {
  const previous = process.env.MAX_UPLOAD_MB; process.env.MAX_UPLOAD_MB = '1';
  const f = await fixture();
  try {
    const data = new FormData(); data.append('file', new Blob([Buffer.alloc(3 * 1024 * 1024, 7)]), 'big.bin');
    const response = await fetch(f.base + '/api/files', { method: 'POST', headers: { Cookie: f.admin.cookie, 'X-Requested-With': 'family-space' }, body: data });
    assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, /1 МБ/);
    assert.deepEqual((await readdir(f.store.filesDir)).filter(name => name !== '.incoming'), []);
    assert.deepEqual(await readdir(join(f.store.filesDir, '.incoming')).catch(() => []), []);
  } finally { await f.cleanup(); if (previous === undefined) delete process.env.MAX_UPLOAD_MB; else process.env.MAX_UPLOAD_MB = previous; }
});
