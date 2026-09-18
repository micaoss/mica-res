# 20260917-0852-public-resource-framework Public resource publishing framework

- **status**: implementing
- **createdAt**: 2026-09-17 08:52
- **approvedAt**: 2026-09-17 10:20
- **relatedTask**: 20260917-0852-public-resource-framework

## Context

### Current mica-res

- A single Worker (`worker/src/index.ts` 272 lines, `routes.ts` 164 lines)
  over one private R2 bucket `res-micaos-dev`, with no database. The
  catalogue is an immutable JSON snapshot (`index/<stamp>.json`, 278 KB)
  plus a pointer; a cold isolate reads the whole snapshot to resolve one name.
- The resource model is Mica-shaped: six hard-coded `Kind`s, `pins` into Mica
  locks, free-form readable names under `/d/`. No directories, no per-name
  size or publish time, no prefix listing.
- **Every byte is proxied by the Worker**: the bucket is private and the
  readable names exist only in the index, so there is no physical key a
  client could fetch from R2 directly.
- Writes are bearer-gated routes (`/w/blob`, `/w/pull`, `/w/index`,
  `/w/site`, `/w/status`, `/w/list`), and by design **nothing can be
  deleted**.
- The bucket holds 536 objects (8219.2 MiB) under `blob/<aa>/<sha256>`.

URLs other repositories already depend on, which must keep resolving to the
same bytes:

| URL shape | Consumer |
|---|---|
| `/blob/<aa>/<sha256>` | `mica-boards:common/scripts/mirror.sh` (`curl -fsSL`) |
| `/d/mica/<scope>/<stamp>/<file>` | `mica-build:mirrors.list`, `tests/release-test.sh`, `mica:docs/design/mica-index.md` |
| `/d/upstream/debian/pool/<tail>` | `MICA_BASE_MIRROR=pool:` in mica-system-base |
| `/d/upstream/{deb,source,git}/...` | mica-boards git packs |
| `/v2/<repo>/{manifests,blobs}/...` | docker pulls of the build-env images |
| `/index/...`, `/status/...`, `/w/...` | this repository's sync, audit and collector |

### Requirements (user, 2026-09-17)

1. SQLite as the source of truth: custom resources and documents that need
   cache acceleration will be published later.
2. A normative directory layout. Everything is public today; some resources
   will later require a protection key to read.
3. A public S3 endpoint `s3.res.micaos.dev`. Protected resources live in a
   second R2 bucket, e.g. `protect-res-micaos-dev`; the code must support
   several buckets.
4. Cache is not immutable: the database must manage and delete resources.
5. Rebuild on `/srv/zzci/bun-tpl`, adding modules on top of it.
6. A frontend route `/` describing the site and showing resource paths.
7. **Public resources are downloaded from R2 directly, never proxied by a
   Worker.**

### bun-tpl, as read on 2026-09-17

- Bun monorepo: `apps/api` (Hono, Drizzle, SQLite, OpenAPI via
  `describeRoute`), `apps/web` (React 19, TanStack Router, i18n), module
  playbook with aggregate-file rule, upstream-merge pipeline
  (`docs/develop/forking.md` Part 2).
- Two runtimes behind a platform seam: Bun (libsql file) and **Cloudflare
  Workers**, where the stateless Worker forwards **every** request to one
  Durable Object named `app` that owns the SQLite database
  (`apps/api/src/workers/entry.ts`). DO was chosen over D1 for interactive
  transactions (`docs/develop/runtime.md`).
- Reusable modules: `account` (OIDC login, TOTP, **personal API tokens with
  module-registered scopes**), `audit`, `backup`, `policy`, `settings`,
  `system`. The `file` module is content-addressed (`storage_key` derived
  from sha256, whole-buffer `put`), which does not fit physical readable keys
  (below), so it is not used.

### What requirement 7 decides

A client can only fetch from R2 without a Worker through a **public bucket
bound to a custom domain**, and then the URL path *is* the object key. So:

- Every public entry becomes a **physical object under its readable key**
  (`mica/uefi-x64/20260916-0845/x.img.gz`), not a name resolved through an
  index. Content addressing moves from the key to metadata (`sha256` custom
  metadata plus the database).
