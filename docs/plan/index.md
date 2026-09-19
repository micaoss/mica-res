# mica-res - Plan Index

> Updated: 2026-09-17

## Usage

Each plan is a single line linking to its detail file. All detailed information lives in `docs/plan/<timestamp>-<feature-slug>.md`.

### Format

A specimen, not an entry -- there is no such task and no such
detail file:

```markdown
- [ ] [**20260907-1440-add-endpoint Add endpoint**](20260907-1440-add-endpoint.md) `YYYY-MM-DD`
```

### Status Markers

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Draft / Pending review |
| `[-]`  | Approved / Implementing |
| `[x]`  | Completed |
| `[~]`  | Rejected / Abandoned |
| `[d]`  | Deleted detail file; index entry retained |

### Rules

- Only update the checkbox marker; never delete the line or change its other content. If the detail file is deleted, mark the entry `[d]`.
- Record change history and deletion reasons in `docs/changelog.md`; update affected task and plan references.
- New plans append to the end.
- See each `<timestamp>-<feature-slug>.md` for full details, except `[d]` entries whose files have been deleted; consult `docs/changelog.md` for their history.

---

## Plans

- [-] [**20260916-0728-r2-resource-service R2 resource service**](20260916-0728-r2-resource-service.md) `2026-09-16`
- [ ] [**20260916-0757-system-status-site System status site**](20260916-0757-system-status-site.md) `2026-09-16`
- [-] [**20260917-0852-public-resource-framework Public resource publishing framework**](20260917-0852-public-resource-framework.md) `2026-09-17`
