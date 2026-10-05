import * as oidc from 'openid-client';
import { z } from 'zod';

export interface TelegramIdentity {
  subject: string;
  telegramId: string;
  name: string;
  phone?: string;
  phoneVerified: boolean;
}
type AuthorizationInput = { state: string; nonce: string; verifier: string; redirectUri: string };
export interface TelegramProvider {
  configured: boolean;
  authorizationUrl(input: AuthorizationInput): Promise<string>;
  exchange(input: AuthorizationInput & { callbackUrl: string }): Promise<TelegramIdentity>;
}

const ISSUER = 'https://oauth.telegram.org';
const AUTHORIZATION_URL = `${ISSUER}/auth`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const FAILURE = 'Не удалось подтвердить вход через Telegram. Начните вход заново.';
const diagnosticToken = /^[A-Za-z0-9_.:-]{1,96}$/;
const inputs = z.object({
  state: z.string().min(1).max(512), nonce: z.string().min(1).max(512),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), redirectUri: z.string().max(2048),
});
const identityClaims = z.object({
  sub: z.string().min(1).max(512).refine(value => value.trim() === value && Boolean(value.trim())),
  // Telegram documents a numeric id but currently issues it as a decimal string.
  id: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,19}$/)]),
  name: z.string().trim().min(1).max(302),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
});

function checkInput(input: AuthorizationInput): URL {
  inputs.parse(input);
  const redirect = new URL(input.redirectUri);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback)) || redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error(FAILURE);
  return redirect;
}