- A Worker may still *answer* a request that needs logic -- a listing, an
  alias, a legacy URL, an authorisation -- but it answers with a redirect or
  a small document, never with the bytes of a public object.
- Range, conditional GET, ETag, `content-type`, `cache-control` and edge
  caching come from R2 and Cloudflare's CDN natively.

## Proposal

### 1. Hosts and planes

```text
dl.res.micaos.dev     R2 custom domain -> bucket res-micaos-dev (public bytes, no Worker)
res.micaos.dev        Worker: home page, listings, aliases, legacy redirects, /v2, /admin
s3.res.micaos.dev     Worker: S3 read API (list/head in the Worker, GetObject redirected)
(no public domain)    bucket protect-res-micaos-dev: reachable only by presigned URLs
```

```text
 client ──GET dl.res.micaos.dev/<ns>/<path>──────────────────────────> R2 (CDN cached)
 client ──GET res.micaos.dev/<ns>/<dir>/ ──> Worker (snapshot) ──> HTML/JSON listing
 client ──GET res.micaos.dev/d/... | /blob/.. | alias ──> Worker ──302──> dl.res.micaos.dev
 client ──GET res.micaos.dev/<protected>/... + key ──> Worker ──302 presigned──> R2 S3 endpoint
 admin/CI ──> res.micaos.dev/admin/api ──> Durable Object `app` (SQLite)
                                              ├─ presigned PUT for uploads (R2 S3 API)
                                              ├─ copy/delete objects, set metadata
                                              ├─ purge CDN URLs (Cloudflare API)
                                              └─ publish catalog snapshots
```

- **Control plane**: the bun-tpl app in the DO under `BASE_PATH=/admin`
  (admin SPA `/admin/`, API `/admin/api/*`, raw API `/admin/api/raw/*`). It
  owns every mutation and is the only holder of R2 S3 credentials
  (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, scoped to the res buckets) and
  of a zone cache-purge token (`CF_PURGE_TOKEN`).
- **Edge Worker**: stateless, in `entry.ts` before the DO forward. It reads
  **catalog snapshots** published by the control plane (memoised per isolate,
  Cache API, 30 s pointer TTL) and never queries SQLite on a read.
- Whether `dl.` can be merged into `res.micaos.dev` itself (R2 custom domain
  with Worker routes overlaid) is checked in F0; see Alternatives.

### 2. Storage model (SQLite, Drizzle, module `resource`)

```text
res_stores        name PK, bucket, binding, visibility(public|protected), public_base_url?, created_at
res_namespaces    name PK, store, title, description, visibility, listable, immutable,
                  site_mode, cache_policy, examples JSON, created_at, deleted_at
res_objects       id PK, store, key, sha256, size, etag, content_type, cache_control,
                  meta JSON, published_at, published_by,
                  deleted_at, delete_reason, purge_after, purged_at
                  UNIQUE(store, key) WHERE purged_at IS NULL
res_aliases       namespace, path, target_path, updated_at          (latest, stable)
res_oci_tags      repository, tag, digest, updated_at
res_uploads       id PK, store, staging_key, sha256, size, state, expires_at, created_by
res_access_keys   id, name, secret_hash, secret_sealed, grants JSON [{namespace, prefix}],
                  expires_at, revoked_at, last_used_at, created_by
res_snapshots     version, store, namespace, key, sha256, objects, bytes, published_at
res_purges        id, urls JSON, state, attempts, last_error, created_at
```

- **Store** = one R2 bucket binding (`RES_PUBLIC`, `RES_PROTECT`, ...). A
  public store has a `public_base_url` (`https://dl.res.micaos.dev`); a
  protected store has none, so its bytes have no anonymous URL at all. Adding
  a bucket is a binding plus a row.
- **Object key = `<namespace>/<path>`**. The same bytes under two names are
  two objects (server-side copy, no re-upload). At today's size this costs
  cents per month and keeps delete and cache purge per key trivial.
- Every stored object carries R2 metadata set at write time:
  `content-type`, `cache-control` (from policy), custom `sha256`.

### 3. Directory layout (normative)

```text
<namespace>/<path>            = object key = dl URL path = S3 bucket/key
```

