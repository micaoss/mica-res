# mica-res - Changelog

## 2026-09-20 07:12 [progress]

**The prune refusal that retires itself.** `cli.ts guard` (new, in `sync.yml`)
takes prune candidates as `<owner>/<package>:<tag>` and answers one verdict
each, reading the condition off the published index every run rather than off
a sentence someone has to remember: a pool, a `rootfs`, or a mica-boards
board component is refused while `poolsCovered()` is false, and **the refusal
disappears on its own the day the index carries a `package` or `pool` row** --
no edit here, nobody to notice that the reason ended. Every verdict states
what would retire it.

The tag families are the ones the org's packages actually carry, read from
ghcr: `pool.<arch>`, `pool.<board>.<arch>`, `rootfs`, `board|kernel|uboot|firmware.<board>`,
`base|bsp|c|go|rust[.<arch>]`, `image|update.<product>`. **An unrecognised
family is a refusal**, because a classifier that cannot place a candidate has
not established that another copy exists. A build-env release is allowed only
where the mirror holds the blobs of THAT release; `image.*` and `update.*` are
refused with the distinction stated, since the mirror holds the release's
`.img.gz` and `.micaupd` assets and never those OCI bytes. Today, against
index `20260916-1752`: one allowed (`base.20260916-0735`), everything else
refused. Exit code 1 on any refusal, so a candidate list cannot pass CI while
it is unsafe.

A defect found in the gate itself while testing it, and fixed: an argv slice
ate the first candidate, so `guard <one-candidate>` printed "no candidates
given" and exited 0 -- the gate reporting nothing to check while a candidate
stood in front of it. The guard now refuses when arguments are given and none
parse, which is the shape of that failure rather than the instance.

## 2026-09-20 06:54 [correction]

Two stamps in the entries below were written ahead of the clock (07:05 and
07:02 for work committed at 06:49 and 06:45) and are corrected to their commit
times; the coordinator's citation of commits `5daa07b` and `2306c45` is
unaffected.

**The pools are unmirrored BY DECISION, not by oversight, and the entry below
is reclassified.** `docs/task/20260916-0728-r2-resource-service-phase-0.md`
records the accepted scope of 2026-09-16 (user, through coordinator
`uj991oa2`) and says in as many words: *"Out of scope and not to be re-added:
our package pools, mica-boards board components, release locks and
`SHA256SUMS`, the 21 upstream docker.io images, and the device update
service."* So "nobody had a reason to look" is wrong about the cause: the
records carried the decision all along, and `packages/mica-sync/src/producers.ts`
states it at the top of the file.

What stands, and is still worth a P1 label, is the **consequence and the
substitution trap**: nothing tied that scope decision to what it implies for
protection, so a retention argument could reach for the 324 upstream `deb`
objects as evidence that our packages are mirrored. The measurement is
unchanged -- ghcr holds the only copy of every pool -- and the finding is now
where it belongs: a decision's consequence, measurable by
`cli.ts coverage`, not a defect in the mirror. **Mirroring the locks or the
pools would reverse "not to be re-added" and is the user's call, not a phase
this repository can start.**

## 2026-09-20 06:49 [BUG-P1]

**The mirror protects one ghcr package, not "the ghcr packages".** Measured
off the published index rather than remembered from the phases that built it
(`cli.ts coverage`, new, read-only, in `sync.yml`): index `20260916-1752`,
535 objects, and the only ghcr origin in it is `micaoss/mica-build-env`
(115 objects). The pin rows present are `source` 389, `image` 219, `git` 44
and `asset` 30 -- **no `package` and no `pool` row has ever existed here**, so
the OCI pools that carry every Debian package this workspace publishes
(`pool.<arch>.<release>`, `pool.<board>.<arch>.<release>`, `rootfs.<release>`)
are mirrored nowhere and ghcr holds their only copy. The 324 `deb` objects are
upstream Debian from `snapshot.debian.org`, pinned through `upstream.lock` --
they are not our packages, and counting them as package coverage is the
mistake this command exists to prevent.

Two further limits of the same shape, both measured: the mirror holds **no
lock and no `SHA256SUMS` bytes** (zero lock-named objects in the index), so
the binding from a release to the digests it names survives only in the
producers' releases and in consumers' committed `locks/`; and the collector's
snapshots hold run and job **metadata**, the API's own words, never logs or
artifacts. No phase was skipped and nothing regressed -- pools were never in
scope. It matters now because a retention decision about a ghcr package is
safe only where the mirror holds that package's bytes.

