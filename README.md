# Mica Resources

The resource publishing service of Mica OS behind `res.micaos.dev`: a control
plane (SQLite, admin UI, publishing API) and an edge Worker, with public bytes
served straight from R2. The design and its phases are in
`docs/plan/20260917-0852-public-resource-framework.md`.

Built on the [bun-tpl](https://github.com/zzci/bun-tpl) template (tracked as
the `template` remote, see `docs/develop/forking.md`):

- **API** — Hono on Bun or Cloudflare Workers, SQLite via Drizzle.
- **Web** — React 19 + TanStack Router + Tailwind v4, file-based routes, dual EN/ZH i18n.
- **Modules** — account/auth (OAuth + TOTP, API tokens), groups, Zanzibar relation tuples, settings, audit logs, encryption admin, JSON backup, and `resource`.
- **Site** — `apps/site`, the public home page at `/`.

| Host | What |
| --- | --- |
| `https://dl.res.micaos.dev` | Public bytes, straight from R2: `<namespace>/<path>` |
| `https://res.micaos.dev` | Home page, directory listings, legacy redirects, `/v2` registry, `/admin` |
| `https://s3.res.micaos.dev` | S3 read API, path-style, bucket = namespace |

How it works, how to publish, delete and protect resources, and the one-time
deployment steps: [`docs/modules/resource.md`](docs/modules/resource.md).
The mirror tooling that feeds it lives in `packages/mica-sync`.

## Quick start

```bash
bun install
cp .env.example .env       # uncomment the "Bundled dex IdP" block
bun run dev:all            # starts dex + web + api in one process group
```

Open the URL printed by `bun run dev:all` (e.g. `http://mica-res.localhost:3355`). Sign in with `admin@example.com` / `admin` — the bundled dex's static user. That login is an admin because it matches `DEFAULT_ADMIN`.

Already have an OAuth/OIDC provider? Point `OAUTH_ISSUER` at it in `.env` and use `bun run dev` instead — `dev:all` detects an external issuer and bows out so it doesn't fight your IdP.

### Reset local state

After `bun run dev:all` has run, `data/` contains the SQLite DB, uploaded blobs, and the OIDC discovery cache. To start over (e.g. after experimenting with `DB_ENCRYPTION=true` and forgetting the master password):

```bash
bun run clean        # build artefacts only (dist/, .vite/, .tanstack/, coverage/)
bun run clean:all    # also wipes data/ — DB, uploads, logs, oidc cache
```

`clean:all` is destructive; uncommitted local data is gone. Use it on a fresh clone or after intentionally tearing down a local experiment.

### First-run setup (only when `DB_ENCRYPTION=true`)

`DB_ENCRYPTION` defaults to `false` in dev — `bun run dev:all` lands you on login directly. If you enable encryption (recommended for production deploys), the first boot adds:

1. Visit `/<base>/setup`.
2. Paste the bootstrap token. It is auto-generated at every boot and surfaced via stderr / `<data dir>/bootstrap-token.txt` while the system is in setup mode; both go away once init succeeds.
3. Choose a master password — this derives the master keypair that wraps the data-encryption key (DEK).
4. Save the recovery key file (`<APP_NAME>-master-key.txt`).
5. Sign in via OAuth. Any login matching `DEFAULT_ADMIN` is an admin.

## Customize

- **Identity** — set `APP_NAME` (slug) and `APP_DISPLAY_NAME` in `.env`. HTML title, TOTP issuer, backup filename, and sessionStorage namespace derive from these. `BASE_PATH` is unset by default (root mount); set it to serve under a URL prefix. See [`docs/develop/forking.md`](docs/develop/forking.md).
- **Modules** — keep what you need, drop the rest. See [`docs/README.md`](docs/README.md) §3. To add one, follow [`docs/develop/module/playbook.md`](docs/develop/module/playbook.md) (10-step checklist) with starter files in [`docs/develop/module/recipe.md`](docs/develop/module/recipe.md).
- **Logo** — replace `apps/web/public/logo.svg` and the inline SVG in `apps/web/src/shared/components/logo.tsx`.