Reserved first segments (never a namespace): `admin`, `v2`, `blob`, `d`,
`index`, `w`, `_site`, `_catalog`, `_staging`, `.well-known`. A namespace
name is an S3-valid bucket name `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`.

Path rules: segments match `^[A-Za-z0-9][A-Za-z0-9._+~@=-]*$`, no empty
segment, no `.`/`..`, at most 16 segments, key at most 1024 bytes UTF-8; the
first segment below a namespace is lowercase.

| Namespace | Store | Shape | Mutability |
|---|---|---|---|
| `mica` | public | `mica/<scope>/<stamp>/<file>` | immutable |
| `upstream` | public | `upstream/debian/pool/<tail>`, `upstream/source/<name>/<file>`, `upstream/git/<name>/<commit>.{json,pack.NN}` | immutable |
| `oci` | public | `oci/blobs/sha256/<hex>` (manifests, configs, layers); tags in `res_oci_tags` | immutable |
| `docs` | public | `docs/<product>/<version>/...`, alias `docs/<product>/latest` | versions immutable |
| `brand` | public | `brand/<group>/<file>` | mutable |
| `status` | public | `status/current.json`, `status/runs/<repo>/<run>.json`, `status/daily/<date>.json` | runs immutable |
| `protect` (example) | protected | `protect/<project>/...` | per namespace |

- **Immutable** namespace: a key, once published, never gets other bytes;
  delete is admin-only, with a reason, audited.
- **Alias**: `res.micaos.dev/<ns>/<path>` answered `302` to the versioned dl
  URL with `cache-control: public, max-age=60`.
- **site_mode** (`docs`): the site is served from dl as static files; since a
  bare R2 domain has no directory index, links always name `index.html`, and
  `res.micaos.dev/docs/<product>/<version>/` redirects to it.

### 4. Read surfaces

**dl.res.micaos.dev** -- R2 public custom domain, no code. Native Range,
If-None-Match/If-Modified-Since, ETag, `content-length`, `last-modified`.
Cloudflare Cache Rules: respect origin `cache-control`, cache everything on
this host, CORS response header rule `access-control-allow-origin: *`.
`_catalog/*` is public (the catalogue was public before); `_staging` never
exists in a public bucket (section 6).

**res.micaos.dev** -- Worker, no public bytes:

```text
GET  /                                 home page (apps/site)
GET  /.well-known/res.json             site + namespace summary from the snapshot
GET  /<ns>/ , /<ns>/<dir>/             listing: HTML for browsers, JSON on Accept: application/json
GET  /<ns>/<path>                      302 -> dl (object, alias target, or docs index.html)
GET  /d/<old readable name>            302 -> dl canonical key (v1 names mapped at import)
GET  /blob/<aa>/<sha256>               302 -> dl key of that sha256 (public stores only)
GET  /v2/                              registry ping
GET  /v2/<repo>/manifests/<tag|digest> served by the Worker (small JSON; clients do not
                                       reliably follow redirects for manifests)
GET  /v2/<repo>/blobs/sha256:<hex>     307 -> dl oci/blobs/sha256/<hex> (the distribution spec
                                       allows blob redirects; docker/containerd follow them)
GET  /<protected ns>/<path>            authorise, then 302 -> presigned R2 GET (TTL 5 min)
GET  /index/..., /status/...           legacy: 302 -> dl equivalents until the sync moves
```

**s3.res.micaos.dev** -- path-style, bucket = namespace:

| Operation | Public namespace | Protected namespace |
|---|---|---|
| ListBuckets | anonymous: public namespaces | SigV4: granted namespaces |
| GetBucketLocation | `auto` | SigV4 |
| ListObjectsV2 / ListObjects | anonymous, from snapshot | SigV4 |
| HeadObject | anonymous, from snapshot | SigV4 |
| GetObject | `307` -> dl URL | SigV4, `307` -> presigned R2 URL |
| Any write, multipart, ACL, delete | `AccessDenied` | `AccessDenied` |

Whether each target client (`aws s3 cp`, `rclone`, `s5cmd`, `mc`) follows
the GetObject redirect is the F4 gate. A client that does not is answered by
documenting the dl URL (and, for rclone, its `http` backend on dl) -- **not**
by proxying bytes.

