# 20260917-0852-public-resource-framework Public resource publishing framework

- **status**: in_progress
- **priority**: P1
- **owner**: agent/d8e74994
- **createdAt**: 2026-09-17 08:52

## Description

Turn mica-res from a Mica-specific mirror into a framework for publishing
resources, rebuilt on `/srv/zzci/bun-tpl`: SQLite as the source of truth, a
normative directory layout, public and protected namespaces in separate R2
buckets, an S3 read endpoint on `s3.res.micaos.dev`, and deletable resources
with managed cache policy (user, 2026-09-17).

Acceptance: the design in
`docs/plan/20260917-0852-public-resource-framework.md` is approved, then each
phase F0-F5 passes its gate, and every URL an external repository already uses
keeps answering with the same bytes.

## ActiveForm

Designing the public resource framework and the Worker refactor

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-09-17 10:20: approved; F0 merged bun-tpl and dropped the unused
  modules.
- 2026-09-17 16:30: F1-F5 implemented and verified locally (see the plan's
  "F1-F5 implementation" section). Open: deployment and the gates that need
  the live hosts.
- 2026-09-17 15:30: pushed `81f1d14` (CI green), `RES_KEY_KEK` set,
  `infra.yml deploy=false` provisioned the protected bucket, CORS and
  `dl.res.micaos.dev`. Blocked on the OIDC provider, the R2 API token and the
  go-ahead for the cutover.