## 2026-09-20 06:45 [progress]

**An early warning for the run history, because the bound is the page, not
the retention.** `cli.ts history` now reports the recovery margin per
repository. The window that limits recovery is not GitHub's run retention:
the collector reads ONE page of 100 runs (`listRuns`, no pagination) and
`backfill.yml` reads the collector's own artifacts rather than the API, so a
run that falls past position 100 before any pass sees it is unreachable by
both paths. The margin is the distance from the oldest run page one still
reaches to the oldest run nothing has collected; today the two saturated
repositories are `mica` 48.3 h and `mica-res` 58.3 h against a collector that
fires every two to five hours, and the other six are not saturated at all, so
their page reaches their whole history. A negative margin prints
`UNREACHABLE`.

## 2026-09-20 06:38 [progress]

**The run history in the bucket is unbroken, and the retention proposal lands
on 2026-09-22.** `bun packages/mica-sync/src/cli.ts history` (read-only, in
`sync.yml`) walks the `status` namespace and joins it against every
repository's concluded runs: 427 run snapshots (3.2 MiB, 429 objects) spanning
2026-09-15T01:55:52Z .. 2026-09-20T01:06:38Z, with **0 holes**. The 61
concluded runs without a snapshot all started after the collector's last pass,
so they are lag, not loss -- the distinction the count alone hides, and the
reason `classifyGaps` exists rather than a bare total.

Two facts that belong with the number. The `*/30` schedule of `collect.yml`
is fired by GitHub roughly every two to five hours (last pass 01:29, none for
the five hours since), so the tail is routinely tens of runs deep; the
idempotent `backfill.yml` is what closes a hole if one ever appears. And the
collector snapshots **Actions runs and jobs, not ghcr package versions** -- so
these snapshots do not protect image history at all. The mirror does.

## 2026-09-20 01:10 [BUG-P0]

**The prunable query's join silently found nothing for slash-form releases**,
and it reported two releases a published index names as named by nobody --
`mica-build.cx3576/20260915-2230` and `mica-build.x64/20260915-2230`, the two
whose bytes no upstream serves. Acting on that list would have destroyed those
bytes and broken full verification of the only clean pre-rename index. The
coordinator verified the input rows of `mica/20260915-2242` and caught it.

Cause: a lock row spells a scoped input as `mica-build.cx3576` with the stamp
in its own field, while the release tag spelled it `cx3576/20260915-2230`, so
one side keyed `mica-build.cx3576/20260915-2230` and the other
`mica-build/cx3576/20260915-2230`. Matching both tag separators was not enough
-- **the separator inside the identity had to match too.**

Fixed by one normalising function, `releaseId`, through which BOTH sides of
the join now pass: `<repository>.<scope>/<stamp>`, with a tag split on either
separator. Extending the check to the other identity kinds found a second
instance of the same class immediately: the index-coverage table recognised an
index by the tag pattern `mica.<stamp>` and therefore missed the slash-form
`mica/20260915-2242`; it now recognises one by its normalised identity.

After the fix: list 1 is 34 (was 30), list 2 is still 0, list 3 is 20 (was
24). Third naming-form miss of the day, and the first inside a query a user
was about to act on: **a query returns "nothing found", never "nothing
exists".**

## 2026-09-19 22:00 [pitfall]

**A newly published name needs a purge precisely because its absence was
cacheable.** The repaired `uefi-x64-kernel pack.00` served 200 from a runner
at once while another vantage read 404 for about twenty minutes, then 200 with
`cf-cache-status: DYNAMIC`; nobody purged, so TTL expiry and invalidation
cannot be told apart -- confirmed by behaviour, not a mechanism proven. Raised
with the framework owner as a defect class in the purge surface
(`docs/task/20260917-0852-public-resource-framework.md`), with the asymmetry
that decides it: the consumers most likely to hold a cached absence are the
ones that tried and failed, which is to say the ones waiting for the fix.

Fifth instance today of a non-answer treated as an answer -- a cancelled run
as a verdict, an absent asset digest as a wrong one, a release with no lock as
a broken one, a missing content-length as missing bytes, and a 429 as a
refusal. The split that resolves the family: **retry what means later, refuse
what means no.**

## 2026-09-19 21:45 [decision]

Four things recorded from the evening's exchange rather than left in the
reports: **44 keys against 43 digests** with their units, because a bare
number is wrong for whichever question the reader is not asking; the
**carry-forward's measured scope** (nearly everything once during a
restoration, nothing on a normal release); the **one-cycle lag** behind a
release as the steady state rather than a defect; and the practice that
**someone should occasionally do what a consumer does, by hand**, because the
next gap will be in whatever the automated checks are not about either.