**Protected reads**

- HTTP: `Authorization: Bearer rk_<id>_<secret>`, or a res-signed URL
  `?X-Res-Key=<id>&X-Res-Expires=<unix>&X-Res-Signature=<hmac>` minted by the
  control plane; either one is exchanged by the Worker for a 5-minute R2
  presigned GET. Bytes flow from R2's S3 endpoint, not the Worker.
- S3: SigV4 with access key id = `res_access_keys.id`; the secret is stored
  sealed with Worker secret `RES_KEY_KEK` (AES-GCM) next to a hash for the
  bearer form.
- The Worker reads a sealed access snapshot from the protected bucket (never a
  public one), 30 s TTL, so revocation takes effect within 30 s plus the
  presigned URL's 5 minutes.

### 4a. Public home page `/`

- **App**: `apps/site`, a second Vite SPA beside the admin `apps/web`, same
  stack (React, TanStack Router, shadcn base-nova, Tailwind, en/zh). No login,
  no control-plane call.
- **Serving**: both SPAs build into one Workers asset directory; `apps/site`
  at the root with bundles under `/_site/`, `apps/web` under `/admin/`.
- **Data**: `GET /.well-known/res.json` from the snapshot manifest:

  ```json
  {
    "site": { "title": "...", "description": "...",
              "download": "https://dl.res.micaos.dev", "s3": "https://s3.res.micaos.dev" },
    "namespaces": [
      { "name": "mica", "title": "...", "description": "...", "visibility": "public",
        "objects": 12, "bytes": 1017000000,
        "examples": ["mica/uefi-x64/20260916-0845/", "mica/cx3576/20260916-0847/"] }
    ],
    "snapshot": { "version": "...", "publishedAt": "..." }
  }
  ```

  Title and description are `settings` rows; `examples` is
  `res_namespaces.examples`; both edited in the admin SPA. Protected
  namespaces show name and description only.
- **Content**: site description; one card per namespace (title, description,
  visibility, count, size, example paths linking to the listing); copyable
  snippets: `curl -LO https://dl.res.micaos.dev/<ns>/<path>`,
  `aws s3 ls --endpoint-url https://s3.res.micaos.dev --no-sign-request s3://<ns>/`,
  `docker pull res.micaos.dev/micaoss/mica-build-env:<tag>`, the mirror
  variables (`MICA_MIRROR`, `MICA_BASE_MIRROR=pool:...`); the trust note
  (verify against your own sha256 pin); snapshot version and publish time.
- Replaces the CLI-rendered `site/index.html` and `site/upstream.html`.

### 5. Cache and deletion

Cache policy is data: `res_namespaces.cache_policy`, overridable per object,
written into the object's `cache-control` metadata so R2 and the CDN honour it.

| Policy | `cache-control` on the object |
|---|---|
| `immutable` | `public, max-age=31536000, immutable` |
| `standard` (default) | `public, max-age=300, s-maxage=86400` |
| `short` | `public, max-age=60, must-revalidate` |
| `no-store` | `no-store` |

Because the CDN caches dl responses, **every change to an existing key is
followed by a purge** of its dl URL through the Cloudflare API, recorded in
`res_purges` and retried until it succeeds:

- **Replace** (mutable namespace): upload to staging, copy over the key,
  purge.
- **Policy change**: S3 `CopyObject` of the key onto itself with
  `MetadataDirective: REPLACE`, purge.
- **Delete** (admin session with TOTP step-up, audited; by object or by
  prefix with a dry-run count):
  1. `deleted_at` set, snapshot republished -- the object disappears from
     listings, S3 and the home page within 30 s;
  2. after `purge_after = now + RES_DELETE_GRACE` (default 7 days) the control
     plane deletes the R2 object, purges its URL, sets `purged_at`;
  3. `purge now` sets the grace to zero; a soft-deleted object can be restored
     until then.
- CI tokens can publish and alias but **cannot delete** or change policy.
- Consumers pin by sha256 and fall back upstream, so a removed object costs a
  consumer a slower fetch, never wrong bytes.

### 6. Publishing (raw API, personal API tokens)

