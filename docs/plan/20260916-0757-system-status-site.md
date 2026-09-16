# 20260916-0757-system-status-site System status site

- **status**: draft
- **createdAt**: 2026-09-16 07:57
- **approvedAt**: (pending)
- **relatedTask**: 20260916-0757-system-status-site

## Context

The user wants one place that shows the state of the whole system: boards and
products built, commits, newest release, every build grouped into stages with
state and duration, per-repository status, and generated progress charts. API
limits are explicitly waived; direct calls are fine.

Measured on 2026-09-16, and it is the finding that shapes the whole design:
the Actions runs the charts would be drawn from are being deleted as
housekeeping (380 this morning, one kept per repository). Retained runs
against releases: mica 71/0, mica-boards 11/10, mica-build 3/3,
mica-build-env 4/2, mica-core 2/1, mica-podman 2/1, mica-system-base 2/1. The
history the user asked for therefore does not exist yet and what accumulates
is destroyed daily, so the collector has to ship before any page.

A workflow's `GITHUB_TOKEN` cannot read another repository's Actions, so the
collector needs a read-only fine-grained PAT (Actions, Contents, Metadata read
on `micaoss`) or a GitHub App installation.

## Proposal

Its own bucket `status-micaos-dev`, its own read-only Worker `mica-status` on
`status.micaos.dev`, and a scheduled collector in this repository that writes
named snapshots with a bucket-scoped R2 token. No write route exists on the
status Worker, and no status credential can name an object of the mirror
bucket: a binding is a capability, where a prefix check would be a line of
code that can regress.

### 1. The job-name grammar

The Actions API reports a job name, and both observed shapes are the same
grammar: a path of workflow segments joined by ` / `, each segment optionally
suffixed with its own matrix values in positional parentheses.

```text
<caller job>[ (matrix...)] / <callee job>[ (matrix...)]
```

- `build / base (amd64, ubuntu-latest)` -- mica-system-base: the caller job
  `build` has no matrix, the callee `base` has one.
- `release-products (uefi-x64-prod, uefi-x64, amd64, ubuntu-24.04) / product`
  -- mica-build: the caller has the matrix, the callee `product` has none.
- `build / kernel (uefi-arm64, ubuntu-24.04-arm)` -- mica-boards, measured in
  run 35070071255.

So the parser splits on ` / ` first and reads the parentheses per segment; the
values inside are **positional and undocumented in the API**, which is why
every matrixed job declares its dimension order. A segment whose parentheses
do not match the declared arity is `unmapped`, never guessed.

### 2. The stage vocabulary: eighteen words

`plan`, `check`, `docs`, `archives`, `kernel`, `uboot`, `rootfs`, `pool`,
`pools`, `components`, `inputs`, `package`, `gate`, `image`, `merge`,
`publish`, `index`, `deploy`.

Three were added on 2026-09-16 after the producers pushed back, and each
distinction is real rather than cosmetic (coordinator decision):

- `deploy` -- a site upload that publishes no artefact, lock or OCI tag.
  Folding it into `publish` would put a site upload in the same column as a
  release (mica).
- `merge` -- making a multi-architecture image the release's, by merging
  per-architecture manifests or by tagging an already published index. It
  builds nothing and attaches no asset, so it is neither `image` nor
  `publish` (mica-build-env; mica-boards and mica-build have a step of the
  same kind).
- `inputs` -- fetching and validating another repository's published
  components. mica-build's `boards` job does that, which is not what
  `components` means in mica-boards, where components are built.

A repository uses a sparse subset, and **the absence of a word is never a
missing stage**: mica-core publishes OCI pools with no `pool` or `pools` job
at all, because the pool push, the anonymous read-back and the asset upload
are steps inside `publish`. Only a stage the map declares for that repository
and workflow can be `unknown`.

### 3. The render states: eight, and only one is green

