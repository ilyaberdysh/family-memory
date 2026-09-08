# Architecture and integration contract

Family Memory is a standalone React + TypeScript application with Express,
`node:sqlite` and local file storage. One deployment serves one private family
space. It is not a shared multi-tenant service.

## Runtime and persistence

- Development uses Vite middleware on the Express server; production serves `dist` from the same process. The default port is `4317`.
- `DATA_DIR` contains `family.sqlite` and `files/`. Container deployments mount the parent at `/var/lib/family-space` and use `/var/lib/family-space/data`.
- Run one application process per database, including during deployment replacement. Background jobs are not coordinated across replicas.
- Application data, files, backups and credentials stay outside the source repository. There are no seeded relatives or stories.
- Shared API data types live in `shared/types.ts`. Server routes, not client-side affordances, enforce access and validation.

## HTTP and access boundaries

API errors use `{error:string}`; successful responses return their direct value.
JSON mutations use `X-Requested-With: family-space`. The server checks origin and
CSRF requirements for mutations, including multipart uploads. Session cookies
are HttpOnly and SameSite=Lax, with Secure enabled in production.

Family endpoints require active membership. Profile, pending and rejected
accounts may access their own authentication state but cannot read the family
archive. Viewers cannot write or review facts. Admin-only operations include
membership approval, role management and full export. Protect the final active
administrator from demotion. Do not reveal other members' contact or Telegram
fields to ordinary members.

## Authentication and invitations

| Endpoint | Contract |
| --- | --- |
| `GET /api/auth/config` | Public space name, up to five family surnames and login availability; no secrets |
| `GET /api/auth/session` | Current account and status, or no session |
| `POST /api/auth/telegram/start` | Start browser-bound OIDC flow |
| `GET /api/auth/telegram/callback` | Validate and consume the one-use login flow |
| `POST /api/auth/profile` | Save separate name parts and phone; Telegram applicant becomes pending, preapproved guest becomes active |
| `POST /api/auth/logout` | Revoke the current session |
| `POST /api/users/:id/approve` | Admin approves a pending applicant with member/viewer role |
| `POST /api/users/:id/reject` | Admin rejects an applicant |
| `PATCH /api/users/:id` | Admin changes an eligible user's role; guest cannot become admin |
| `POST /api/guest-links` | Create a one-use seven-day guest link, optionally for an existing guest account |
| `POST /api/guest-links/:id/revoke` | Admin revokes a link |
| `POST /api/auth/guest-preview` | Inspect valid link metadata without consuming it |
| `POST /api/auth/guest` | Explicitly redeem a link and create a session |
| `PATCH /api/me/person` | Explicitly claim or clear the current account's person association |

Telegram uses Authorization Code flow, PKCE S256, state, nonce and signed
ID-token verification against the expected issuer, audience and timestamps.
Provider credentials are server-only. `ADMIN_TELEGRAM_ID` explicitly designates
the owner before first login; an arbitrary first visitor never becomes admin.
A designated owner can bind to one eligible legacy administrator without changing
authorship. A fresh owner is bootstrapped only when the user table is empty.

Guest links are stored as hashes. Previewing or opening a URL never consumes
one; redemption is an explicit POST. A new link for an existing guest preserves
that account's ID and role. Sessions last up to 365 days.

`FAMILY_SURNAMES` precedes explicit structured surnames and previous-name facts
in the public invitation summary, capped at five. Do not parse legacy full-name
strings or expose tree details before approval. Matching a profile to a tree
person requires a human click, does not rewrite that person's facts and rejects
cards already claimed by another account.

Legacy `/api/auth/request-code` and `/api/auth/verify` routes serve only local
preview on loopback with `DEV_AUTH=1` outside production. They do not send email;
production rejects them. An unconfigured Telegram provider leaves login closed.

## People, facts and relationships

| Endpoint | Contract |
| --- | --- |
| `GET /api/state` | Current user's accessible application state |
| `POST /api/people` | Create a person with reviewed-name metadata and optional initial facts/relationship atomically |
| `PATCH /api/people/:id` | Update person-specific metadata such as avatar with author/admin access |
| `POST /api/facts` | Add a fact; existing person/key combinations use an edit |
| `PATCH /api/facts/:id` | Author/admin edit with optimistic version check |
| `POST /api/relations` | Add a parent or partner relationship; parent direction is `fromId` → child `toId` |
| `PATCH /api/relations/:id` | Author/admin edit with optimistic version check |
| `POST /api/review/:kind/:id` | Confirm or dispute a specific fact/relationship version |
| `GET /api/history/:kind/:id` | Change history for facts, relationships or materials |

