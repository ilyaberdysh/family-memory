# Contributing

Family Memory is a self-hosted family tree and archive. Each deployment serves
one private family space. The interface currently uses Russian.

Use Node.js 24 or newer, FFmpeg, and `heif-convert` from libheif. Follow the
[local setup](README.md) and run `npm test` and `npm run build` before submitting
a pull request. Tests use temporary data and mocked AI/OIDC responses; they do
not require API keys or a Telegram account.

Keep changes focused. Add regression tests for permission boundaries, data
integrity, persistence, and substantive bugs. Synthetic names and generated media
belong in tests; never add real family information, recordings, exports, or
credentials to issues or commits.

Preserve explicit human review: AI proposes changes, a person accepts them as
unconfirmed, and another participant verifies them. Memories can stand alone.
Do not silently merge people or weaken authentication for production previews.

For interface changes, check a phone-sized viewport and keyboard navigation.
For storage changes, account for existing SQLite data and backups. Avoid
unrelated release/version changes in implementation pull requests.

Contributions are made under the repository's [MIT License](LICENSE).