The repaired name is verified independently: both
`uefi-x64-kernel/f717995c....pack.00` and the arm64 name serve bytes hashing
to `0a833fa8...`, the digest both manifests declare. One object, two names,
which is what the contract needed and what the earlier claim asserted without
being true.

## 2026-09-19 21:30 [BUG-P0]

**A consumer-breaking gap that both the audit and the reconciliation reported
clean**: `upstream/git/uefi-x64-kernel/f717995c....pack.00` did not resolve,
while the manifest declared it and every other chunk served. The shared first
chunk of the two uefi kernel packs was stored under the arm64 name only, so
the x64 name was one the catalogue never carried. mica-boards would have hit
it on its first mirrored fetch of the largest thing it pulls.

Why nothing saw it: an object-set comparison cancels a missing NAME out on
both sides -- the object exists, so the audit is satisfied; the key is derived
rather than lock-named, so the reconciliation excludes it. The gap was not in
the checks' implementation but in what they are about. Found by the
coordinator following the consumer contract by hand.

The fix is a check over the CONTRACT (`cli.ts packs`, in `sync.yml` on every
run): for every git-pack manifest, every chunk it declares must resolve under
THAT MANIFEST'S OWN NAME -- not by digest, not under a sibling. It reproduced
the gap immediately (13 manifests, 31 declared chunks, 1 problem), and
answers the question of whether others exist: no, exactly one. `--repair`
republished the name from the digest the service already held; the audit then
read 851 objects, 0 problems.

**And the "one-object gap" was this defect, not my arithmetic.** The
coordinator's 536 counted KEYS and was right; my 43 counted distinct DIGESTS
and was also right; the missing key was the difference. Telling the
coordinator the gap was my own arithmetic error was wrong, and its refusal to
guess which way it fell was better judgement than my explanation.

## 2026-09-19 21:05 [BUG-P1]

**The audit's own byte check was the defect, not the import.** It HEADed each
object and compared `content-length` with the catalog's size; for a
compressible object -- every JSON here, so every git-pack manifest and every
status snapshot -- the download host answers without that header or with the
encoded length, and the check rendered that as "the download host serves null
bytes". It produced 9, then 13, then 328 false positives, and I reported the
first nine as a finding against the owner's import. The coordinator's
independent `GET` of six of them (200, bytes served) is what exposed it.

It is the class I had been naming all evening, committed inside the check whose
whole purpose is to not be confidently wrong: **a missing answer is not an
answer**. A HEAD without a matching `content-length` now settles by fetching
the bytes with `accept-encoding: identity` and comparing their sha256 with the
catalog's, which is both stronger and immune to encoding. Two tests cover it.

Second correction, the coordinator's: "persistent across three snapshots" was
not evidence of permanence. Three samples inside a window that ran from 125 to
535 objects only showed the condition outlasted a few minutes. Persistence
must be stated across what -- a duration, a fraction of the writer's work, or
its completion.

## 2026-09-19 21:00 [progress]

**The mirror is whole and the reconciliation is clean.** Against catalog
`01m2xptkys2zbfznnwpbyf6w4s`:

    in the catalog and in the locks: 492
    in the locks and missing:          0
    in the catalog, named by no lock:  0
    same key, different digest:        0

535 mirror objects = the 492 the locks name plus 43 git-pack objects derived
from the 13 pinned commits. The audit reports **0 problems over 850 public
objects** with the digest-based byte check, and the sync workflow is green for
the first time since the cutover. Nothing was left to publish: the owner's
import restored exactly what the locks name, so the difference this repository
was authorised to publish is empty.

## 2026-09-19 20:50 [progress]

The collector publishes again and the history is recovered. Its first run with
a token published **269 snapshots**; the backfill from the workflow artifacts
added **44** more that had aged out of the API window, and a second backfill
run reported **313 snapshots, 0 published, 313 already held** -- a checkable
confirmation rather than an assertion. The window recovered is
**2026-09-15T01:55:52Z to 2026-09-19T20:32:27Z**, which covers the whole gap
from the 2026-09-18 16:10 cutover.

The same run closed the CI-health issue by itself: every default branch was
green, including mica-build, which had been red for 57.6 hours. Opened at
57.6 h with `suites` named as the first failing job, updated, closed on
recovery -- the mechanism's full lifecycle, on the case that motivated it.