Scopes registered by the module: `res:publish`, `res:alias`, `res:status`,
`res:read-protected`. Upload bytes go **to R2 directly** as well:

```text
POST /admin/api/raw/res/uploads                 { store, sha256, size } ->
                                                { id, url: presigned PUT, headers } (R2 verifies
                                                x-amz-checksum-sha256; single PUT <= 5 GiB)
POST /admin/api/raw/res/uploads/:id/pull        { origin }: the Worker streams origin -> staging
                                                with R2's sha256 check (no echo, https only)
PUT  /admin/api/raw/res/objects/:ns/*path       { upload | sha256 of an existing object, contentType?,
                                                meta?, cachePolicy? } -> server-side copy to key
PUT  /admin/api/raw/res/aliases/:ns/*path       { target }
PUT  /admin/api/raw/res/oci/:repo/tags/:tag     { digest }
POST /admin/api/raw/res/batch                   many objects in one transaction, one snapshot
```

- Staging keys live in the **protected** bucket (`_staging/<id>`), which has no
  public domain, so an unverified byte is never publicly readable; the final
  `CopyObject` crosses buckets inside R2.
- Objects above 5 GiB (multipart with composite checksums) are out of scope.
- Admin API under `/admin/api/res/*`: stores, namespaces, objects, aliases,
  access keys, cache policy, deletion, purge queue.

### 7. Repository and migration

- mica-res keeps its history and adds bun-tpl as the `template` remote
  (`forking.md` Part 2); rebranded `APP_NAME=mica-res`.
- Template modules kept: `account`, `audit`, `backup`, `policy`, `settings`,
  `system`. Dropped: `item`, `document`, `issue`, `cron`, and `file` (only
  item/document used it, and its content-addressed keys do not fit).
- New: `apps/api/src/modules/resource/`, `apps/api/src/modules/access/`,
  `apps/api/src/edge/` (listings, redirects, registry, S3, catalog reader),
  `apps/api/src/lib/r2-s3.ts` (SigV4 presign, CopyObject, DeleteObject),
  `apps/api/src/lib/cf-purge.ts`, `apps/site/`, admin pages under
  `apps/web/src/app/routes/_app/resources/`.
- Mica producers (`src/*.ts`) move to `packages/mica-sync/` and publish
  through the raw API.
- **Data migration** (control plane job, resumable, server-side only): for
  each of the 536 v1 objects, `CopyObject blob/<aa>/<sha> -> <canonical key>`
  in `res-micaos-dev`, insert `res_objects`, map every v1 readable name to its
  canonical key for the `/d/` redirect table. OCI objects go to
  `oci/blobs/sha256/<hex>`. The old `blob/` keys stay until F2 has run a week,
  then are deleted through the normal grace path.
- Cross-repository follow-up (through the coordinator, not in this plan): move
  `mica-build:mirrors.list` to `https://dl.res.micaos.dev` with `/mica/...`
  paths so release downloads skip the redirect hop.

### Phases

| Phase | Deliverable | Gate |
|---|---|---|
| F0 | bun-tpl merged, rebranded, modules dropped, CLI under `packages/mica-sync`; spike: R2 custom domain `dl.res.micaos.dev`, CORS + cache rules, redirect behaviour of docker/aws/rclone | `bun run check` green; spike findings recorded |
| F1 | `resource` module: schema, stores/namespaces/objects/aliases, R2 S3 client, uploads (presigned + pull), snapshots, purge queue, deletion + grace, v1 migration | unit + e2e; 536/536 copied with matching sha256 metadata |
| F2 | edge Worker: listings, redirects (`/d`, `/blob`, aliases), `/v2`, `apps/site` + `/.well-known/res.json`; cutover | contract test: every Context URL resolves to the same sha256 via redirect; `docker pull` gate; no public GET returns bytes from the Worker |
| F3 | `protect-res-micaos-dev`, `access` module, bearer + res-signed URLs -> presigned R2 | refused without key, allowed with, revoked within 30 s |
| F4 | `s3.res.micaos.dev`: list/head, GetObject redirect, SigV4 for protected | `aws s3 ls/cp`, `rclone copy` in CI, sha256 compared |
| F5 | admin SPA pages, docs `site_mode`, policy/replace/purge UI | e2e |

