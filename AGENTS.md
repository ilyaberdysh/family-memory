# Family Memory

This is a standalone application for one private family space per deployment.
Read [README.md](README.md) for setup, [CONTRACT.md](CONTRACT.md) for architectural
boundaries, and [DEPLOYMENT.md](DEPLOYMENT.md) for production operations.

## Working rules

- Preserve user-provided names, dates, sources and stories. Never invent family content or seed relatives into a real database.
- Keep manual editing available independently of AI. AI proposes; a person accepts; a different participant verifies facts and relationships.
- Do not accept proposals, merge people or link accounts to tree records without explicit user selection.
- Protect private family data, files and conversations on the server. Never bypass production authentication or enable `DEV_AUTH` in production.
- Keep credentials, `.env` files, databases, uploads, backups and private screenshots out of Git, logs and documentation.
- Use synthetic fixtures for tests. Never copy a real family transcript into a public test or issue.
- Surface API errors honestly. Do not replace failed AI processing with fabricated successful output.
- Keep the interface calm, readable and usable on phones, with clear labels, focus states and direct actions.
- Coordinate file ownership when working in parallel; this repository does not assign permanent files to particular agents.
- Do not bump versions or add release tags as part of ordinary implementation work. Releases are a separate task.

## Validation

Run checks appropriate to the change. `npm run build` checks TypeScript and builds
the frontend; `npm test` covers the critical data and access boundaries. Use
disposable storage for browser and integration checks. Document material limits
without claiming that mocked integrations prove a live deployment works.
