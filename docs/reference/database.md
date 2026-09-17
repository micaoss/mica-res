# Database

The API uses SQLite through Drizzle ORM. Table definitions live in each
module's own `apps/api/src/modules/<name>/schema.ts`;
`apps/api/src/db/schema.ts` is a re-export aggregator only and contains
no table definitions.

The single baseline migration `apps/api/drizzle/0000_*.sql` reflects the
shipped schema. `bun run --filter @app/api db:generate` regenerates it
from the source-of-truth schema files.

## Conventions

| Topic           | Current behavior                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Database        | SQLite (`libsql` driver, optional at-rest encryption)                                                            |
| ORM             | Drizzle ORM                                                                                                     |
| Time fields     | ISO 8601 strings (`text`)                                                                                       |
| Booleans        | SQLite integer booleans (Drizzle's `integer({ mode: "boolean" })`)                                              |
| ULIDs           | `items.id`, `files.id`, `audit_events.id` — 26-char Crockford base32 with millisecond timestamp prefix          |
| Nanoids         | `items.short_id`, `file_references.id`, `relation_tuples.id`, sub-type IDs — 8 chars from `[0-9a-z]`            |
| Soft delete     | `items.deleted_at` (NULL = live). Hard delete is a future janitor (retention policy).                            |

## Tables

### Account

#### `users`
Local account records created or updated from OAuth userinfo.

Key fields: `id`, `oauth_sub`, `username`, `name`, `email`, `avatar`,
`role`, `status`, `last_login_at`, `created_at`, `updated_at`.
Unique indexes on OAuth subject, username, email.

#### `groups`
Account groups used for membership and policy subjects.

Key fields: `id`, `name`, `description`, `created_at`, `updated_at`.

#### `sessions`
Server-side OAuth sessions.

Key fields: `id`, `user_id`, `access_token`, `refresh_token`,
`expires_at`, `created_at`, `updated_at`.

#### `pkce_challenges`
Temporary OAuth PKCE state. `state`, `code_verifier`, `redirect_uri`, `expires_at`.

#### `user_preferences`
Per-user key/value preferences. Primary key: `(user_id, key)`.

#### `user_totp_devices`
TOTP devices for users. `id`, `user_id`, `name`, `secret`, `verified`,
`last_used_timestep`, `created_at`.

#### `totp_challenges`
Login-time TOTP challenges. `id`, `user_id`, `access_token`,
`refresh_token`, `expires_in`, `redirect_uri`, `expires_at`.

#### `auth_lockouts`
Persisted per-key failure counter + lockout window. `key`, `failures`,
`locked_until` (epoch ms; NULL while tracking but not locked),
`updated_at`. Keyed by purpose: `single-user:<username-lower>` for
single-user login, `totp:<user-id>` for TOTP step-up. Persisted (not
in-memory) so brute-force counters survive restart and replicas.

### Audit

#### `audit_events`
Immutable audit log records.

`id`, `actor_id`, `actor_name`, `action`, `resource_type`, `resource_id`,
`resource_name`, `detail`, `ip`, `user_agent`, `result`, `created_at`.

`detail` is nullable (use when no structured payload makes sense); every
other column is `NOT NULL`.

### Settings

#### `settings`
Runtime settings stored by key. `key`, `value`, `updated_by`, `updated_at`.

### Policy (Zanzibar)

#### `relation_tuples`
Zanzibar-style relation tuples — the **single source of truth for every
access relationship** in this codebase (issue assignee, document
viewer / editor, document parent edges, group membership, …).

`id`, `namespace`, `object_id`, `relation`, `subject_namespace`,
`subject_id`, `subject_relation`, `created_by`, `created_at`.

`subject_relation` and `created_by` are nullable (system-issued tuples
have no creator; userset-style tuples leave `subject_relation` empty).

Indexes: `(namespace, object_id, relation)`, `(subject_namespace,
subject_id, subject_relation)`, plus a unique composite on the full
six-tuple key. SQLite treats `NULL` as distinct in `UNIQUE` indexes,
so service code performs a defensive duplicate check before insert.

### Files

#### `files`
Storage row per stored blob. Content-addressable: `UNIQUE(sha256,
storage_driver)` enables dedupe per backend.

| Column           | Notes                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`             | ULID PK.                                                                                                                    |
| `sha256`         | 64-char lowercase hex content key.                                                                                          |
| `size`           | Bytes.                                                                                                                      |
| `mimetype`       | Declared + magic-byte verified at upload.                                                                                    |
| `storage_driver` | `'local'`, `'s3'`, `'azure-blob'`, … (whatever drivers register).                                                            |
| `storage_key`    | Driver-internal address (local driver uses `<ab>/<cd>/<sha>`).                                                                |
| `ref_count`      | Materialised count of `file_references` rows. The async GC sweeper picks rows where `ref_count = 0` for collection.          |
| `uploaded_by`    | FK → `users.id ON DELETE CASCADE`. First uploader; informational only.                                                       |

Indexes: `UNIQUE(sha256, storage_driver)`, `(sha256)`, `(storage_driver)`, partial `(id) WHERE ref_count = 0` for the GC.

#### `file_references`
Reverse table. **Doubles as the attachment registry** for every
consumer — no separate `*_attachments` tables.

| Column        | Notes                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`          | nanoid PK. The id surfaced as the external attachment id in URLs.                                                     |
| `file_id`     | FK → `files.id ON DELETE RESTRICT`. Releases go through `FileService`, not raw cascade.                                |
| `owner_type`  | Discriminator: `'item_attachment'` (item-level), `'item_comment_attachment'` (per-comment), … one per consumer module. |
| `owner_id`    | Consumer-side primary key. For `item_attachment` → `items.id`; for `item_comment_attachment` → `item_comments.id`.    |
| `filename`    | Per-reference display filename.                                                                                       |
| `metadata`    | Opaque JSON ('{}' default).                                                                                           |
| `created_by`  | FK → `users.id`.                                                                                                      |
| `created_at`  | ISO.                                                                                                                  |

Indexes: `UNIQUE(owner_type, owner_id, file_id)` — same blob can only
appear once per owner; `(owner_type, owner_id)`, `(file_id)`.

### Resources

Owned by the `resource` module; see [modules/resource.md](../modules/resource.md#database).

| Table | Purpose |
|---|---|
| `res_stores` | Buckets: binding, bucket, visibility, download base URL. |
| `res_namespaces` | Top-level directories and their settings. |
| `res_objects` | Published keys: sha256, size, etag, content type, cache policy, meta, delete state. Partial unique index on `(namespace, path)` while `purged_at IS NULL`. |
| `res_aliases` | Mutable pointers inside a namespace. |
| `res_redirects` | Legacy `/d/` names to keys. |
| `res_oci_tags` | Registry tags to manifest digests. |
| `res_uploads` | Staged uploads. |
| `res_snapshots` | Catalog versions written. |
| `res_purges` | CDN purge queue. |
| `res_access_keys` | Access keys for protected namespaces (hashed and sealed secrets). |

### Shared infrastructure

Tables that no single module owns. They live in `apps/api/src/shared/schema.ts`
rather than under a module.

#### `rate_limits`
Fixed-window counters for the durable per-user limiter. `key`, `count`,
`reset_at` (epoch ms). `key` is `<resource>:<window>:<user-id>` — e.g.
`issue:minute:u_123`, `attachment:hour:u_123` — so each resource carries its
own budget in each window. The row is a checkpoint of a counter held in
memory, written only when its value would change a decision (see
`creation-quota.ts`), and overwritten in place on the next window — so
cardinality is bounded by users × resources × windows and no sweep is
needed. Excluded from backups, like `auth_lockouts` — transient
security state, not user data.

## Schema scope

The current schema covers: accounts (users / groups / group memberships /
sessions / TOTP / preferences / PKCE state / auth lockouts), audit,
settings, Zanzibar tuples, files + file references, and the shared
`rate_limits` counters.

Group membership lives in a dedicated `group_members` table owned by the
account module — separating it from `relation_tuples` lets a deployment
drop the policy module while keeping user-group features. The Zanzibar
engine reads `group:*#member` through that table; everything else still
hits `relation_tuples`.
