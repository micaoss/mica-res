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

Job names come back from the API with the caller's job id as a prefix when a
reusable workflow is used, and with matrix values in positional parentheses,
for example `build / kernel (uefi-arm64, ubuntu-24.04-arm)` (mica-boards run
35070071255). The order inside the parentheses is positional and undocumented,
which is why each job's dimensions are declared rather than parsed.

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

The stage vocabulary (fifteen words): `plan`, `check`, `docs`, `archives`,
`kernel`, `uboot`, `rootfs`, `pool`, `pools`, `components`, `package`, `gate`,
`image`, `publish`, `index`.

The map lives in `status/stages.jsonc`, keyed by **repository plus workflow
file plus job name** -- never by job name alone, because the same reusable
workflow is called under the same job id from more than one workflow. A job
matching no declared pattern is recorded `unmapped` and rendered as an error;
a declared stage with no job in a run is `unknown`. Neither is ever green.

### Declared mapping: mica-system-base (authoritative, 2026-09-16, workflows at `98db467`)

| Workflow | Job name as the API reports it | Stage |
|---|---|---|
| `ci.yml` | `build / plan` | plan |
| `ci.yml` | `build / check` | check |
| `ci.yml` | `build / base (amd64, ubuntu-latest)` | rootfs |
| `ci.yml` | `build / base (arm64, ubuntu-24.04-arm)` | rootfs |
| `ci.yml` | `build / gate` | gate |
| `release.yml` | the same five | as above |
| `release.yml` | `publish` (unprefixed) | publish |

- `build.yml` is called under the job id `build` by both `ci.yml` and
  `release.yml`, so the same names appear in a ci run and in a release run;
  the workflow file is what distinguishes them.
- `base` is the only job with a matrix, `matrix.include` with two positional
  keys: 1 arch (`amd64`, `arm64`), 2 runner (`ubuntu-latest` for amd64,
  `ubuntu-24.04-arm` for arm64, always native, never emulated).
- `base` is one job doing four things in sequence (pinned archives, the test
  bootstrap, the four packages, the base root and its layer). Finer bars would
  need step names inside the job; as one stage, `rootfs` is the right word.
- Nothing is path-filtered or conditional: every job runs on every run
  (`ci.yml` on every push to `main` and every pull request, `release.yml` only
  on `release: published`). The only conditionals are cache-save steps.
- `concurrency` cancels in-progress `ci` runs for pull requests only, so **a
  cancelled pull-request ci run is a real state and must render as cancelled,
  not red**. Release runs are never cancelled.
- The pending build-env move replaces two files and adds or removes no job.

Answers from the other six repositories are appended here as they arrive.

### Pages

Everything renders from snapshots; nothing polls the API on page load. The
per-board and per-product stage table, per-repository status (`main` commit,
CI state, current release, pinned inputs from the locks), the whole-system
view and the release timeline all read `status/current.json` and the daily
roll-ups. A job in flight renders as in flight with its start time.

### Must not

Read-only credentials everywhere; the site is never an input to a build or a
release; and it never claims a state it did not read.

## Risks

- The message that carried mica-system-base's answer arrived with every
  backticked identifier empty, so the job ids and the two facts below were
  reconstructed from the workflows at `98db467`. The reconstruction is
  recorded above and was sent back to the coordinator for confirmation. One
  point stayed ambiguous: which job "produces no artefact and is always green
  in seconds" -- `plan` on the reading of the sentence, `check` if the
  measurement says otherwise. A near-zero bar there is correct rather than
  missing data, whichever it is.
- Retention: unless the pruner is paused or gated on a collector watermark,
  the first week of data is lost the same way the last month was.

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

## Annotations

- 2026-09-16, coordinator `uj991oa2`: proposal and addendum sent, not yet
  accepted. mica-system-base's mapping is authoritative; the other six
  repositories are answering.