One authority to keep in mind rather than forget: `MICA_RES_STATUS_TOKEN`
carries the same token as `MICA_RES_TOKEN` (user decision, 2026-09-19: the
scope grants routes and the namespaces come from the user's policy, so a
status-only token needs a separate restricted user). The collector can
therefore write outside `status` today. If a restricted user is created later,
the secret is replaced and nothing else changes.

## 2026-09-19 20:40 [progress]

The reconciliation of the catalog against the producers' locks runs read-only
and token-free in `sync.yml` (`cli.ts reconcile`): the public listings give
key, size and sha256, so nothing needs a credential to compare them with what
the locks name. Measured against catalog `01m2xnjtvxazkkd24a66arbrbd` while
the owner's v1 import was still filling the service: **344 in both, 148 named
by a lock and missing, 0 held and named by no lock, 0 conflicting digests.**
So the retired service's catalog and the current pins agree wherever both have
a key.

Two things the run caught that matter more than the numbers:

- **A pack of a pinned commit is pinned by derivation.** The first run
  reported 29 objects "held and named by no lock", every one a git-pack
  manifest or chunk, because a pack's key comes from a commit a lock pins
  rather than from a lock row. Counting them as unpinned would have made the
  one interesting column noise; the classification now accounts for them and
  the column reads 0.
- **The audit refuses nine objects the catalog claims**: the git-pack
  manifests of `aardvark-dns`, `conmon`, `cx3576-kernel`, `cx3576-uboot`,
  `netavark`, `podman`, `s905x5m-uboot`, `uefi-arm64-kernel` and
  `uefi-x64-kernel` are registered with a size while the download host serves
  no bytes at the key. The same nine across three catalog snapshots
  (275, 350, 375 objects), so it is not a mid-import race. It is not a general
  "key without bytes" either: a digest lookup for a Debian archive follows one
  redirect to the download host and ends 200.

## 2026-09-19 20:35 [decision]

The default that points at "fine" is the one to hunt: failing loudly is a
recoverable mistake, reassuring falsely is not. Three instances now -- an
absent asset digest, a release with no lock attached, a cancelled run read as
a verdict -- and only the third made a mechanism report health on the failure
it was built to catch.

Status snapshots are outside what a re-publish restores: they are the
collector's own output, in no lock, so an import of the old mirror cannot
bring them back. The gap is 2026-09-18 16:10 until the collector's token
arrives, and the 90-day workflow artifacts are the only copy.

## 2026-09-19 20:30 [progress]

The collector answers "is anything broken right now, and for how long": per
repository it computes the default branch's state from the snapshots it
already takes, with the moment it went red, the hours since, and whether
anything has run since. A cancelled run carries no verdict -- taking one as a
verdict read mica-build as green while it had been failing since Thursday.
A repository red past six hours is announced as one GitHub issue in this
repository, updated while anything is red and closed when everything is green,
so the state reaches a person without anyone opening a page. Measured on the
live workspace: `mica-build red for 57.6h, 3 run(s) since`.

## 2026-09-19 20:10 [pitfall]

Measured from a runner: `dl.res.micaos.dev/blob/<aa>/<sha256>` answers **200**
while `res.micaos.dev/blob/...` answers 404. The bytes of the v1 mirror are
still in the public bucket under their old keys; what is missing is the
catalog, so the service cannot resolve a digest and the namespaces `upstream`
and `mica` list empty. The download host serving those old keys is an
accident of the bucket, not a designed route: nothing should be built on it.

## 2026-09-19 19:55 [BUG-P1]

Measured from a CI runner: **the service serves none of the mirrored objects**
-- the legacy `/d/upstream/git/...` and `/d/mica/...`, the new keys on both
`res.micaos.dev` and `dl.res.micaos.dev`, and `/blob/<aa>/<sha256>` all answer
404; only `/index/current.json` answers (302). The v1 import has not run since
the 2026-09-18 cutover, so the mirror has been empty of Mica artefacts since
then. Consumers fall back upstream, which is why nothing is broken, but the
acceptance criterion of `20260917-0852-public-resource-framework` -- "every
URL an external repository already uses keeps answering with the same bytes"
-- is not met. A probe at the head of `sync.yml` now measures this on every
run.

The scheduled sync is red for the right reason: `kind-vanished` refuses to
publish a catalog with no git packs when the previous one had 43. The
half-migrated lookup inside `packages/mica-sync` (publishing under the new
key, looking up the retired `/d/` URL) was fixed in `7b95e47`, authorised by
the coordinator while the framework task was in flight; the remaining red is
the empty service, not the reader.

