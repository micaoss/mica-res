# Resource Module

The resource service of Mica OS: SQLite owns what is published, R2 holds the
bytes, public bytes are downloaded from R2 directly, and a stateless edge
Worker answers everything that needs logic without waking the Durable Object.
Design and phases: `docs/plan/20260917-0852-public-resource-framework.md`.

## Hosts

| Host | Served by | What |
|---|---|---|
| `dl.res.micaos.dev` | R2 custom domain of `res-micaos-dev` | Public bytes, key = path. Range, ETag, conditional GET and CDN caching are R2's. |
| `res.micaos.dev` | Worker (edge plane) | Home page (`apps/site`), listings, aliases, legacy redirects, `/v2` registry, protected downloads, `/admin` (SPA + API). |
| `s3.res.micaos.dev` | Worker (edge plane) | S3 read API, path-style, bucket = namespace. |
| (none) | `protect-res-micaos-dev` | Protected bytes, staging uploads, access snapshot. Reached only through presigned URLs. |

## Directory layout

`<namespace>/<path>` is the object key, the download path and the S3
`bucket/key`. Rules live in `paths.ts`:

- namespace: S3 bucket name `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`, no `--`, not
  reserved (`admin`, `v2`, `blob`, `d`, `index`, `w`, `_site`, `_catalog`,
  `_access`, `_staging`, `.well-known`);
- path: segments `^[A-Za-z0-9][A-Za-z0-9._+~@=-]*$`, no empty or relative
  segment, at most 16 segments, key at most 1024 bytes, first directory
  lowercase.

| Namespace | Shape | Immutable | Cache |
|---|---|---|---|
| `mica` | `mica/<scope>/<stamp>/<file>` | yes | immutable |
| `upstream` | `upstream/debian/pool/<tail>`, `upstream/source/<name>/<file>`, `upstream/git/<name>/<commit>.{json,pack.NN}` | yes | immutable |
| `oci` | `oci/blobs/sha256/<hex>` | yes | immutable |
| `docs` | `docs/<product>/<version>/...` (site mode) | yes | standard |
| `brand` | `brand/<group>/<file>` | no | standard |
| `status` | `status/current.json`, `status/runs/<repo>/<run>.json` | no | short |

These six are seeded on first boot; further namespaces (including protected
ones, in the `protect` store) are created in the admin UI.

## File layout

```text
apps/api/src/modules/resource/
  schema.ts            res_* tables
  paths.ts             layout rules
  cache-policy.ts      policy -> cache-control
  catalog.ts           snapshot documents, shard lookup and S3-style listing
  resource.service.ts  namespaces, publish, uploads/pull, aliases, redirects, OCI tags, deletion, purge queue
  publisher.ts         build and write catalog snapshots; site text
  purge.ts             Cloudflare cache purge queue
  jobs.ts              background sweep (deletions, stale metadata, purges, uploads, snapshots)
  import-v1.ts         one-off import of the v1 mirror
  access/keys.ts       access keys: sealing, grants, signed URLs, access snapshot
  resource.policy.ts   res_namespace policy namespace and route bindings
  resource.routes.ts   /api/res/*
  storage/             SigV4, S3 client, R2 and memory stores, registry
apps/api/src/edge/     catalog reader, res host, S3 host, access checks, listing HTML
apps/site/             home page SPA
apps/web/src/app/routes/_app/admin/resources*   admin UI
```

## Database

| Table | Purpose |
|---|---|
| `res_stores` | One row per bucket: binding, bucket, visibility, download base URL. |
| `res_namespaces` | Title, description, store, `listable`, `immutable`, `site_mode`, cache policy, example paths. |
| `res_objects` | One row per key: sha256, size, etag, content type, optional cache policy, `meta` JSON, publish and delete state. Unique per key while not purged. |
| `res_aliases` | Mutable pointers inside a namespace (`latest`). |
| `res_redirects` | v1 `/d/...` names that now point at a key. |
| `res_oci_tags` | Registry tags -> manifest digests. |
| `res_uploads` | Staged uploads awaiting a publish. |
| `res_snapshots` | Catalog versions written, for pruning. |
| `res_purges` | CDN purge queue. |
| `res_access_keys` | Protected-namespace keys: hashed and sealed secret, grants, expiry, revocation. |

## Publishing

All publishing is under `/api/res/namespaces/:name/*` and is gated by the
`res-namespace` policy resource: admins always, anyone else with a
`res_namespace:<name>#publisher` (or `#manager`) tuple. API tokens with the
`res:publish` scope reach the publishing routes and nothing that deletes.

