# Modules

Per-module functional reference. Each file describes what a module does, the
HTTP routes it owns, the database tables it owns, and how its features are
configured. For *how to add a module* or *how the module system works in
general*, see [`../develop/module/`](../develop/module/).

## Reference modules (template surface)

These ship with the template and are owned by upstream — keep them in sync
when you merge from upstream. See
[`../develop/forking.md`](../develop/forking.md) § "Template surface vs your
application".

| Module | Page |
|---|---|
| `account` (users, auth, groups, TOTP, single-user mode) | [account.md](account.md) |
| `audit` (event log + retention sweep) | [audit.md](audit.md) |
| `backup` (export / restore + DEK proof) | [backup.md](backup.md) |
| `encryption` (ECIES at-rest, master/dek, unlock) | [encryption.md](encryption.md) |
| `file` (storage drivers + ref-counted GC) | [file.md](file.md) |
| `resource` (namespaces, R2 objects, catalog, edge, S3, access keys) | [resource.md](resource.md) |
| `policy` (Zanzibar tuples + access rules) | [policy.md](policy.md) |
| `settings` (per-key DB-backed settings + admin UI) | [settings.md](settings.md) |
| `system` (health, version, build info) | [system.md](system.md) |