## 2026-09-18 17:00 [decision]

Consumers move to the new URLs rather than the service keeping the legacy
ones (user). `docs/notices/20260918-mirror-url-migration.md` asks
mica-system-base, mica-boards, mica-build and mica to switch; `/d/...` and
`/index/...` go once all four have, and not before 2026-10-02. `/blob/...`
(lookup by digest) and `/v2` stay. `s3.res.micaos.dev` moved from the R2
bucket to the Worker (user detached it) and serves the S3 read API.

## 2026-09-18 16:10 [progress]

Cut over: `res.micaos.dev` runs the resource service, signs in through
`login.gid.io` with PKCE, and has published its first catalog. The v1 import
and the `s3.res.micaos.dev` custom domain (blocked by an existing DNS record)
are still to do.

## 2026-09-18 16:05 [BUG-P1]

The resource jobs never ran on Workers, so a fresh deployment never
published its catalog. An alarm wakes a new Durable Object instance in the
same isolate; the jobs' "already started" guard skipped the new scheduler,
and their first-run delay pushed the task past the alarm that woke it on
every wake. Fixed by re-registering per scheduler and running at once on
Workers; a regression test covers both. The template's `file-gc` sweep keeps
the same guard.

## 2026-09-17 17:10 [decision]

R2 S3 credentials are optional (user): the bindings cover everything except a
server-side copy and a presigned URL, so a copy now streams
binding-to-binding, an upload the store cannot presign is taken by the
service itself (about 95 MiB at most), and a protected download is streamed
rather than signed. Public bytes are still never proxied. Deployment no
longer needs an R2 API token.

## 2026-09-17 15:30 [progress]

Delivered the code (`81f1d14`, CI green) and provisioned what is additive:
the protected bucket, CORS on the public bucket and `dl.res.micaos.dev`,
which already serves from R2. The Worker is not switched yet: the cutover
waits on the OIDC provider and the R2 API token, without which nobody could
sign in to import the v1 mirror and consumers' `/d/` and `/blob/` URLs would
break.

## 2026-09-17 16:30 [progress]

F1-F5 of the public resource framework in code: the `resource` module
(SQLite catalog, R2 objects under readable keys, snapshots, deletion with
grace, CDN purges, access keys, v1 import), the edge plane (listings,
redirects, registry, S3 read API) in front of the Durable Object, the home
page `apps/site`, the admin resources page, `infra.yml` provisioning and
deploy, and `packages/mica-sync` publishing through the control plane. All
local gates pass; deployment waits on the Cloudflare credentials.

## 2026-09-17 16:30 [pitfall]

Two client behaviours found with real S3 clients against workerd: aws-cli
does not follow a 307 on GetObject, so aws-cli downloads use the download
host as the endpoint; and Cloudflare rewrites `Accept-Encoding`, which
aws-sdk-go-v2 signs, so SigV4 verification tries the common original values.
Also: `wrangler dev` rewrites `Host` and `Origin` to the first route, so the
local dev vars allow `http://res.micaos.dev` as an origin.

## 2026-09-17 11:40 [progress]

F0 of the public resource framework: bun-tpl merged and rebranded, the legacy
mirror moved to `packages/mica-sync`, the template's `item`, `document`,
`issue` and `cron` modules dropped, `bun run check` green. The `file` module is
kept to avoid rewriting template surface. The app does not boot yet: the
policy guard needs at least one route binding, which the F1 `resource` module
provides.

## 2026-09-17 11:40 [pitfall]

`packages/mica-sync/src/cli.ts` carried a double blank line that failed its
own `eslint` gate at HEAD; removed while moving the package.

## 2026-09-17 10:05 [decision]

The public resource framework plan's read plane was revised again before
approval: public resources are downloaded from R2 directly (user), so public
objects are stored under their readable keys behind an R2 custom domain, the
Worker answers listings and redirects only, and uploads go to R2 through
presigned URLs. The Worker-proxied, content-addressed read plane of the
previous revision is superseded.

## 2026-09-17 09:20 [decision]

The public resource framework plan (`20260917-0852-public-resource-framework`)
was revised before approval: the first draft kept the JSON-only catalogue and
the no-delete invariant; the user asked for SQLite, a normative layout,
protected namespaces in a separate bucket, `s3.res.micaos.dev`, deletable
resources and a rebuild on bun-tpl, so the draft is superseded.

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
