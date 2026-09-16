# 20260916-0757-system-status-site System status site

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-09-16 07:57

## Description

A site that shows the state of the whole system: which boards and products
have been built, what was committed, which release is newest, each build
grouped into declared stages with its state and duration, per-repository
status, and automatically generated progress charts (user, 2026-09-16,
through coordinator `uj991oa2`).

Proposal sent to the coordinator on 2026-09-16 (`01M2MKCGZHEWM7JP7JTB0Z9T0F`
with the write-path addendum `01M2MKFBTQ0J5HRT31EC8XFWH1`); it is not
accepted yet, so this task is in investigation only. The plan holds the
design and the per-repository stage answers as they arrive:
`docs/plan/20260916-0757-system-status-site.md`.

Not to be implemented before acceptance, and in any case after phase 1 of the
mirror, which is authorised and waiting on `WRITE_TOKEN`.

## ActiveForm

Collecting the per-repository stage answers for the status site

## Dependencies

- **blocked by**: a read-only cross-repository Actions credential; the run
  retention decision; the hostname decision
- **blocks**: (none)

## Notes

- Acceptance of the proposal, the credential and the retention decision are
  the three gates; the collector ships before any page, because the charts
  have no history to draw until it has run.