## Risks

- **Stale CDN copies after replace or delete**: purge is queued, retried and
  visible in the admin SPA; immutable namespaces never need a purge except on
  delete.
- **Two new secrets with real power** (`R2_*` can write and delete both
  buckets, `CF_PURGE_TOKEN`): held only by the Worker, never by CI; the R2 token
  is scoped to the res buckets. CI holds a personal API token that cannot
  delete.
- **Redirect support differs by client**: `curl` needs `-L` (mica-boards
  already uses it); manifests stay Worker-served; S3 GetObject redirects are
  verified per client in F4, with the dl URL as the documented fallback.
- **Public catalogue**: `_catalog/` on dl reveals public names and sizes,
  which listings show anyway; protected snapshots never go to a public bucket.
- **Presigned R2 URLs expose the account's R2 hostname** for protected
  downloads; accepted, since the URL is short-lived and object-scoped.
- **Duplicate bytes** for one sha256 under several names: bounded, cheap, and
  the price of per-key delete and purge.
- **Single Durable Object** bounds publish throughput; `batch` keeps a sync to
  one transaction and one snapshot. Reads never touch it.
- **Migration touches 8.2 GiB** server-side: resumable, idempotent (copy
  skipped when the key exists with the same `sha256` metadata), no egress.
- **Reachability** from the development network is unchanged
  (`docs/architecture.md`).

## Scope

Six phases, each its own commit series and changelog entry. F0-F2 replace the
current Worker without breaking a consumer; F3-F5 add capability. Estimated
3000-4000 lines including tests.

## Alternatives

- **Worker proxies public bytes** (the previous revision): full HTTP control
  and dedupe by sha256, but every download is a Worker invocation and the
  bytes stream through it. Rejected by requirement 7.
- **One hostname**: bind `res-micaos-dev` as the custom domain of
  `res.micaos.dev` and overlay Worker routes for `/`, `/admin/*`, `/v2/*`,
  `/.well-known/*`. Download URLs and page URLs would share a host, but Worker
  route patterns cannot match "a path ending in `/`", so directory listings
  and aliases would have no place. Checked in F0; adopted only if a working
  pattern exists.
- **Content-addressed keys on dl** (`dl/blob/<aa>/<sha>`): no duplicates, but
  names would be hashes, downloads lose their file names, and listings and S3
  keys would not match URLs. Rejected.
- **D1 with read replication** as a catalogue the Worker queries: no snapshots,
  but no interactive transactions (the reason bun-tpl chose DO) and a second
  database. Rejected.
- **One bucket with a `protected/` prefix**: a public custom domain would
  expose it. Rejected; the user asked for a separate bucket.

## Annotations

- 2026-09-17, user: SQLite, normative layout, protection keys,
  `s3.res.micaos.dev`, a separate protected bucket, deletable cache, rebuild
  on bun-tpl -- superseding the JSON-only first draft. Later the same day:
  public resources download from R2 directly, not through a Worker --
  superseding the Worker-proxied read plane of the second revision.

Decisions (user, 2026-09-17):

1. The control plane signs in with OIDC (bun-tpl `OAUTH_ISSUER` and client
   settings as Worker vars and secrets).
2. The template modules `item`, `document`, `issue` and `cron` are dropped.
3. 30 s publish and revocation visibility and a 7-day default deletion grace
   are accepted.
4. The control plane is served under `res.micaos.dev/admin` through
   bun-tpl's `BASE_PATH`, so `admin` is a reserved first segment.
5. A public frontend route at `/` shows the site description and resource
   paths (section 4a).
6. Public resources are downloaded from R2 directly (section 1).

Open questions:

1. Download host name: `dl.res.micaos.dev` as proposed?
2. S3 GetObject by redirect only (no byte proxy even for a client that cannot
   follow it) -- confirmed?
3. Protected downloads by redirect to a 5-minute presigned R2 URL (bytes also
   bypass the Worker) -- acceptable, or must protected bytes stay behind the
   Worker?

Approved by the user on 2026-09-17 ("start"). The three open questions were
not answered separately, so the proposed defaults apply: `dl.res.micaos.dev`,
S3 GetObject by redirect only, protected downloads by 5-minute presigned R2
URLs.

