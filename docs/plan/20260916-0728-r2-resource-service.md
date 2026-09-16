# 20260916-0728-r2-resource-service R2 resource service

- **status**: implementing
- **createdAt**: 2026-09-16 07:28
- **approvedAt**: 2026-09-16 07:28
- **relatedTask**: 20260916-0728-r2-resource-service-phase-0

## Context

Mica OS depends on live third-party hosts at build time. Measured in the
workspace on 2026-09-16:

- `mica-system-base:locks/upstream.lock`: 325 sha256-pinned `source` rows,
  Debian archives on `snapshot.debian.org` (105 MiB for both architectures,
  127 MiB counting superseded pins), including the two tarballs
  `source.busybox` (busybox.net) and `source.systemd`.
- `mica-build:locks/mica-system-base.lock`: 42 further `upstream` Debian rows,
  the closure later stages install. They resolve to 40 distinct digests and
  **all 40 are already among mica-system-base's 325**, so the closure adds pins
  rather than bytes. This is the first concrete case of one object carrying two
  pins, and the reason retention is computed from the pin list and never from a
  count: dropping either pin would leave the object reachable, and counting
  pins would double-count the bytes.
- `mica-boards:locks/upstream.lock`: six sha256-pinned toolchain archives,
  911 MB measured, on `developer.arm.com`, GitHub release assets and
  `raw.githubusercontent.com`; plus seven `git` rows cloned at build time.
  Its three `ubuntu-*` InRelease rows move to `mica-build-env` with the bsp
  image and are out of scope here.
- `mica-build-env:locks/upstream.lock` at `main`: 15 `source` rows. Twelve are
  the toolchain archives (bun, go, rust, rust-std, cargo-nextest, cargo-deny
  per architecture), 647.7 MiB measured; the other three are the Ubuntu
  snapshot's signed `InRelease` indexes (`ubuntu-noble` 250 KiB,
  `-security` and `-updates` 123 KiB each, about 0.5 MiB together), added with
  the bsp image and read only by mica-build-env's own release job when bsp is
  rebuilt, never by a consumer build (mica-build-env, 2026-09-16). The ~207 MB
  of Ubuntu packages bsp installs are not rows at all: apt resolves them while
  the image is built, and afterwards they exist only inside the published
  image.
- `mica-build:locks/upstream.lock`: one row, `wireless-regdb`.
- `mica-podman:locks/upstream.lock`: six `git` rows.
- The build-env images of release `20260915-0138`, read anonymously from
  ghcr: 74 layer references resolve to 32 distinct layers, 2396 MiB naive
  against 1227 MiB distinct, because c, go and rust are built FROM base.

Existing mirror hooks, so no producer needs a new mechanism:
`mica-system-base:src/cache.ts populate()` (`MICA_BASE_MIRROR`, fallback on
404, sha256 verified either way), `mica-boards:tools/upstream.sh`,
`mica-boards:tools/from.sh`, `mica-boards:common/scripts/fetch-source.sh`,
`mica-build:tools/oci.sh get()`, and the existing variables
`MICA_LOCKS_RELEASES`, `MICA_RELEASE_LIST`, `MICA_RELEASE_DOWNLOAD(S)`.

Hard constraint from mica-boards: a `source` row's URL is part of a
component's inputs hash (`tools/inputs.sh`), and
`mica-system-base:src/lock.ts debianRows()` refuses a Debian URL outside
`snapshot.debian.org`. The mirror is therefore selected **at fetch time** by
an environment variable and never by rewriting a lock.

## Proposal

Bucket keys, three prefixes only:

```text
blob/<sha256[0:2]>/<sha256>      every byte string, uploaded once
index/<YYYYMMDD-HHMM>.json       immutable snapshot
index/current.json               the one pointer, holding the snapshot sha256
site/...                         generated static pages
```

Readable paths are Worker routes resolved through the index, never duplicated
keys: `/d/upstream/deb/<name>/<version>/<file>.deb`,
`/d/upstream/source/<name>/<version>/<file>`,
`/d/mica/<product>/<release>/<file>`, with `/blob/<aa>/<sha256>` as the
canonical form. The bucket stays private; the Worker is the only public
surface.

Writes are content-addressed: `PUT /w/blob/<sha256>` hashes the body and
refuses a key that is not the body's sha256 (400), refuses a different body
under an existing key (409), and is a no-op for an identical re-upload (200).
There is no delete route. A leaked write token can therefore add an
unreferenced blob and nothing else.

The index is `mica/resource-index/v1`, canonical JSON (UTF-8, fixed key
order, no insignificant whitespace, final LF), one entry per object with
`kind`, `sha256`, `size`, `origin`, `path` and `pins` (`repository`, `lock`,
`row`, `release`), so retention is computable from the index alone. Nothing in
a build reads the index to decide trust: verification stays the consumer's own
lock.

Phase 0 deliverables, this plan's scope:

