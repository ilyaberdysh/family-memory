# Telegram OIDC redirect URI investigation

## Debug report

- **Symptom:** Telegram displayed `redirect_uri required` after starting login.
- **Root cause:** BotFather allowed only the exact root URL with a trailing slash. The application's exact OIDC callback URL was not registered. Telegram returns the misleading `redirect_uri required` page for an unregistered exact redirect URI even though the query parameter is present.
- **Evidence:** The generated authorization URL contained `redirect_uri`, `client_id`, state, nonce, and S256 PKCE. Telegram rejected the callback URL and the root URL without a slash, but accepted the exact registered root URL with a slash.
- **Fix:** Registered `https://family-memory.34.158.158.58.sslip.io/api/auth/telegram/callback` as the Allowed URL in BotFather. This app uses server-side OIDC and does not require the root URL for an embedded Telegram JavaScript widget.
- **Verification:** A fresh authorization request now returns the normal `Telegram Authorization` page. The `redirect_uri required` response is gone.
- **Regression test:** Existing Telegram provider tests cover the exact callback URL and OIDC parameters in `tests/telegram.test.ts`; no application code defect was found.
- **Status:** DONE.