### F0 progress, 2026-09-17

- bun-tpl `38ef242` merged with `--allow-unrelated-histories` (not yet
  committed), `template` remote added, rebranded `mica-res`. The legacy CLI,
  Worker and ESLint config moved to `packages/mica-sync` (own gates, ignored
  by the root ESLint); `sync.yml`, `collect.yml`, `infra.yml` and the
  enumeration dry run in `ci.yml` point there.
- Dropped `item`, `document`, `issue`, `cron` (API, web pages, locales,
  editor components and their dependencies, e2e suites, docs, config keys);
  `0000_init` regenerated. **Deviation:** the `file` module is kept, not
  dropped as section 7 says -- removing it would rewrite template surface
  (backup restore reconciliation, upload limits, system routes, config,
  Workers entry) for no gain, and every such edit is a future merge conflict.
  The resource module still does not use it.
- `bun run check` passes in `oven/bun:1.4.2` (api 562, web 40, shared 13,
  mica-sync 89 tests). Two web tests were added (`errors`, `format`) because
  removing the tested editor/attachment code dropped the coverage floor.
- **Open finding:** the app no longer boots. `buildFullApp` refuses to start
  when no policy route binding is registered, and the removed content modules
  were the only ones declaring bindings. `tests/workers/smoke.ts` (now on
  groups instead of documents) therefore fails, and so would the `workers`
  workflow on push. Resolution planned as the first F1 slice: the `resource`
  module declares a namespace-scoped policy resource (publish/manage per
  namespace, grantable to groups), which restores the guard's meaning rather
  than weakening it.

### F1-F5 implementation, 2026-09-17

Delivered in code, with the gates that can run without Cloudflare credentials:

- **F1** `apps/api/src/modules/resource`: schema (10 `res_*` tables in the
  regenerated `0000_init`), layout rules, catalog snapshots, publishing
  (presigned PUT to staging, server-side pull, copy to key), aliases,
  redirects, OCI tags, soft delete with grace, stale-metadata rewrite, CDN
  purge queue, background jobs, v1 import, `res-namespace` policy resource,
  `res:publish` / `res:read` token scopes. The first slice fixed the F0 boot
  finding: the Durable Object boots again.
- **F2** `apps/api/src/edge` in front of the Durable Object: home page and
  admin assets, listings, aliases, `/blob`, `/d`, `/index` redirects, `/v2`;
  `apps/site` home page; `wrangler.toml` with both hosts and both buckets;
  `infra.yml` provisions buckets, CORS, `dl.res.micaos.dev` and deploys.
- **F3** protected namespaces: access keys (hashed + sealed), bearer and
  res-signed URLs, presigned R2 redirects, access snapshot.
- **F4** `s3.res.micaos.dev`: ListBuckets, GetBucketLocation, ListObjects
  V1/V2, HeadObject, GetObject as 307, SigV4 for protected namespaces.
- **F5** admin UI (`/admin/resources`: namespaces, objects with delete /
  restore / purge and TOTP step-up, access keys, purges, site text, v1 import).

Verified: `bun run check` in `oven/bun:1.4.2`; api 614, web 43, site 5,
shared 13, mica-sync 55 unit tests; e2e 68 pass / 1 template skip;
workerd smoke 7/7 including a catalog published by the Durable Object and
served by the edge; real clients against workerd with a seeded catalog:
rclone 1.75.1 lists, heads, downloads (following the 307) and signs;
aws-cli v2 lists, heads, signs and presigns.

Deviations and findings:

- **aws-cli does not follow a GetObject 307** (botocore only redirects
  across regions), so `aws s3 cp` through the S3 host fails. Downloads with
  aws-cli use the download host as the endpoint (same `bucket/key` path).
  Proxying the bytes would break requirement 7, so it is not done.
- **Cloudflare rewrites `Accept-Encoding`** before a Worker sees it, and
  aws-sdk-go-v2 (rclone) signs it; verification tries the common original
  values. Found with rclone, covered by a unit test.
- The publishing API is under `/api/res` (sessions and personal API tokens),
  not the raw API as section 6 says: the raw API has no token authentication.