Facts and relationships are visible immediately with attribution. Confirmation
requires a different participant from the last editor. Disputes persist until
an edit creates a new version. Validate self-links, duplicate relations and
ancestral cycles on the server.

Separate `NameParts` support cataloguing while the aggregate name remains a
reviewable fact. Preserve existing full-name strings until a person supplies
parts; never guess a legacy surname. Full dates use `DD.MM.YYYY` and calendar
validation; year-only and explicitly approximate dates remain valid. Unknown
dates do not prevent creating a person with a name alone.

## Files, materials and extraction

| Endpoint | Contract |
| --- | --- |
| `POST /api/files` | Validated multipart upload in field `file`; configurable default limit 250 MB |
| `GET /api/files/:id` | Authorized media access with range requests |
| `POST /api/materials` | Create story/photo/audio/video material; enforce file ownership and MIME consistency |
| `GET /api/materials/:id` | Material with transcript and proposals |
| `PATCH /api/materials/:id` | Author/admin edit with version check |
| `PATCH /api/materials/:id/transcript` | Edit transcript and invalidate pending extraction proposals, preserving accepted facts |
| `POST /api/materials/:id/transcribe` | Queue durable transcription job for audio/video |
| `POST /api/materials/:id/extract` | Queue extraction from transcript or story text |
| `POST /api/materials/:id/proposals` | Transactionally apply explicit accept/reject decisions to existing pending proposals |
| `GET /api/export` | Admin JSON export; original files require a full backup |

Validate actual media format; do not serve uploaded HTML, SVG or executable
content as media. Original files are immutable. Browser-compatible derivatives
are prepared locally. Unpublished conversation files are owner/admin-only;
explicit archival makes attached sources readable by the family.

AI modules return transcription or proposals and never directly mutate people,
facts or relationships. Quotes must be grounded in source text. Assistant
responses cannot become sources. Ambiguous people require explicit resolution;
accepted proposals retain the accepting user's authorship and start unconfirmed.
Apply version conflicts and idempotency checks on the server. Partial extraction
may expose a rejected count without discarding valid grounded suggestions.
Stories themselves do not require factual verification.

## Conversations

| Endpoint | Contract |
| --- | --- |
| `GET /api/conversations` | Visible conversation summaries; author and admin access |
| `POST /api/conversations` | Create conversation; writer required |
| `GET /api/conversations/:id` | Conversation detail and processing status |
| `POST /api/conversations/:id/messages` | Persist exactly one text or audio message before background work; client UUID is idempotent |
| `PATCH /api/conversations/:id/messages/:messageId` | Edit last user message with version check and invalidate subsequent old reply |
| `POST /api/conversations/:id/retry` | Retry transcription/reply without inserting a duplicate message |
| `POST /api/conversations/:id/prepare` | Save explicit archive snapshot and extract proposals; never directly write tree changes |
| `POST /api/conversations/:id/archive` | Save a source snapshot without AI; reuse same-version snapshot |

Statuses are `idle`, `responding`, `transcribing`, `preparing` and `error`.
`errorOperation` identifies which action to retry. Run one operation per
conversation, up to two concurrent conversations per process. Partial responses
are persisted; interrupted work becomes an explicit error on restart and needs
manual retry. Versions track changes to user content, not streamed reply deltas.
New dialogue versions create new archive snapshots instead of rewriting accepted
sources. Guard unsaved recording/composer input when navigating away.

## Backup and restore

Use the project's SQLite backup script with referenced originals and derivatives,
not an unsynchronised copy of the database file alone. The final manifest contains
checksums. Restore into a new directory only after stopping the application.
Keep the previous directory until the restored data has been verified.

Restore clears sessions, codes and OAuth flows, revokes old guest links and marks
unfinished AI work interrupted. It must not renew old credentials, automatically
spend API quota or overwrite the source backup. JSON export excludes sessions,
OAuth flows and guest-link authority; backup files still contain private account
and family data and must be stored with restricted access.
