# 20260916-0728-r2-resource-service-phase-0 R2 resource service, phase 0

- **status**: completed
- **priority**: P1
- **owner**: agent/x32539az
- **createdAt**: 2026-09-16 07:28

## Description

Stand up the Mica OS resource service so that an offline local build can take
every third-party input, the build-env images and the published product images
from `res.micaos.dev` instead of from upstream hosts, GitHub and ghcr.

Phase 0, the scope of this task: the R2 bucket, the Worker (read routes, the
content-addressed write endpoint, the cache policy), the index v1 writer, the
sync in dry-run, and the site skeleton. No producer repository is touched.

Accepted scope of the service (user, 2026-09-16, through coordinator
`uj991oa2`):

- third-party Debian archives and every sha256-pinned source tarball;
- the build-env images (base, c, go, rust, bsp);
- mica-build's published product images and update archives;
- phase 3: the 13 vendor git trees as depth-1 packfiles.

Out of scope and not to be re-added: our package pools, mica-boards board
components, release locks and `SHA256SUMS`, the 21 upstream docker.io images,
and the device update service.

Acceptance criteria for phase 0:

- `bun run check` passes (lint, typecheck, tests).
- The bucket exists and the Worker answers on its hostname; a `GET` of a
  missing blob is 404 and no route can delete anything.
- `PUT /w/blob/<sha256>` refuses a key that is not the body's sha256, refuses
  a different body under an existing key, and is a no-op for an identical
  re-upload.
- `bun src/cli.ts sync --dry-run` enumerates the in-scope objects from the
  producers' locks and prints counts and bytes per kind without writing
  anything.
- The index snapshot the dry-run would write validates against the index
  reader's own checks.

## ActiveForm

Standing up the R2 resource service (phase 0)

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- Proposal v2 was accepted by the user through coordinator `uj991oa2` on
  2026-09-16, so the Phase 2 gate is satisfied; the plan is
  `docs/plan/20260916-0728-r2-resource-service.md`.
- Credentials are repository secrets `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN`; they are only reachable from a workflow, so every
  Cloudflare action happens in CI and never from a workstation.
- 2026-09-16: phase 0 delivered. `infra.yml` run 35070024750 found the bucket
  `res-micaos-dev` already created (2026-09-16 07:23 UTC, APAC, Standard),
  deployed the Worker on `res.micaos.dev` and `mica-res.cfaa.workers.dev`, and
  uploaded the site skeleton. Verified against the live host: the site answers
  200 with `cache-control: public, max-age=300`, a missing blob and a blob path
  whose prefix is not its digest answer 404, `GET` on the write path and
  `DELETE` on a blob answer 405, and the write endpoint fails closed with 503
  because `WRITE_TOKEN` is not set yet.
- The dry run enumerates 411 objects, 3823.2 MiB: 324 Debian archives
  (102.9 MiB), 23 source archives (1535.0 MiB), 48 build-env image blobs
  (1227.4 MiB), 4 product images (323.1 MiB), 12 update archives (634.8 MiB),
  plus the 13 vendor git trees recorded for phase 3 and not packed.
- Open, for the user: `WRITE_TOKEN` on the Worker plus the same value as a
  repository secret, so phase 1 can upload; and the narrower R2 token the
  design asks for (bucket-scoped, no delete) in place of the current one.
  `/user/tokens/verify` answers `success: false` for the existing token, which
  is what an account-owned token does; its R2 and Workers permissions were
  proved by use instead.
- The `etag` the Worker sets is not visible in the live response; it makes no
  difference before the first blob exists, and phase 1 diagnoses it.

- complete: phase 0 delivered; bucket, Worker, index writer, dry-run sync and site skeleton