1. `docs/` records, repository hygiene and the Bun toolchain, mirroring
   `mica-system-base`'s pins (bun 1.4.2, eslint 10.10.0, typescript 7.0.2,
   typescript-eslint 8.70.0, `@stylistic/eslint-plugin` 5.10.0), all verified
   as latest at npm on 2026-09-16.
2. `src/`: a lock reader for `mica-lock v1`, the producer enumeration, the
   canonical index writer, the readable-path mapping, and the sync with
   `--dry-run` as its default.
3. `worker/`: the routes, the write endpoint and the cache policy, deployed
   with wrangler 4.132.0. `WRITE_TOKEN` is bound to the Worker by the deploy
   step from this repository's secret, so the bearer the endpoint checks is
   provably the one the repository holds and nobody runs `wrangler secret put`
   by hand; until the secret exists the deploy step fails loudly rather than
   deploying a Worker with a blank bearer.
4. `.github/workflows/`: `ci.yml` (gates only, publishes nothing),
   `infra.yml` (`workflow_dispatch`: verify the token, create the bucket,
   deploy the Worker, upload the site skeleton) and `sync.yml` (dispatch plus
   a daily schedule, dry run in phase 0). The deployment copies `mica`'s
   website Worker: `cloudflare/wrangler-action@v4`, a pinned wrangler,
   `wrangler.jsonc`, the Worker secret bound at deploy time, and publishing
   kept manual.

Phase 1, delivered 2026-09-16: the uploader (`src/upload.ts`), the named write
routes, and the `state` member of an index entry.

- `ensureBlob` HEADs the mirror, fetches from the origin only what is missing,
  **verifies the sha256 before any upload**, and writes through
  `PUT /w/blob/<sha256>`, which hashes the body again and refuses a key that is
  not its digest -- so the after-check is the condition of storing, not a
  second opinion. A refusal is an error, never a skip.
- Named writes (`PUT /w/index/...`, `/w/site/...`, `/w/status/...`) carry the
  index snapshot, the pointer, the site pages and the status snapshots. Every
  write stores the body's sha256 as object metadata; an immutable key with
  different bytes is refused (409), an identical one is a no-op, and an
  existing object whose stored digest cannot be read is refused rather than
  clobbered. There is no delete route in any scope.
- Every write goes through a Worker, never an R2 token (user, 2026-09-16), and
  the status scope has its own bearer so a status writer can never name a
  mirrored blob.
- An index entry carries `state`: `mirrored` when the bucket holds the bytes,
  `pending` otherwise, so neither the index nor the site ever claims a byte
  that is not there. Presence is **read back from the bucket** before a
  snapshot is written, not inferred from what the run uploaded.
- Cloudflare refuses a request body past its plan's limit **at the edge**: a
  129.3 MB archive answered `413 Payload Too Large` before the Worker ran. So
  an object above 95 MiB is not uploaded in one request; instead
  `POST /w/pull/<sha256>` asks the Worker to stream it from its origin into
  R2, handing R2 the pinned digest as the expected checksum, so R2 refuses the
  object unless the bytes hash to it. The bytes never pass through a request
  body or the Worker's 128 MB memory, and the route grants no capability the
  blob write does not: the key is still the digest, so the worst a bearer
  holder can do is store content under its own hash.
- Debian archives also answer under `/d/upstream/debian/pool/<tail>`, the
  shape mica-system-base's existing hook rewrites to
  (`MICA_BASE_MIRROR=pool:<base>`, `src/cache.ts mirrorUrl`), which is what
  lets that repository use the mirror with a CI variable and no code change.

Phase 1 result, 2026-09-16: **347 of 347 third-party objects mirrored,
1638.0 MiB** -- 324 Debian archives (102.9 MiB) and 23 source archives
(1535.0 MiB), the seven largest streamed by the Worker. Verified from outside:
a 112 MiB Worker-pulled archive reads back with exactly its pinned sha256, a
blob serves `cache-control: public, max-age=31536000, immutable` with an
`etag`, both readable shapes resolve to the same bytes, and a range request
answers 206.

Still to wire, in other repositories and therefore requested through the
coordinator: `MICA_BASE_MIRROR=pool:https://res.micaos.dev/d/upstream/debian`
in mica-system-base's CI (no code change), and a fetch-time hook in
mica-boards that tries `<mirror>/blob/<sha256[0:2]>/<sha256>` before a row's
URL -- boards knows the sha256 from its own lock, so the canonical blob path
needs no readable names and no lock rewrite.

Phase 2, delivered 2026-09-16: the build-env image blobs and the read-only
registry route.

- 65 of 65 objects, 1742.9 MiB: the five images of build-env `20260916-0735`
  (base, c, go, rust, bsp), their index and platform manifests, configs and
  layers. Six went through the pull route. The manifest a lock row names is
  itself mirrored, with its media type, because a puller asks for it by name.
- The registry read side: `GET /v2/` answers the version check, a manifest or
  a blob is served by digest, and a tag resolves through the index like any
  other readable name (`/v2/micaoss/mica-build-env/manifests/<tag>` is an
  alias on the manifest object). There is no write, no upload and no delete
  route in the `/v2` space.
