# 20260916-0728-r2-resource-service-phase-0 R2 resource service, phase 0

- **status**: in_progress
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