1. Stage the bytes, either
   - `POST /uploads { sha256, size, contentType }` -> a presigned PUT to
     `_staging/<id>` in the protected bucket, with the checksum signed so R2
     refuses other bytes; or
   - `POST /uploads/pull { origin, sha256, contentType }` -> the control
     plane streams an https origin into staging (redirects followed by hand,
     https only, nothing echoed).
2. `PUT /objects { path, source: { uploadId } | { sha256 }, contentType?, cachePolicy?, meta? }`
   or `POST /batch { objects, aliases }` copies staging (or an object already
   holding those bytes) to the key inside R2, records it and publishes a new
   catalog snapshot. Publishing the same bytes again is a no-op; other bytes
   under an immutable key answer 409 `IMMUTABLE`; a replace in a mutable
   namespace queues a CDN purge.
3. Aliases: `PUT /aliases { path, target }`. Registry tags:
   `PUT /namespaces/oci/oci-tags { repository, tag, digest }`.

Objects above 5 GiB are out of scope (single presigned PUT).

## Catalog snapshots

After every committed change the control plane writes
`_catalog/<version>/manifest.json`, `ns/<name>.json` (in the namespace's own
bucket), `digests.json` and `redirects.json`, then the pointer
`_catalog/current.json`. The edge re-reads the pointer at most every 30 s and
memoises everything it points at. A failed publish marks the catalog dirty
and the background job retries. The ten newest snapshots are kept.

## Cache and deletion

- The cache policy (`immutable`, `standard`, `short`, `no-store`) is written
  onto each object as `cache-control`. Changing a namespace's policy marks
  its objects stale; the job rewrites them in place and purges their URLs.
- Delete (`POST /objects/delete { path | prefix, reason, dryRun? }`) is
  admin-only, needs a TOTP step-up (`x-totp-token`) when the admin has TOTP,
  and is audited. The object leaves the catalog at once; its bytes stay until
  `RES_DELETE_GRACE_SECONDS` (7 days) and can be restored until then.
  `POST /objects/purge` shortens the grace to one minute.
- The job deletes due bytes, then purges their download URLs through the
  Cloudflare API (`CF_ZONE_ID`, `CF_PURGE_TOKEN`); without those, purges are
  marked `skipped` and shown in the admin UI.

## Edge plane

`apps/api/src/workers/entry.ts` calls `handleEdge` before forwarding to the
Durable Object; only `/admin/api/*` is forwarded.

res host:

| Request | Answer |
|---|---|
| `/`, `/_site/*` | home page assets |
| `/admin/*` | admin SPA assets (SPA fallback) |
| `/.well-known/res.json` | site text, namespaces, counts, examples, snapshot |
| `/<ns>/<path>` public | 302 to the download host |
| `/<ns>/<dir>/` | listing (HTML, or JSON with `Accept: application/json` or `?format=json`); `index.html` in site mode |
| `/<ns>/<alias>` | 302 to the target |
| `/<ns>/<path>` protected | bearer `rk_<id>_<secret>` or `X-Res-*` signed URL -> 302 to a 5-minute presigned R2 URL |
| `/blob/<aa>/<sha256>` | 302 to the key holding that digest |
| `/d/<v1 name>` | 302 to its key |
| `/index/<file>` | 302 to the frozen v1 index on the download host |
| `/v2/<repo>/manifests/<tag or digest>` | served from R2 (small JSON) |
| `/v2/<repo>/blobs/sha256:<hex>` | 307 to the download host |

S3 host: ListBuckets, GetBucketLocation, ListObjectsV2/V1 (prefix,
delimiter, pagination, `encoding-type=url`), HeadObject from the catalog,
GetObject as a 307, every write `AccessDenied`. Protected namespaces need a
SigV4 signature from an access key; unsigned requests are anonymous.

### S3 client compatibility (measured 2026-09-17 against workerd)

| Client | List | Head | Download through the S3 host | Signed (protected) |
|---|---|---|---|---|
| rclone 1.75.1 | yes | yes | yes (follows the 307) | yes |
| aws-cli v2 | yes | yes | **no**: botocore does not follow a 307 for GetObject | yes (list, head, presign) |

For aws-cli, download with the download host as the endpoint -- the path is
the same `bucket/key`, so this works unchanged:

```bash
aws s3 ls  --no-sign-request --endpoint-url https://s3.res.micaos.dev s3://mica/uefi-x64/
aws s3 cp  --no-sign-request --endpoint-url https://dl.res.micaos.dev s3://mica/uefi-x64/<stamp>/<file> .
```