- The `access` module is `resource/access/` inside the resource module.
- `apps/site` is one page, so it has no router and no shadcn: React,
  Tailwind and a small en/zh dictionary.
- `packages/mica-sync` publishes through the control plane; its Worker,
  `/w/*` client, v1 site pages and bucket-listing audit are removed. The new
  audit reads the edge listings and HEADs the download host.
- Multipart uploads (objects above 5 GiB) are not implemented.
- The template's `workers.yml` deploy job was removed: its `fresh` path
  deletes the Worker and empties every bucket named in `wrangler.toml`.

Not done, because it needs the Cloudflare account and repository secrets
(runbook in `docs/modules/resource.md`, Operations): run `infra.yml`, add
the Cache Rule for `dl.res.micaos.dev`, sign in and run the v1 import
(536/536), the `docker pull` gate and the aws/rclone gate against the real
hosts, and switch `sync.yml` / `collect.yml` to the new tokens. Until then
this plan stays `implementing`.

### Delivery, 2026-09-17

- Merged and pushed as `81f1d14`. On GitHub: `ci` green on ubuntu and macOS
  (lint, typecheck, tests, build, docs drift, security scans, CodeQL, docker,
  e2e) and `workers` (workerd smoke) green.
- `RES_KEY_KEK` generated and stored as a repository secret (value never
  printed).
- `infra.yml` run with `deploy=false`: `protect-res-micaos-dev` created, CORS
  on `res-micaos-dev`, `dl.res.micaos.dev` attached. The download host answers
  from R2 (`/index/current.json` 200).
- **Not deployed.** The live `res.micaos.dev` still runs the v1 Worker.
  Deploying now would put a Worker in front of an empty catalog that no admin
  can sign in to, and every `/d/` and `/blob/` URL consumers use would fail
  until the import runs. The cutover needs, from the user: the OIDC provider
  (`OAUTH_ISSUER`, `OAUTH_CLIENT_ID` variables, `OAUTH_CLIENT_SECRET` secret,
  `DEFAULT_ADMIN`), an R2 API token for the two buckets
  (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), optionally `CF_PURGE_TOKEN`
  and `CF_ZONE_ID`, and the go-ahead for the switch.

### R2 S3 credentials made optional, 2026-09-17

The user asked why the bindings are not enough. They are, for everything but
a server-side copy and a presigned URL, so both now have a binding-only
fallback and `R2_*` is optional:

- copy streams binding-to-binding inside Cloudflare, with R2 still enforcing
  the sha256 (covered by `storage/r2-store.test.ts` against a fake binding);
- an upload the store cannot presign is taken by
  `PUT /api/res/uploads/:id/content`, bounded by the platform's request-body
  limit (~95 MiB); objects with an origin are pulled server-side as before;
- a protected download the store cannot sign for is streamed by the Worker.
  Public bytes are still never proxied.

`infra.yml` now passes only the vars and secrets that have a value: an empty
one would be published as an empty string and refused by the config schema at
boot.

### Cutover, 2026-09-18

- OIDC: `login.gid.io/oidc` (Logto), public client with PKCE and no secret,
  `DEFAULT_ADMIN=a@roy.me`, set as repository variables (user).
- `infra.yml` deployed the new Worker to `res.micaos.dev`. Production smoke
  in OIDC mode 5/5 (health, raw API, SPA, OAuth mode, PKCE redirect to the
  issuer with the right callback). The first catalog is published.
- Two defects found by the first deploy and fixed before the catalog went
  live:
  - `infra.yml` wrote its warnings into the secrets list; the deploy was
    refused before anything changed.
  - The resource jobs never ran on Workers: an alarm wakes a fresh Durable
    Object instance, a module-level guard skipped registering on its
    scheduler, and the 20-second first-run delay pushed the task past the
    alarm that woke it. The template's `file-gc` sweep has the same guard.
- Open: `s3.res.micaos.dev` already has an externally managed DNS record, so
  Cloudflare refused the Worker custom domain (the deploy step reports a
  partial trigger update; everything else is live). The v1 import has not run
  yet, so `/d/` and `/blob/` answer 404 until it does -- consumers fall back
  upstream by design.