## Commands

```bash
bun run dev            # Vite dev server (web + API via @hono/vite-dev-server)
bun run dev:all        # dev + bundled dex IdP, one process group
bun run dev:dex        # just the bundled dex IdP (use when running dev in another terminal)
bun run rebrand        # rewrite manifests + .env defaults for a fork
bun run build          # Build all packages
bun run build:worker   # Build the home page + admin SPA into dist/worker-assets for wrangler
bun run lint           # ESLint
bun run typecheck      # tsc --noEmit
bun run test           # Unit tests (bun:test + vitest)
bun run test:e2e       # Live e2e: dex + API + encrypted DB + every module
bun run test:workers   # workerd smoke: Durable Object boot, catalog publish, edge reads
bun run check          # lint + typecheck + test + build + check:i18n + check:env-docs + check:api-docs
bun run gen:env-docs   # regenerate docs/reference/env-reference.md from the zod schema + .env.example
bun run gen:api-docs   # regenerate docs/reference/api-routes.md from the in-process Hono routes
bun run package        # Build the lode release asset (dist/<app>-<os>-<arch>.tar.gz + manifest.json + checksums.txt)
bun run clean          # Remove build artifacts
```

## Layout

```text
apps/api/          Hono API; Drizzle schema lives per-module
apps/web/          React 19 SPA (TanStack Router file-based), the admin console at /admin
apps/site/         Home page SPA at /
apps/api/src/edge/ Edge plane: listings, redirects, registry, S3 read API
packages/mica-sync/ Mirror CLI: enumerate pinned inputs and publish them
packages/shared/   ECIES utilities used by both api and web
packages/tsconfig/ Shared TS config
docs/              Architecture, module standards, deployment, rebranding
tests/e2e/         Live e2e harness (dex + API)
scripts/           dev-all / dev-dex / rebrand / package / clean / hash-password
                   / check-i18n / i18n:unused / i18n:clean / gen-env-docs
```

## Documentation

- [`docs/README.md`](docs/README.md) — using the template
- [`docs/architecture.md`](docs/architecture.md) — runtime shape
- [`docs/develop/module/standards.md`](docs/develop/module/standards.md) — adding a module
- [`docs/develop/forking.md`](docs/develop/forking.md) — full rebranding checklist
- [`docs/develop/deployment.md`](docs/develop/deployment.md) — production deployment + upgrade
- [`docs/develop/operations.md`](docs/develop/operations.md) — runbook (logrotate, backup, restore, known issues)
- [`docs/develop/forking.md`](docs/develop/forking.md) — merging upstream template changes
- [`docs/modules/`](docs/modules) — per-module deep dives

## packages/mica-sync

The mirror: reads the producers' locks and releases and publishes the pinned
objects through the control plane (`MICA_RES_TOKEN`, a `res:publish` API
token). See `packages/mica-sync/docs/architecture.md`.

| Command | Purpose |
| --- | --- |
| `bun packages/mica-sync/src/cli.ts sync [--sizes]` | Enumerate what the service should hold; writes nothing |
| `bun packages/mica-sync/src/cli.ts sync --apply` | Publish the missing objects |
| `bun packages/mica-sync/src/cli.ts audit` | Check the published catalog against the download host |

## mica/brand/logo

| File | Description |
| --- | --- |
| `mica-os-icon.svg` | Icon, 512×512, dark rounded square |
| `mica-os-icon-dark.svg` | Icon without the square, for dark surfaces |
| `mica-os-icon.png` | Icon, 512×512, transparent outside the rounded corners |
| `mica-os-wordmark.svg` | Wordmark, 1394×353, for light surfaces |
| `mica-os-wordmark-dark.svg` | Wordmark, 1394×353, for dark surfaces |
| `mica-os-wordmark.png` | Wordmark, 1394×353, transparent background |
| `mica-os-github-avatar.png` | GitHub organisation avatar, 512×512 |
