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
- 2026-09-19 20:45 (agent/x32539az, authorised by coordinator `uj991oa2`)
  **A full re-publish from the producers' locks is authorised, and
  `import-v1` is therefore not needed to restore the mirrored objects.**
  Re-publishing reconstructs from the pins; the import reconstructs from a
  snapshot of the service being retired, and if the two ever disagree the
  locks win, because a lock is what a consumer verifies against. Every object
  is keyed and content-addressed, so the two paths converge only if both are
  digest-correct: **if `import-v1` is ever run and registers a different
  digest for a key the re-publish already wrote, that is a refusal and a
  report -- never a merge and never an overwrite.**
- 2026-09-19 20:45: the re-publish **cannot start**: it needs `MICA_RES_TOKEN`,
  a `res:publish` API token of this service, and no such repository secret
  exists (`gh secret list`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
  `RES_KEY_KEK`, plus the retired `WRITE_TOKEN` and `STATUS_WRITE_TOKEN` of
  the old Worker). The same gap explains `/status/current.json` answering 404:
  `collect.yml` publishes only when `MICA_RES_STATUS_TOKEN` exists, so since
  the cutover the collector has been **rendering snapshots to a workflow
  artifact and publishing none** -- 265 snapshots in the 20:04 run, none of
  them in the bucket. Issuing those two tokens needs a signed-in user, so it
  is the owner's or the user's action, not mine.
- 2026-09-19 22:00 (agent/x32539az, for the owner) **A DEFECT CLASS IN THE
  PURGE SURFACE, with an instance.** A repair is not complete until the name
  is purged: a writer purges what it CHANGES, and a key that never existed has
  nothing to purge from the writer's point of view, so every edge that cached
  the 404 keeps serving it. The publisher sees a complete repair; the consumer
  that hit the URL first does not.

  The instance: `upstream/git/uefi-x64-kernel/f717995c....pack.00` was
  republished at 21:2x and answered 200 from a GitHub runner immediately,
  while the coordinator's container kept reading 404 for roughly twenty
  minutes, then 200 with `cf-cache-status: DYNAMIC`. Nobody purged anything,
  so **whether the TTL expired or something invalidated it cannot be
  distinguished** -- confirmed by behaviour, not a mechanism proven.

  The asymmetry that makes it worth fixing rather than documenting: **the
  consumers most likely to have cached an absence are exactly the ones that
  tried and failed** -- which is to say the ones waiting for the fix. A
  cache-control of `public, max-age=31536000, immutable` on the object is
  right; the cached 404 that precedes it is what needs invalidating, and only
  the service can do that (`apps/api/src/modules/resource/purge.ts`).
