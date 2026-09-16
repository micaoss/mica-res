# mica-res - Changelog

## 2026-09-16 08:20 [progress]

Phase 1 of the mirror: the uploader, the named write routes (index, site and
status, each with its own scope and bearer), and the `state` member that keeps
the index from claiming a byte it does not hold. `WRITE_TOKEN` is live, so the
write endpoint answers 401 rather than 503 to an unauthenticated write. The
status collector ships early, ahead of any page, because the run history it
snapshots is what the pruning pause only promises to preserve.

## 2026-09-16 17:45 [progress]

Mirrored build-env `20260915-0138` as well as `20260916-0735`: 115 OCI
objects, 2913.1 MiB, and the sync now derives which build-env releases a
published release still names instead of being told. 536 of 536 pinned
objects, 8219.2 MiB. Two standing gates added: a real `docker pull` by digest
compared against ghcr, and the git pack consumer contract.

## 2026-09-16 17:30 [BUG-P1]

A run given `--kinds product-image,update-archive` published an index with no
git packs in it, because `--kinds` was narrowing the enumeration and not only
the uploads. Third defect of one class -- derived state disagreeing with the
bucket. Fixed by enumerating every kind always, and guarded by
`refuseRegression`, which refuses a snapshot that loses a whole kind the
published one had. The complete index is `20260916-1726`: 486 of 486 objects,
7048.5 MiB.

## 2026-09-16 17:00 [progress]

Phase 3: the thirteen vendor trees are mirrored as depth-1 packs (44 objects,
1351.0 MiB), stored as ordered content-addressed chunks with a manifest, and
`sync.yml` now walks the consumer contract end to end on every run. The
release reader refuses an unmatched release set instead of returning empty,
and the index snapshot is cached at the edge so resolving a registry tag no
longer reads the index from R2.

## 2026-09-16 09:15 [progress]

Phase A: the product images and update archives of the three newest scoped
releases are mirrored, so the bucket now holds every pinned object -- 424 of
424, 4350.7 MiB. Phase 3 measured before implementing: 1.33 GiB of depth-1
packs for the thirteen pinned trees, about 1.07 GiB deduplicated because the
two `uefi-*` kernels are the same commit.

## 2026-09-16 09:12 [pitfall]

A scoped release tag is `<scope>.<stamp>`, not the `<scope>/<stamp>` the
release-lock spec and the workspace `CLAUDE.md` describe. The reader followed
the spec and silently ignored every new release; it now follows what
mica-build publishes and refuses the retired form.

## 2026-09-16 09:05 [progress]

Phase 2: the five build-env images of `20260916-0735` are mirrored (65
objects, 1742.9 MiB) and the read-only registry route serves them. A
`docker pull` from `res.micaos.dev` returns the digest ghcr returns and
verifies every layer on the way, so bit-identity is a client's finding rather
than a claim. The status collector now writes to the bucket.

## 2026-09-16 08:40 [pitfall]

Cloudflare rejects a request body past the plan limit at the edge, before the
Worker runs: a 129.3 MB archive answered 413. Large objects are therefore
streamed by the Worker from their origin (`POST /w/pull/<sha256>`) with the
pinned digest handed to R2 as the expected checksum. Two reporting bugs were
caught the same way: the index took its state from what a run uploaded rather
than from the bucket, and an object the Worker already held was counted as
written.

## 2026-09-16 08:20 [decision]

The status site lives on one host with the mirror (user): `res.micaos.dev`,
one Worker, one bucket, the status objects under `status/` and the pages under
`/status`. Every write goes through the Worker rather than an R2 token, so the
status prefix has a write route with its own bearer, a prefix it refuses to
leave and no delete. No PAT: the repositories are public and the collector
reads with the workflow token. Actions-run pruning is paused until a retention
policy is agreed.

## 2026-09-16 07:52 [decision]

The Worker deployment follows the shape of `mica`'s website Worker (user,
2026-09-16): `cloudflare/wrangler-action@v4` with a pinned wrangler
(`4.132.0`, checked at its release today), the account and token from the
repository secrets, `wrangler.jsonc` instead of `wrangler.toml`, and the write
endpoint's bearer bound at deploy time from the repository's own
`WRITE_TOKEN`. Deployment stays manual (`workflow_dispatch` only), as it is
there. `res.micaos.dev` is a third custom domain on the `micaos.dev` zone; the
website Worker `micaos-dev` is untouched and this one is named `mica-res`.

## 2026-09-16 07:45 [progress]

Phase 0 of the resource service: the Bun tooling (lock reader, enumeration,
canonical index v1, site rendering, the dry-run sync), the Worker (blob, index,
readable download and site routes, the content-addressed write endpoint, the
cache policy), and the three workflows (`ci.yml` gates, `infra.yml`
provisioning by hand, `sync.yml` dry run on a schedule). The bucket
`res-micaos-dev` and the Worker on `res.micaos.dev` exist; nothing is mirrored
yet, and the write endpoint stays closed until `WRITE_TOKEN` is set.

## 2026-09-16 07:28 [decision]

The repository becomes the Mica OS resource service: the tooling, the index
and the site of `res.micaos.dev`, with the artefacts in R2 rather than in git.
Brand assets stay in the tree under `mica/brand/`. Accepted by the user
through coordinator `uj991oa2`; scope and phases are recorded in
`docs/plan/20260916-0728-r2-resource-service.md`.

## 2026-09-16 07:20 [progress]

Renamed from `micaoss/res` to `micaoss/mica-res` (user). Brand assets moved
to `mica/brand/logo/` with dark variants; the embedded C2PA provenance
manifests those files carried were dropped, since they named a tool in
remote-visible repository content.