| State | Comes from |
|---|---|
| `success` | the job's conclusion |
| `failure` | the job's conclusion |
| `cancelled` | a real state, not a failure: `concurrency` cancels in-progress ci runs for pull requests (mica-system-base; release runs are never cancelled) |
| `in-flight` | started, not completed |
| `skipped` | the run exists and the job reports `skipped` (mica's `deploy` on every push and pull request) |
| `absent` | the run exists and a declared job is not in it: an empty matrix (mica-build `release-products` when no `-prod` product has a release-target board), a job the plan found nothing for (mica-build-env `build`), or a job that only runs on a push to `main` |
| `not-applicable` | no run exists for that commit at all: `paths-ignore` (mica-core `ci.yml` on a docs-only push) or a path filter (mica `website.yml` `checks` outside `website/**`, `docs/**`) |
| `unmapped` | a job name matching no declared pattern -- rendered as an error, because a renamed job must break loudly |

`unknown` is the ninth and is not a job state: it is the absence of collected
data (before the collector ran, or a collection gap). It is never green.

### 4. Declared mapping

Keyed by **repository, workflow file and job name** -- never by job name
alone, because a reusable workflow is called under the same job id from more
than one workflow.

#### mica-system-base (authoritative, workflows at `98db467`)

| Workflow | Job name | Stage |
|---|---|---|
| `ci.yml`, `release.yml` | `build / plan` | plan |
| `ci.yml`, `release.yml` | `build / check` | check |
| `ci.yml`, `release.yml` | `build / base (amd64, ubuntu-latest)` | rootfs |
| `ci.yml`, `release.yml` | `build / base (arm64, ubuntu-24.04-arm)` | rootfs |
| `ci.yml`, `release.yml` | `build / gate` | gate |
| `release.yml` | `publish` | publish |

- `build.yml` is called under the job id `build` by both workflows.
- `base` is the only matrix job: `matrix.include`, position 1 arch (`amd64`,
  `arm64`), position 2 runner (`ubuntu-latest`, `ubuntu-24.04-arm`; always
  native, never emulated).
- `base` is one job doing four things in sequence (the pinned archives, the
  test bootstrap of every locked package, the four packages, the base root and
  its layer); finer bars would need step names inside the job. As one stage,
  `rootfs` is right.
- `plan` produces no artefact and is always green in seconds: a near-zero bar
  is correct, not missing data.
- Nothing is path-filtered or conditional; every job runs on every run. The
  only conditionals are cache-save steps, which never change whether a job
  runs. The pending build-env move replaces two files and changes no job.

#### mica (documentation and the website)

| Workflow | Job name | Stage |
|---|---|---|
| `ci.yml` | `docs` | docs |
| `website.yml` | `checks` | check |
| `website.yml` | `deploy` | deploy |

- No matrices anywhere and no job-level `name`, so the API name equals the job
  id exactly. **A parenthesised suffix here means something changed and the
  mapping must fail rather than guess.**
- mica builds no artefact for any board or product: it is a repository-level
  row, never a board or product row.
- `docs` runs on every push and pull request with no path filter, so an absent
  `docs` job is a real signal. `checks` is path-filtered (`website/**`,
  `docs/**`, `.github/workflows/website.yml`), so a commit elsewhere produces
  `not-applicable`. `deploy` is conditional on `workflow_dispatch` and reports
  `skipped` on every push and pull request.

#### mica-build-env (`bf347e2`)

| Workflow | Job name | Stage |
|---|---|---|
| `ci.yml` | `gates` | check |
| `ci.yml` | `archives (<architecture>)` | archives |
| `release.yml` | `plan` | plan |
| `release.yml` | `build (<architecture>, <runner>)` | image |
| `release.yml` | `merge` | merge |
| `release.yml` | `assets` | publish |

- `archives` has one dimension and it is **the architecture whose toolchain
  archives are gathered, not the runner** (both run on `ubuntu-24.04`).
  `build` has two, from a `matrix.include`.
- `archives` runs only on a push to `main`, so `absent` is the normal case on
  every pull request. It builds nothing -- it warms a cache -- and its
  duration is zero on a hit, so it must not appear in a duration chart as
  though it were work.
- `build` runs only when `plan` found something: release `20260915-0138`
  skipped it entirely, `20260916-0735` ran it for all five images.
- `merge` runs with `always()` and tolerates a skipped `build` deliberately.
  `assets` runs with `always()` and needs `merge` to have succeeded --
  **`assets` skipped while `merge` succeeded is a real defect, not a normal
  path**: it happened once (`20260915-0130` published no assets, fixed in
  `8ec2ff0`), and the site should flag it rather than render it as a variant.

#### mica-core (`5d87a66`)

| Workflow | Job name | Stage |
|---|---|---|
| `ci.yml`, `release.yml` | `build / check` | check |
| `ci.yml`, `release.yml` | `build / package (<arch>, <runner>)` | package |
| `ci.yml`, `release.yml` | `build / gate` | gate |
| `release.yml` | `publish` | publish |

- The `build / ` prefix is the caller job id in both workflows, so the key is
  the workflow plus the name. `package`'s position 2 carries no information
  today but is in the name, so two values are parsed.
- `pool` and `pools` stay **deliberately unused** here: the pool push, the
  anonymous read-back and the asset upload are steps inside `publish`.
- `package` is not only packing: it compiles the Rust workspace and the UI,
  packs seven archives, indexes the pool, then runs the package gate as a
  **no-cache rebuild**, so its duration contains a second full compile --
  measured 1161 s cold against 698 s warm. Its cache key includes
  `locks/mica-build-env.lock`, so the build-env move to `20260916-0735`
  misses every cache exactly once: **that run is not a regression.**
- `gate` rebuilds nothing and is the job that fails when a package changed
  without a version bump (it did on `4280e81` and `4ddc456` today).
- `ci.yml` carries `paths-ignore` for `docs/**` and `**.md`, so a docs-only
  push creates **no run at all**: `not-applicable`, not `skipped`.

#### mica-build (`1fcae2c4` plus its unpushed rename round)

| Workflow | Job name | Stage |
|---|---|---|
| `ci.yml` | `lint` | check |
| `ci.yml` | `suites` | check |
| `ci.yml` | `pool (<arch>, <runner>)` | pool |
| `ci.yml` | `boards` | inputs |
| `ci.yml` | `products-plan` | plan |
| `ci.yml` | `products (<product>, <arch>, <runner>)` | image |
| `ci.yml` | `release-products-plan` | plan |
| `ci.yml` | `release-products (<product>, <board>, <arch>, <runner>) / product` | image |
| `ci.yml` | `release-index` | index |
| `release.yml` | `plan` | plan |
| `release.yml` | `product (<product>, <board>, <arch>, <runner>, <generation>) / product` | image |
| `release.yml` | `publish` | publish |
| `release.yml` | `index` | index |
| `privileged.yml` | `image-pipeline` | image |

- `release-product.yml` is reusable with the inner job id `product`, called
  from `ci.yml` `release-products` and `release.yml` `product`, which is why
  both carry a two-level name.
- **`generation` is the fifth value of `release.yml` `product` and changes
  every release, so nothing is ever keyed on it.**
- `boards` means "fetch and validate other repositories' published
  components", hence `inputs` rather than `components`.
- `lint` (about a minute) and `suites` (about twenty) both map to `check`, so
  the renderer shows the **job under the stage**; a stage-only chart hides
  where the time goes.
- Conditionality: `release-index`, `release-products-plan` and
  `release-products` run only on a push to `main`, so a pull request shows
  seven CI jobs and not nine. `release-products` can have an **empty matrix**
  (its rows are the `-prod` products whose board is a release target), and an
  empty matrix means the job does not appear at all. `release.yml` `index` can
  legitimately do nothing and succeed -- "no index is cut" -- which the site
  must not render as a cut index. `privileged.yml` is `workflow_dispatch` plus
  a weekly cron on a self-hosted runner, absent from every push.
- **`release-index` checks out a different commit than the run's** (the newest
  `mica.*` tag's commit), so its commit is not `github.sha` and must not be
  rendered as the run's commit.
- Durations: a product job reuses `_out/products/<product>` when its receipt
  is unchanged, so its duration can fall by an order of magnitude with no
  change in what it proves -- comparable only when the receipt changed.
- The rename round changes values, not keys: `x64` becomes `uefi-x64`,
  `virt-arm64` becomes `uefi-arm64`, `uefi-arm64-prod` is new, the four
  minimal products go and the `products` matrix falls from ten rows to seven.
  No job id, dimension or stage changes. **The site is therefore keyed on job
  ids and positions; a site keyed on product names would see every mica-build
  row rename at once.**

#### Outstanding

mica-boards and mica-podman. mica-boards is the one where the dimension order
matters most: its measured names put a board first in `build / kernel
(uefi-arm64, ubuntu-24.04-arm)` and an architecture first in `build / pool
(arm64, ubuntu-24.04-arm)`.

### 5. Pages

Everything renders from snapshots; nothing polls the API on page load. The
per-board and per-product stage table, per-repository status (`main` commit,
CI state, current release, pinned inputs from the locks), the whole-system
view and the release timeline all read `status/current.json` and the daily
roll-ups. A job in flight renders as in flight with its start time. Each
stage cell expands to the jobs that carry it.

### 6. Must not

Read-only credentials everywhere; the site is never an input to a build or a
release; and it never claims a state it did not read. A duration whose meaning
changed (a cache hit, a reused receipt, a one-off cache miss after a build-env
move) is marked rather than compared silently.

## Risks

- Retention: unless the pruner is paused or gated on a collector watermark,
  the first week of data is lost the same way the last month was.
- A producer changing a job id breaks the map loudly, which is the design, but
  it does mean the map is a maintained file; the owner of a rename has to send
  it here. The rename round in mica-build is the first test and changes no key.
- Nothing is keyed on product, board or generation values, so the rename round
  and every future release pass through without a mapping change.

## Scope

A collector workflow, a snapshot format, `status/stages.jsonc`, a read-only
Worker and the pages. Nothing before the proposal is accepted, and after
phase 1 of the mirror in any case.

## Alternatives

- The mirror's bucket with a `status/` prefix and a prefix-guarded write
  endpoint: works, but trades a platform guarantee for a code check and gives
  the status site a write route it does not need.
- The pages in `mica`'s website Worker: rejected for the run and job history,
  which would mix a release catalogue with monitoring data; the website keeps
  products, releases and downloads, and the two sites link to each other.
- Asking mica-core to split its pool push into its own job so the chart can
  time it: declined. A producer's job layout should not change to make a chart
  prettier; the API already gives step timings inside `publish`, and if pool
  timing ever needs to be a first-class stage that is a producer decision on
  its own merits.

## Annotations

- 2026-09-16, coordinator `uj991oa2`: proposal and addendum sent, not yet
  accepted. Authoritative stage answers received from mica-system-base, mica,
  mica-build-env, mica-core and mica-build; vocabulary extended to eighteen
  words with `deploy`, `merge` and `inputs`. mica-boards and mica-podman
  outstanding.