function reportFailure(stage: 'configuration' | 'authorization' | 'exchange', error: unknown) {
  if (process.env.NODE_ENV !== 'production') return;
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const field = (name: string) => typeof value[name] === 'string' && diagnosticToken.test(value[name]) ? value[name] : undefined;
  // openid-client wraps the oauth4webapi error, whose message is a fixed string naming the failed check.
  // Its cause contributes only key names and JOSE header metadata, never values.
  const inner = value.name === 'ClientError' && value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {};
  const message = inner.name === 'OperationProcessingError' && typeof inner.message === 'string' && /^[\w "().,:`'-]{1,160}$/.test(inner.message) ? inner.message : undefined;
  const cause = inner.cause && typeof inner.cause === 'object' ? inner.cause as Record<string, unknown> : {};
  const keys = (name: string) => cause[name] && typeof cause[name] === 'object' && !Array.isArray(cause[name])
    ? Object.keys(cause[name]).filter(key => diagnosticToken.test(key)).slice(0, 40) : undefined;
  const header = cause.header && typeof cause.header === 'object' ? cause.header as Record<string, unknown> : {};
  const headerField = (name: string) => typeof header[name] === 'string' && /^[A-Za-z0-9+_.-]{1,32}$/.test(header[name]) ? header[name] : undefined;
  console.error(JSON.stringify({
    event: 'telegram_oidc_failure', stage, name: field('name'), code: field('code'), oauthError: field('error'), status: typeof value.status === 'number' ? value.status : undefined,
    message, claimKeys: keys('claims'), bodyKeys: keys('body'), parameterKeys: keys('parameters'), alg: headerField('alg'), typ: headerField('typ'), claim: typeof cause.claim === 'string' && diagnosticToken.test(cause.claim) ? cause.claim : undefined,
  }));
}

/** Fixed Telegram OIDC endpoints; no userinfo, bot messaging, or persistence. */
export function createTelegramProvider(): TelegramProvider {
  const clientId = process.env.TELEGRAM_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.TELEGRAM_CLIENT_SECRET?.trim() || '';
  const configured = /^[1-9]\d{0,19}$/.test(clientId) && Boolean(clientSecret);
  let pendingConfiguration: Promise<oidc.Configuration> | undefined;
  const configuration = () => {
    if (!configured) throw new Error('Вход через Telegram не настроен.');
    pendingConfiguration ??= oidc.discovery(new URL(ISSUER), clientId, {
      id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 30,
    }, oidc.ClientSecretBasic(clientSecret), {
      timeout: 15,
      // Code-flow token responses require this opt-in for actual JWS signature verification.
      execute: [oidc.enableNonRepudiationChecks],
      [oidc.customFetch]: async (url, options) => {
        if (![DISCOVERY_URL, TOKEN_URL, JWKS_URL].includes(url)) throw new Error(FAILURE);
        if (url !== TOKEN_URL) return fetch(url, { ...options, body: options.body as BodyInit | null, redirect: 'error' });
        // Send exactly Telegram's documented request. Its Basic credentials are the raw base64(client_id:client_secret);
        // the library form-encodes them first (`_` becomes %5F, `-` becomes %2D), which Telegram rejects as invalid_client.
        const sent = new URLSearchParams(String(options.body));
        const body = new URLSearchParams();
        for (const name of ['grant_type', 'code', 'redirect_uri', 'client_id', 'code_verifier']) if (sent.has(name)) body.set(name, sent.get(name)!);
        const response = await fetch(url, {
          method: 'POST', signal: options.signal, redirect: 'error', body,
          headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        });
        // Telegram reports token errors with HTTP 200; restore the standard 400 so the OAuth error code surfaces.
        const text = await response.text();
        let error = false;
        try { const json = JSON.parse(text); error = response.ok && typeof json?.error === 'string' && json.access_token === undefined; } catch { /* non-JSON is handled by the library */ }
        return new Response(text, { status: error ? 400 : response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
      },
    }).then(config => {
      const metadata = config.serverMetadata();
      if (metadata.issuer !== ISSUER || metadata.authorization_endpoint !== AUTHORIZATION_URL || metadata.token_endpoint !== TOKEN_URL || metadata.jwks_uri !== JWKS_URL) throw new Error(FAILURE);
      return config;
    }).catch(error => { pendingConfiguration = undefined; reportFailure('configuration', error); throw new Error(FAILURE); });
    return pendingConfiguration;
  };
  return {
    configured,
    async authorizationUrl(input) {
      if (!configured) throw new Error('Вход через Telegram не настроен.');
      try {
        checkInput(input);
        const config = await configuration();
        return oidc.buildAuthorizationUrl(config, {
          redirect_uri: input.redirectUri, response_type: 'code', scope: 'openid profile phone',
          state: input.state, nonce: input.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(input.verifier), code_challenge_method: 'S256',
        }).href;
      } catch (error) { reportFailure('authorization', error); throw new Error(FAILURE); }
    },
    async exchange(input) {
      if (!configured) throw new Error('Вход через Telegram не настроен.');
      try {
        const redirect = checkInput(input);
        const callback = new URL(input.callbackUrl);
        if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.username || callback.password || callback.hash) throw new Error(FAILURE);
        const config = await configuration();
        const tokens = await oidc.authorizationCodeGrant(config, callback, {
          expectedState: input.state, expectedNonce: input.nonce, pkceCodeVerifier: input.verifier, idTokenExpected: true,
        }, { client_id: clientId, redirect_uri: input.redirectUri });
        const claims = tokens.claims(); // Available only after state, nonce, issuer, audience, expiry and signature checks.
        const identity = identityClaims.parse(claims);
        if (identity.iat > Math.floor(Date.now() / 1000) + 30 || identity.exp <= identity.iat) throw new Error(FAILURE);
        const rawPhone = claims?.phone_number;
        const phone = claims?.phone_number_verified === true && typeof rawPhone === 'string' && /^\+?[1-9]\d{6,14}$/.test(rawPhone)
          ? `+${rawPhone.replace(/^\+/, '')}` : undefined;
        return { subject: identity.sub, telegramId: String(identity.id), name: identity.name, ...(phone ? { phone } : {}), phoneVerified: Boolean(phone) };
      } catch (error) {
        // Library errors may include callback codes, tokens, private claims or upstream bodies.
        reportFailure('exchange', error);
        throw new Error(FAILURE);
      }
    },
  };
}