Proxying GetObject bytes through the Worker would make aws-cli work on one
endpoint but break the "public bytes never pass a Worker" requirement; it is
deliberately not done.

Two Cloudflare-specific details the edge handles: the platform rewrites
`Accept-Encoding` before a Worker sees it, and aws-sdk-go-v2 (rclone) signs
that header, so verification tries the common original values; and `wrangler
dev` rewrites `Host` and `Origin` to the first route, which is why local S3
checks need `--local-upstream` set to the host the client uses.

## With and without R2 S3 credentials

The bucket bindings cover reads, writes, deletes and listings. Two things a
binding cannot do are done through R2's S3 API when `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are configured, and have a
binding-only fallback when they are not.

| | With S3 credentials | Without |
|---|---|---|
| Copy (publish, metadata rewrite, v1 import) | `CopyObject`, server-side | Streamed binding-to-binding inside Cloudflare, sha256 still enforced by R2. No egress either way. |
| Upload of bytes the client holds | Presigned PUT straight to R2, up to 5 GiB | `PUT /api/res/uploads/:id/content` through this service, bounded by the platform's request-body limit (about 95 MiB). Objects with an origin URL are unaffected: they are pulled server-side. |
| Protected download | 302 to a 5-minute presigned R2 URL | Streamed by the Worker. Public objects are never affected -- they are always a redirect to the download host. |

Public bytes never pass through a Worker in either mode.

## Protected namespaces and access keys

- Create a namespace in the `protect` store, then an access key with grants
  (`namespace` + directory prefix). The secret is shown once.
- Bearer: `Authorization: Bearer rk_<id>_<secret>`. S3: access key id = key
  id, secret = secret. Signed URL: `POST /api/res/access-keys/:id/sign`.
- Keys are hashed and sealed (`RES_KEY_KEK`, AES-GCM) in SQLite and published
  to `_access/current.json` in the protected bucket; revocation reaches the
  edge within 30 s, plus the lifetime of any presigned URL already issued.

## Operations

### One-time setup

1. Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers, R2, zone DNS and R2
   custom domains), `CLOUDFLARE_ACCOUNT_ID`, `OAUTH_CLIENT_SECRET`,
   `RES_KEY_KEK` (`openssl rand -base64 32`), `MICA_RES_TOKEN`,
   `MICA_RES_STATUS_TOKEN`. Optional: `R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY` (see below) and `CF_PURGE_TOKEN` (zone Cache
   Purge; without it purges are marked skipped).
2. Repository variables: `OAUTH_ISSUER`, `OAUTH_CLIENT_ID`, `DEFAULT_ADMIN`,
   `CF_ZONE_ID`. Register `https://res.micaos.dev/admin/api/account/auth/callback`
   with the OIDC provider.
3. Run `infra.yml`: buckets, CORS, `dl.res.micaos.dev`, build, deploy.
4. On the `micaos.dev` zone, add a Cache Rule for hostname
   `dl.res.micaos.dev`: eligible for cache, edge TTL "use cache-control
   header". Without it the CDN caches only static-looking extensions.
5. Sign in at `/admin/`, import the v1 mirror (Resources -> Site & import),
   then check `/.well-known/res.json` and a few `/d/...` and `/blob/...`
   URLs.
6. After the import has been verified for a week, remove the v1 leftovers
   the service does not manage -- `blob/`, `site/` in `res-micaos-dev` --
   with rclone against R2's S3 endpoint. `index/` stays: `/index/` redirects
   to it.
7. Create the CI user's API tokens: a user with `res_namespace:*#publisher`
   tuples for `mica`, `upstream`, `oci` (`res:publish` scope) as
   `MICA_RES_TOKEN`, and one for `status` only as `MICA_RES_STATUS_TOKEN`.
   An admin's token works too but can do more than CI needs.

### Environment

See `docs/reference/env-reference.md`, section `RES_*`, `R2_*`, `CF_*`.

## End-to-end coverage

- Unit: `apps/api/src/modules/resource/*.test.ts` (paths, SigV4 against the
  AWS examples, catalog, service against memory buckets, routes and policy),
  `apps/api/src/edge/edge.test.ts` (every edge route, protected access,
  SigV4 including the rewritten header).
- `tests/e2e/modules/resource/` (Bun, OIDC): namespaces, catalog publish,
  uploads, the 403 matrix.
- `tests/workers/smoke.ts` (workerd): catalog published by the Durable
  Object and served by the edge without it.

## Out of scope

Objects above 5 GiB, virtual-host-style S3, S3 writes, retention policies
beyond manual deletion.
