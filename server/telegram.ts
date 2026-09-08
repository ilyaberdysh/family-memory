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
const inputs = z.object({
  state: z.string().min(1).max(512), nonce: z.string().min(1).max(512),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), redirectUri: z.string().max(2048),
});
const identityClaims = z.object({
  sub: z.string().min(1).max(512).refine(value => value.trim() === value && Boolean(value.trim())),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
        return fetch(url, { ...options, body: options.body as BodyInit | null, redirect: 'error' });
      },
    }).then(config => {
      const metadata = config.serverMetadata();
      if (metadata.issuer !== ISSUER || metadata.authorization_endpoint !== AUTHORIZATION_URL || metadata.token_endpoint !== TOKEN_URL || metadata.jwks_uri !== JWKS_URL) throw new Error(FAILURE);
      return config;
    }).catch(() => { pendingConfiguration = undefined; throw new Error(FAILURE); });
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
      } catch { throw new Error(FAILURE); }
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
      } catch {
        // Library errors may include callback codes, tokens, private claims or upstream bodies.
        throw new Error(FAILURE);
      }
    },
  };
}
