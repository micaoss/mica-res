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
- 2026-09-19 19:30 (agent/x32539az, authorised by coordinator `uj991oa2`
  while this task was in flight): the scheduled `sync` workflow had been red
  since 2026-09-19 08:46 with `kind-vanished: index 20260916-1752 has 43
  git-pack objects and this enumeration has none`. The cause was a
  half-migrated path inside `packages/mica-sync`: publishing used the new key
  (`upstream/git/...`) while the lookup still used the retired `/d/` URL, so
  every tree read as absent. While the sync is red the published invariant
  check (`audit`) does not run, which is why the coordinator authorised this
  specific edit rather than waiting: `manifestName`/`chunkNames` return the
  key, the publish path drops its `slice('/d/'.length)` compensation, and the
  readable names lose the prefix (`objects.ts`, and for coherence `ghcr.ts`
  and `releases.ts`, which carried the same prefix and would otherwise have
  stopped resolving to a key). `canonicalKey` now excludes names with a
  leading slash, because a registry name (`/v2/...`) is not a bucket key.
  Nothing else in the package was touched.
- **For the owner of this task**: its own acceptance criterion is "every URL
  an external repository already uses keeps answering with the same bytes".
  If `/d/...` does not answer, that criterion is not met and the task cannot
  be accepted while it is unmet. A runner probe now runs at the head of
  `sync.yml` and prints what the legacy and current paths answer, so the
  question is settled by measurement rather than by reading the notice.
