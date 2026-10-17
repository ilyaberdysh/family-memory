# Telegram OIDC callback investigation

## Debug report

- **Symptom:** Telegram authorization returns to the application, which redirects to `/?auth=telegram_failed`; no user or session is created.
- **Root cause:** `oauth4webapi` (under `openid-client`) form-encodes client credentials before building the Basic header, so `_` and `-` in the client secret became `%5F` and `%2D`. Telegram compares the raw `base64(client_id:client_secret)` and rejected every real code exchange.
- **Misleading evidence:** Telegram answers token errors with HTTP 200 and `{"error": ...}`, which the library reported as `"access_token" property must be a string`. It also answers `invalid_grant` to a fake code regardless of credentials, so a fake-code probe cannot validate the Client ID or Secret. The 21 September conclusion that the credentials were "accepted" was wrong.
- **Evidence (5–6 October 2026):** A real code captured on the server and exchanged with the raw Basic header returned tokens. The same code path through the library returned an error; with the library's other request differences removed, Telegram answered `invalid_client`.
- **Also found:** Telegram currently issues the `id` claim as a decimal string, not the documented number.
- **Fix:** Commit `49657fc` sends the documented token request directly (raw Basic auth, form content type, documented parameter order), maps HTTP 200 token errors to 400 so the OAuth error code is logged, and accepts a string `id`. ID-token signature, issuer, audience, nonce and expiry checks still run in the library. Verified end to end against a live Telegram login before deploying.
- **Status:** FIXED, pending one normal login after deploy.
