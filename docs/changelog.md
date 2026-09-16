# mica-res - Changelog

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