- The build-env blobs live in a registry that wants a token, and the Worker has
  no registry credential by design: the client reads a small blob with its own
  anonymous token, and for one past the request limit it resolves the
  registry's redirect itself and hands the Worker the resolved URL. The Worker
  stays a dumb fetcher and R2 still enforces the digest.
- The pull route is bounded as the coordinator asked: the origin is a hint and
  never a trust anchor (the digest is enforced, so a wrong origin can only
  fail), only `https://` is accepted, redirects are followed by hand with every
  hop re-checked as https and the chain capped at five, and the response never
  echoes what was fetched -- so the route cannot be used to read a URL, only to
  store bytes whose hash is already known.

Measured after phase 2:

- **Bit-identical to ghcr, proven by a client rather than claimed**:
  `docker pull res.micaos.dev/micaoss/mica-build-env:bsp.20260916-0735`
  transferred the image and reported digest
  `sha256:dddef7c590c9ea0b52c3bcd07108466a73e02a49252e9ae1a5e07d333b572a3e`,
  exactly what ghcr serves for that tag; docker verifies every layer digest as
  it pulls, so the whole image is checked, not just the manifest. The `base`
  index fetched from both hosts compares byte for byte (`cmp`), both reporting
  `sha256:23c0ac30...e5a`.
- **Cost against a ghcr pull**: a 56 MiB layer read cold from the mirror took
  7.05 s, then 1.59 s and 1.01 s (the first is R2's own cold read), against
  2.00 s, 1.20 s and 1.20 s from ghcr; a 221.8 MiB layer took 5.45 s from the
  mirror against 9.03 s from ghcr. A manifest by digest is 0.38-0.41 s against
  ghcr's 0.27-0.31 s plus the token round trip a client must make first. A
  manifest **by tag** is 0.69-0.71 s, because resolving a tag reads the index
  pointer and the 278 KB snapshot; that is the one avoidable cost in the
  design, and the fix is to cache the resolved tag map in the Cache API rather
  than per isolate.

Later phases: A the product images with the `mirrors` member proposed to `mica`
docs, 3 the vendor git trees as depth-1 packfiles.

## What offline means, and where it stops

An **offline consumer build** is fully covered by this design: every byte a
build of mica-system-base, mica-boards, mica-core, mica-podman or mica-build
fetches is either a sha256-pinned row of its own locks, a build-env image it
pins by digest, or (phase 3) a git tree pinned by commit -- all mirrored.

An **offline rebuild of the build-env images is not covered**, and mirroring
the three `InRelease` rows does not change that: the Ubuntu packages those
indexes name are fetched from `snapshot.ubuntu.com` and are not pinned row by
row, so covering a bsp rebuild would mean mirroring the snapshot's package
files, a far larger set than three rows suggests (mica-build-env,
2026-09-16). The protection against an outage there is structural rather than
mirrored: the image is built once, when a build-env release is cut, and every
consumer takes it by digest afterwards.

## Risks

- The repository secrets are only reachable from a workflow, so every
  Cloudflare action runs in CI; a workstation cannot verify the deployment.
  Mitigation: `infra.yml` reports what the token can and cannot do, and the
  Worker's own behaviour is covered by tests that run without Cloudflare.
- The existing `CLOUDFLARE_API_TOKEN` is probably broader than this design
  wants (it needs no delete, and only one bucket). Mitigation: report the
  narrower token the design asks for so the user can replace it; the sync
  itself uploads through the Worker's write endpoint and needs no R2
  credential at all.
- `res.micaos.dev` requires the zone in the same account for wrangler to bind
  the custom domain. If it is not, the Worker stays on its `workers.dev`
  hostname and the domain is a user action.
- Enumerating sizes means one HEAD or ranged GET per upstream object, and
  `developer.arm.com` answers no content-length. Mitigation: sizes are
  optional in the dry-run (`--sizes`), and a missing size is recorded as
  absent rather than guessed.

## Scope

New: `docs/` records, hygiene and toolchain files, `src/` (about 400 lines
plus tests), `worker/` (about 150 lines), three workflows. No producer
repository is touched in phase 0, and nothing is published.

## Alternatives

- Readable object keys instead of Worker routes: rejected, it doubles the
  bucket for the largest items and creates two keys that can drift.
- Per-producer push with an R2 credential in each repository: rejected, five
  credentials and five implementations; the pull sync plus the content-
  addressed write endpoint gives the same freshness with one.
- Publishing to R2 and changing what the locks reference: rejected in the
  accepted proposal, because `mica:docs/design/release-lock.md` 1.3 fixes the
  registry and every pin in every repository would change.

## Annotations

- 2026-09-16, user through coordinator `uj991oa2`: proposal v2 accepted;
  retention window three scoped releases per scope; `mica-index.json` gains
  the optional ordered `mirrors` member (routed to `mica` at phase A);
  phase 3 exists; Debian's `apt` row and `pin-inputs` stay on
  `snapshot.debian.org`; update archives are mirrored with the product
  images; the device update service stays out of scope.
