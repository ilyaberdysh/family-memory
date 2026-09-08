import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createTelegramProvider } from '../server/telegram.js';

const issuer = 'https://oauth.telegram.org';
const clientId = '123456789';
const secret = 'mock-client-secret';
const input = { state: 'random-state-for-this-login', nonce: 'random-nonce-for-this-login', verifier: 'a'.repeat(64), redirectUri: 'https://family.example.test/api/auth/telegram/callback' };
const callbackUrl = `${input.redirectUri}?code=one-time-test-code&state=${input.state}`;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const metadata = { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/.well-known/jwks.json`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] };
const claims = () => ({ iss: issuer, aud: clientId, sub: 'opaque-stable-subject', id: 987654321, name: 'Тестовый пользователь', nonce: input.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, phone_number: '79991234567', phone_number_verified: true });
function token(data: Record<string, unknown>, wrongKey = false, alg = 'RS256') {
  const encoded = [Buffer.from(JSON.stringify({ alg, kid: 'test-key', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(data)).toString('base64url')].join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), wrongKey ? otherKey.privateKey : key.privateKey).toString('base64url')}`;
}
function setup(t: TestContext, reply: () => string, discovery = metadata) {
  const previous = [process.env.TELEGRAM_CLIENT_ID, process.env.TELEGRAM_CLIENT_SECRET];
  process.env.TELEGRAM_CLIENT_ID = clientId;
  process.env.TELEGRAM_CLIENT_SECRET = secret;
  t.after(() => { for (const [index, name] of ['TELEGRAM_CLIENT_ID', 'TELEGRAM_CLIENT_SECRET'].entries()) if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  let tokenRequests = 0;
  let networkError: unknown;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    try {
      const endpoint = String(url);
      calls.push(endpoint);
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      if (endpoint === `${issuer}/.well-known/openid-configuration`) return Response.json(discovery);
      if (endpoint === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] });
      assert.equal(endpoint, `${issuer}/token`, 'no userinfo or unexpected external endpoint');
      tokenRequests++;
      assert.equal(options?.method, 'POST');
      const authorization = new Headers(options?.headers).get('authorization') ?? '';
      assert.ok(authorization.startsWith('Basic '));
      const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':').map(value => decodeURIComponent(value.replace(/\+/g, ' ')));
      assert.deepEqual(credentials, [clientId, secret]);
      const body = new URLSearchParams(String(options?.body));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'one-time-test-code');
      assert.equal(body.get('code_verifier'), input.verifier);
      assert.equal(body.get('redirect_uri'), input.redirectUri);
      assert.equal(body.get('client_id'), clientId);
      assert.equal(body.has('client_secret'), false);
      return Response.json({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600, id_token: reply() });
    } catch (error) { networkError = error; throw error; }
  });
  return { provider: createTelegramProvider(), calls, tokenRequests: () => tokenRequests, networkError: () => networkError };
}

test('official OIDC flow binds state, nonce and S256 PKCE, exchanges code with Basic auth and verifies signed identity', async t => {
  let payload: Record<string, unknown> = claims();
  const fixture = setup(t, () => token(payload));
  assert.equal(fixture.provider.configured, true);
  const authorization = new URL(await fixture.provider.authorizationUrl(input));
  assert.equal(authorization.origin + authorization.pathname, `${issuer}/auth`);
  for (const [name, value] of Object.entries({ client_id: clientId, redirect_uri: input.redirectUri, response_type: 'code', scope: 'openid profile phone', state: input.state, nonce: input.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(input.verifier).digest('base64url') })) assert.equal(authorization.searchParams.get(name), value);
  assert.deepEqual(await fixture.provider.exchange({ ...input, callbackUrl }).catch(error => { throw fixture.networkError() ?? error; }), { subject: 'opaque-stable-subject', telegramId: '987654321', name: 'Тестовый пользователь', phone: '+79991234567', phoneVerified: true });
  assert.ok(fixture.calls.includes(`${issuer}/.well-known/jwks.json`), 'signature verification must fetch a trusted signing key');
  for (const phoneClaims of [{ phone_number: undefined, phone_number_verified: undefined }, { phone_number: '79991234567', phone_number_verified: false }, { phone_number: '79991234567', phone_number_verified: 'true' }]) {
    payload = { ...claims(), ...phoneClaims };
    const identity = await fixture.provider.exchange({ ...input, callbackUrl });
    assert.equal(identity.phone, undefined);
    assert.equal(identity.phoneVerified, false);
  }
});

test('bad signatures, algorithms, audiences, nonce, timestamps and missing identities fail without leaking claims or credentials', async t => {
  let payload: Record<string, unknown> = claims();
  let wrongKey = false;
  let algorithm = 'RS256';
  const fixture = setup(t, () => token(payload, wrongKey, algorithm));
  const rejected = () => assert.rejects(() => fixture.provider.exchange({ ...input, callbackUrl }), error => error instanceof Error && error.message === 'Не удалось подтвердить вход через Telegram. Начните вход заново.');
  assert.equal((await fixture.provider.exchange({ ...input, callbackUrl })).telegramId, '987654321');
  wrongKey = true;
  await rejected();
  wrongKey = false;
  algorithm = 'HS256';
  await rejected();
  algorithm = 'RS256';
  for (const change of [{ aud: 'another-client' }, { iss: 'https://another.example' }, { nonce: 'wrong-nonce' }, { exp: Math.floor(Date.now() / 1000) - 120 }, { iat: Math.floor(Date.now() / 1000) + 120 }, { iat: undefined }, { id: undefined }, { id: Number.MAX_SAFE_INTEGER + 1 }, { sub: '' }]) {
    payload = { ...claims(), ...change };
    await rejected();
  }
  const before = fixture.tokenRequests();
  await assert.rejects(() => fixture.provider.exchange({ ...input, callbackUrl: `${input.redirectUri}?code=one-time-test-code&state=wrong-state` }), /Начните вход заново/);
  await assert.rejects(() => fixture.provider.exchange({ ...input, callbackUrl: `https://attacker.example/callback?code=one-time-test-code&state=${input.state}` }), /Начните вход заново/);
  assert.equal(fixture.tokenRequests(), before, 'bad state or callback destination must never exchange a code');
  assert.equal(fixture.networkError(), undefined, 'negative JWT checks must not pass because the HTTP mock rejected a request');
});

test('missing configuration and unexpected discovery endpoints fail closed before credentials are sent', async t => {
  const fixture = setup(t, () => token(claims()), { ...metadata, token_endpoint: 'https://attacker.example/token' });
  await assert.rejects(() => fixture.provider.authorizationUrl(input), /Начните вход заново/);
  assert.equal(fixture.tokenRequests(), 0);
  delete process.env.TELEGRAM_CLIENT_SECRET;
  const unavailable = createTelegramProvider();
  assert.equal(unavailable.configured, false);
  await assert.rejects(() => unavailable.authorizationUrl(input), /не настроен/);
  await assert.rejects(() => unavailable.exchange({ ...input, callbackUrl }), /не настроен/);
  assert.deepEqual(fixture.calls, [`${issuer}/.well-known/openid-configuration`]);
});
