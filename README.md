# sa-portfolio-admin-ui

Admin UI for the portfolio CMS (Cloudflare Pages). This repo contains the admin shell and CMS logic only; it does **not** own public site assets.

## What this repo contains

- Admin shell (`index.html`) that mounts the CMS portal.
- Admin-only assets under `/admin-assets/*`:
  - `script/cms-portal.js` (CMS UI + editing logic)
  - `partials/CloudFlareCMS/*` (insertable block templates)
  - `img/*` (admin status banners and UI imagery)
- Cloudflare Pages Functions in `/functions`:
  - `/assets/*` proxy to the public site
  - `/api/*` proxy to the CMS Worker

## How it works

- The admin UI fetches real site HTML from the CMS Worker.
- Content inside CMS markers is editable; changes are saved as PRs.
- Core assets (`/assets/*`) are **always** pulled from the public site to keep a single source of truth and avoid drift.

## Data flow

1. Admin UI requests `/api/repo/file` to load a page.
2. The Pages Function forwards to the CMS Worker with Access and branch headers.
3. The editor modifies CMS-marked regions only.
4. A PR is created via `/api/pr`, and the site updates when the PR merges.

## Environment (Cloudflare Pages)

Public-facing repos should not include secrets. The Pages project provides:

- `PORTFOLIO_ORIGIN` (public site origin for `/assets/*` proxy)
- `CMS_WORKER_ORIGIN` (CMS Worker origin for `/api/*` proxy)
- `GITHUB_DEFAULT_BRANCH` (branch to read/write against)
- `CMS_READ_KEY` and `CMS_API_KEY` (server-side only; never committed)

## Branching and environments

- `dev` branch deploys to dev admin (`https://dev.admin.portfolio.tacsa.co.uk`).
- `master` branch deploys to prod admin (`https://admin.portfolio.tacsa.co.uk`).
- `GITHUB_DEFAULT_BRANCH` must match the target public site branch (dev admin -> `dev`, prod admin -> `master`).

## Security posture

- Access-gated `/api/*` routes protect read/write operations.
- Secrets are injected server-side only; no credentials in the repo.
- PR-only writes keep changes auditable and reversible.

## Editor guardrails and persistence

- Toolbars are context-restricted and output is sanitized to an allowlist.
- Drafts and asset previews are cached client-side for resilience (no secrets stored in browser storage).
- Pending blocks are locked until the related PR is resolved.

## Operational constraints (non-negotiable)

- No arbitrary HTML insertion; only canonical block/inline stubs are allowed.
- No formatters/prettifiers touching CMS content.
- Never normalize whitespace inside `<pre>` or `<code>`.
- Serialization must be deterministic and idempotent (load → edit → save → reload).
- Baseline order is immutable; “current” order is derived.
- Avoid broad refactors in `cms-portal.js` unless explicitly requested.

## Deployment

This repo deploys to Cloudflare Pages. The output is a static admin UI with Pages Functions providing proxy routes.

Separate Cloudflare Pages projects provide dev/staging with the same Access controls before changes are promoted to production.

## Local development (quick sanity)

- You can open `index.html` via a local server for UI checks, but `/functions` won’t execute outside Cloudflare Pages.
- For end-to-end testing (Access + API proxy + worker), use a Pages preview or the dev admin domain.

## CMS contract reference

- Canonical block schema + serialization rules live in the core repo ADRs (see `../VoodooScience1.github.io/docs/adr`, especially ADR-013/014/015).
- The admin UI must emit only stubs supported by `sections.js` to keep preview identical to production.

## Key decisions and tradeoffs

- Asset proxying keeps a single source of truth but means admin preview depends on public site availability.
- Access-gated `/api/*` improves security but adds login friction for testing.
- Block-based HTML editing avoids CMS lock-in but requires marker discipline.
- Separation of concerns keeps admin logic, templates, and tooling isolated from public site content and assets.

## Related repos

- Public site: `VoodooScience1.github.io`

## Links

- Admin (prod): https://admin.portfolio.tacsa.co.uk/
- Admin (dev): https://dev.admin.portfolio.tacsa.co.uk/
- Public site (prod): https://portfolio.tacsa.co.uk/
- Public site (dev): https://dev.portfolio.tacsa.co.uk/

## How to add a new block type (checklist)

- Add or update the canonical markup in `VoodooScience1.github.io` (HTML/CSS/JS).
- Extend `assets/script/sections.js` if the block needs runtime expansion.
- Add a matching block partial in `admin-assets/partials/CloudFlareCMS`.
- Wire the editor UI + serialization rules in `admin-assets/script/cms-portal.js`.
- Update ADRs (schema + RTE rules + serializer) to keep the contract explicit.

## FAQ

- Why proxy `/assets/*`? It guarantees a single source of truth for styling and UI behavior across the public site and the CMS preview.
- Why PRs only? It keeps edits auditable, reviewable, and reversible.
