# Changelog

Track changes your fork makes on top of this template. Format adapted from
[Keep a Changelog](https://keepachangelog.com/) — group entries under
**Added / Changed / Removed / Fixed / Security**. The `Unreleased` block
holds work since your last tag.

Upstream cuts versioned tags so forks can anchor diffs against a known
template version. The boundary entries below summarise what shipped in
each upstream tag; your fork's `Unreleased` block sits at the top.

## Unreleased

### Added

- Runtime seam under `apps/api/src/platform/` (`getPlatform()`): `env`,
  a TTL key/value store (`kv.namespace(...)`), a background `scheduler`,
  an `openDatabase` override, and a `capabilities` flag set. The rate
  limiter, TOTP step-up tokens, the file GC and audit retention sweeps, and
  config env reads go through the seam instead of touching `Bun.env` /
  `setInterval` / module-level maps directly. No behaviour change on Bun.
- Cloudflare Workers as a second runtime target, selectable without forking
  the app. The whole API runs inside one Durable Object that owns its SQLite
  database (not D1: D1 is auto-commit only and cannot express this app's
  interactive read-then-write transactions); blobs go to R2 through a new
  storage driver; background sweeps run off a Durable Object alarm; the SPA
  is served by the asset pipeline. Configuration is `apps/api/wrangler.toml`,
  entry point `apps/api/src/workers/`, and migrations are bundled into
  `src/db/migrations.generated.ts` by `bun run db:generate`. See
  `docs/develop/runtime.md`.
- `bun run test:workers` — a smoke suite that boots the app in workerd and
  covers boot, login, transaction commit, transaction rollback and an R2
  round trip. Runs in the new `workers` CI workflow, which also smoke-tests a
  preview deployment when Cloudflare credentials are configured.
- Per-user rate limits on creating content, held in a new `rate_limits`
  table. The middleware is mounted once and discovers the creating routes
  from the router table — a `POST` whose path also answers `GET` creates a
  member of that collection — so a new module is covered as soon as it
  mounts and an action route like `POST /cron/jobs/:id/trigger` is left
  alone. `CREATE_RATE_LIMIT_EXEMPT` opts a resource out. Budgets are per
  resource — `issue`, `document`, `comment`, `attachment`, ... — so a burst
  of one does not spend the budget for another,
  and two windows apply together: `CREATE_RATE_LIMIT_PER_MINUTE` (default
  60) bounds a burst and `CREATE_RATE_LIMIT_PER_HOUR` (default 600) bounds
  the sustained rate; either at 0 disables that window. Rejected requests
  keep counting, so sustained abuse escalates from the minute window into
  the hour one. The counters are stored rather than in-memory because
  creation is where an authenticated caller can grow the database without
  bound, and a counter that dies with the process can be defeated by pacing
  requests around a restart or, on Cloudflare Workers, around an eviction.
  Both windows are bumped by a single upsert so concurrent requests cannot
  lose an increment. Like `auth_lockouts`, the table is deliberately excluded
  from backups.
- Runtime capability gates: `DB_ENCRYPTION=true`, `CRON_ENABLED=true`,
  argon2/bcrypt password hashes and the cron `shell` action are refused on a
  runtime that cannot support them, at boot rather than at request time. The
  cron gate exists because the scheduler holds its own per-job timers and a
  host that evicts the app when idle would drop jobs silently; such
  deployments drive jobs through `POST /api/cron/jobs/:id/trigger` instead.

### Changed

- The auth and encryption routes no longer carry their own fixed-window
  counters. All in-memory rate limiting now goes through one implementation,
  `consumeRateLimit` in `shared/middleware/rate-limit.ts`, so there is a
  single eviction policy (evict the entry closest to expiry, keeping an
  address under active abuse) and one behaviour on every runtime. The
  thresholds, bucket sharing and 429 shapes are unchanged.

- Replaced the single-binary build (`scripts/compile.ts`) with a
  [lode](https://github.com/dotns/lode)-compatible release asset
  (`scripts/package.ts`): a tarball of the bundled `index.js`, SPA `dist/`,
  Drizzle `drizzle/`, and the libsql native binding, plus `manifest.json`
  (schema `lode/v1`) and `checksums.txt`. The app serves the SPA and runs
  migrations from the filesystem (no embedded asset map), detects the packaged
  layout via `ROOT_DIR`, and implements the lode `state.json` readiness/prepare
  handshake; `/api/system/version` now reports a lode upgrade summary.
- `Dockerfile` / `docker-compose.yml` now run the lode supervisor (it downloads,
  verifies, runs, and auto-updates the release asset) instead of baking the app
  into the image. `deploy/lode.toml` is the operator config template.
- `release.yml` builds and uploads the lode asset to a published GitHub Release
  instead of pushing a container image.
- Group membership lives in a dedicated `group_members` table owned by the
  account module instead of `relation_tuples`. The Zanzibar engine reads
  `group:*#member` through `group-members.service` so a deployment can drop
  the policy module while keeping user-group features.
- `POST /api/policy/tuples` (and the batch endpoint) now refuse
  `group:*#member` writes; callers must use
  `POST /api/account/groups/:id/members`.
- Refreshed the dependency baseline. Majors: `vitest` / `@vitest/coverage-v8`
  4 → 5, `nanoid` 5 → 6, `@hono/standard-validator` 0.2 → 0.4,
  `@libsql/client` 0.17 → 0.18, `@scalar/hono-api-reference` 0.11 → 0.12.
  Everything else moves to the latest minor/patch (hono, hono-openapi, zod,
  oauth4webapi, react 19.3, vite 8.3, tailwind 4.3.3, eslint 10.10, the
  TanStack and Milkdown packages, …). `routeTree.gen.ts` is regenerated by the
  newer `@tanstack/router-plugin`. TypeScript stays on 6.0.3: `typescript-eslint`
  8.x still caps its peer range at `<6.1.0`, so TypeScript 7 would break linting.
- The app sidebar now starts expanded when the visitor has no stored
  `sidebar_state` preference (it used to start collapsed).
- Bun 1.3.14 → 1.4.2 and Node 22.13.0 → 24.21.0 across every pin: CI and
  release workflows, the runtime image base (`oven/bun:1.4.2-debian`) and
  `deploy/lode.toml`'s runtime download. `@types/bun` already tracks 1.4.2, so
  the type surface and the runtime now match again. Bun 1.4.2 still does not
  fail a run on bunfig `coverageThreshold` (verified), so the CI coverage gate
  stays; the api coverage baseline it documents moves to lines 85.93% /
  functions 78.79% under the new runtime.
- `PolicyContext` carries a request-scoped `PermissionCache`: repeated
  checks of the same `(object, relation, actor)` within one request —
  middleware gate + handler `assert`, per-field `filterWritable` /
  `projectFields`, editor-then-viewer probes — resolve once. The actor's
  group closure is computed once per request and passed to the engine
  (`CheckOptions.groupClosure`), turning group usersets into set lookups.
  `grant` / `revoke` clear it; hooks still fire per call.
- `check()` fetches all tuples on a `(namespace, objectId)` once per
  resolution and answers every rung of the `computed_userset` ladder from
  memory, instead of two to four queries per rung on the same object.
- `relation_tuples.subject_relation` is `NOT NULL DEFAULT ''`: a direct
  subject is stored as the empty string so `idx_tuples_unique` enforces
  uniqueness for direct grants (SQLite treats NULLs as distinct). The API
  still reads and writes `null`. The application-level duplicate pre-check
  and its `BEGIN IMMEDIATE` transaction are gone; a collision surfaces as
  the same 422.
- Resource groups have their own `resource_groups` table (`id`, `name`,
  `description`, unique name). The `__meta__` tuple that smuggled the
  description into `subject_relation` is gone, along with the name-clash
  pre-checks it needed.
- `group_members.subject_relation` gets the same treatment as
  `relation_tuples`: `NOT NULL DEFAULT ''`, so `idx_group_members_unique`
  enforces direct-membership uniqueness and `addUserMember`'s pre-check is
  gone. Callers still pass `null` for "direct member"; storage holds the
  sentinel.
- Backup format is v3. Older dumps migrate forward on import: v1 → v2
  (tuple null → sentinel, `__meta__` → `resource_groups`), v2 → v3
  (group-member null → sentinel).
- `find-unused-i18n` / `clean-unused-i18n` are wired as `bun run i18n:unused`
  / `bun run i18n:clean`; the README listed them as scripts but nothing did.
- `bun run clean:all` now removes `data/db` (the local database with its
  WAL/SHM, pid file and encryption `meta.db`) — the README already said it
  did. Needed whenever the squashed `0000_init` migration is regenerated,
  since a dev DB from the old schema cannot be migrated forward.
- `initFileModule` warns once at boot when `FILE_PRESIGN_ENABLED` (default
  `true`) is set on a storage driver that cannot presign — the bundled
  `local` driver — instead of silently streaming every download through
  the API.
- `docker-compose.yml` drops all capabilities and sets
  `no-new-privileges` on the app service (the image already runs as the
  unprivileged `bun` user).
- The release workflow signs the lode asset (`scripts/ci/sign-release.sh`,
  `<asset>.sig` sidecar) whenever the `LODE_SIGNING_KEY` secret is set and
  uploads the signature alongside; `deploy/lode.toml` and the deployment
  guide explain that `require_signature = "auto"` installs UNVERIFIED until
  a `trusted_keys` entry is configured.
- **Migration note for forks with a deployed database:** per template
  convention the single squashed `0000_init` migration was regenerated in
  place rather than appended to. A database already at `0000_init` will
  not pick up the `subject_relation` constraint or the `resource_groups`
  table automatically; apply the two changes by hand (or export a backup,
  recreate, and import — the importer migrates the dump).

### Fixed

- `PATCH /api/policy/tuples/:id` deleted the old tuple before validating the
  new relation, so a rejected relation (typo, or one that collided with an
  existing row) answered 422 and silently revoked the permission. The rewrite
  now validates first and runs delete + insert in one transaction
  (`updateTupleRelation`). The route also goes through the same
  `group:*#member` guard as `POST` and the batch endpoint.
- `POST /api/policy/tuples/batch` accepted the same tuple twice in one payload
  and inserted both — the duplicate check only looked at rows already in the
  table, and `idx_tuples_unique` cannot catch it when `subjectRelation` is
  NULL. Intra-batch duplicates are now a 422 before anything is written.
- `policyMiddleware` let the handler run when a route binding pointed at a
  resource with no registered definition. It now fails closed with a 500 —
  that state is a wiring bug, not a reason to skip the permission check.
- `expand()` had only the depth cap; `check()` / `listUserResources()` also
  carried the shared node budget. It now threads the same budget through
  every recursive branch, so a wide nested-userset graph is cut off instead
  of walked in full.
- `registerRouteBinding()` accepted a second binding on the same
  `(method, path)`, which would gate the route twice with whichever action
  each declared. It now throws at registration.
- `listUserResources()` hard-coded its `tuple_to_userset` branch to
  `resource_group`, so for the shipped `item` namespace (`parent_item`
  edges with `item` subjects) "which objects can I see" silently dropped
  every inherited grant; only documents got subtree visibility, via a
  module-side recursive CTE. The branch is now the true reverse of
  `check()`: config-driven, self-referential rules walk to a fixpoint under
  the node budget, cross-namespace rules recurse. The document CTE is gone.
- The issue module answered "may I?" from two different authorities: its
  own routes and comments checked the `items` columns (`admin || creator ||
  assignee`), while the generic `/files/*` download path and comment
  attachments asked the policy engine — so the same attachment could be 200
  on one URL and 403 on the other, and an engine-granted `viewer` was
  refused by `GET /issues/:id` while `/permissions` said yes. Issues are now
  a `defineResource` on the `item` namespace (`issue:read` / `download` →
  viewer, `issue:update` → editor, `issue:transition` (status-only) →
  assignee, `issue:delete` → owner, `issue:manage_attachments` → assignee),
  and `assignee` now implies `viewer` in the namespace so the handler keeps
  read access everywhere. Every issue path resolves through the engine.
- The cron `http-request` action followed redirects, so a public URL
  answering `302` to a private address slipped past the DNS-pinned SSRF
  guard. Redirects are now reported, never followed, and the response body
  is read to a 64 KiB cap instead of being buffered in full.
- `errorHandler` never mapped SQLite constraint errors to 409: drizzle wraps
  the driver error, so the code/message it checked lived on `.cause`. The
  check now walks the cause chain (`isConstraintViolation`).
- `listReferencesByOwner` ordered by `created_at` then the random reference
  id, so two attachments written in the same millisecond came back in
  arbitrary order (a long-standing flaky test). Ties now break by insertion
  order (`rowid`).
- **Encrypted databases could become "database disk image is malformed".**
  `createDb` set `PRAGMA mmap_size = 256 MiB` unconditionally; libsql's
  page-level encryption and memory-mapped I/O do not mix, and under an
  ordinary write sequence (reproduced end-to-end by the new `/api/files`
  e2e, deterministic per sequence) a fresh-page append left the encrypted
  file unreadable — surfacing as 500s mid-run or a failed unlock after
  restart. Encrypted databases are no longer memory-mapped; plaintext keeps
  the mapping. A test pins the pragma per mode.
- The generic `/api/files/*` download path was admin-only in the shipped
  app: `cronRoutes()` registered `router.use("*", adminRequired)`, and Hono
  merges a sub-router's `use("*")` into the parent where it applies to
  every router mounted afterwards — `fileRoutes()` is mounted last. Cron's
  guard is now scoped to `/cron/*`; a composition test over
  `protectedRoutes()` pins that a non-admin reaches later routers.
- `stopFileGcSweep()` only cancelled timers; a sweep already running kept
  writing while shutdown closed the database under it. It now waits for the
  in-flight sweep, and a tick that fires while one is running is skipped.

### Removed

- Orphaned code with no importers: `shared/lib/api-response.ts` and
  `shared/lib/pagination.ts` (a response-envelope layer superseded by the
  `openapi.ts` helpers), `shared/middleware/totp.ts` (a `requireTotp`
  middleware never adopted — both TOTP routes check the step-up header
  inline), and the web `editor/toc.tsx` component.

### Security

- Transitive dependencies re-resolved within their existing ranges to clear
  30 OSV advisories (19 High) across 14 packages flagged by the CI
  `osv-scanner` step — among them `brace-expansion`, `browserslist`,
  `fast-uri`, `js-yaml`, `nanoid` (transitive 3.x/5.x), `postcss`, `qs`,
  `dompurify`, `ip-address`, `body-parser`. Lockfile only; no direct
  dependency ranges changed.

## v0.1.0 — 2026-05-14

First tagged template release. Subsequent forks should anchor their
`develop/forking.md` Part 2 (Tracking upstream) workflow against
`v0.1.0` or later.

### Added

- Bun monorepo skeleton (`apps/api`, `apps/web`, `packages/shared`,
  `packages/tsconfig`).
- Hono API with per-request DI (config / db / encryption / logger
  threaded through `c.var`).
- React 19 + TanStack Router web app with EN/ZH i18n and file-based
  routes.
- Shipped modules: `account/auth` (OAuth + TOTP), `account/users`,
  `policy` (Zanzibar tuples), `item` (base) + `file` / `document` /
  `issue` (sub-types), `cron`, `backup`, `audit`, `encryption`,
  `settings`, `system`.
- ECIES at-rest encryption with bootstrap-token, master-password
  derived keypair, and admin DEK challenge-response.
- Live e2e harness (dex + API + every module).
- Single-binary build via `scripts/compile.ts`.
- `scripts/rebrand.ts` rewrites manifests + `.env` defaults for forks.
- Doc-drift safeguards: `check:i18n` / `check:env-docs` /
  `check:api-docs`.
- `.github/workflows/ci.yml` + `release.yml`.

### Security

- Sentinel guards refuse production boot with example
  `OAUTH_CLIENT_SECRET=app-secret`, `OAUTH_CLIENT_ID=app`,
  `DEFAULT_ADMIN=admin@example.com`.
- `SERVICE_TOKEN` split into `SERVICE_TOKEN_METRICS` /
  `SERVICE_TOKEN_BACKUP` (independently rotatable).
- CSRF middleware (XHR header + Origin/Referer match), `__Secure-`-
  prefixed session cookies, PKCE + state binding for OAuth.

### Known issues

Tracked separately (lockout persistence, cookie scope vs `BASE_PATH`,
DNS-rebinding guard on the `http-request` cron action, …).
