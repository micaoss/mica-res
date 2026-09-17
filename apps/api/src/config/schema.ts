import { z } from "zod";

const RE_APP_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Single source of truth for env-derived config. Keep this file
 * focused on the *shape* — the runtime validators (single-user
 * password hash format, OIDC discovery, production sentinels) live in
 * sibling files under `apps/api/src/config/` and are orchestrated by
 * `apps/api/src/config.ts::loadConfig()`.
 *
 * Adding a new variable: declare it here, add a row to
 * `.env.example` (with a description comment so `gen-env-docs`
 * surfaces it), then run `bun run gen:env-docs` to refresh
 * `docs/reference/env-reference.md`. CI's `check:env-docs` will fail if either
 * side is forgotten.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  // Top-level directory for persistent data (DB, uploads, logs). The relative
  // `data/`-prefixed defaults of DB_PATH / LOG_FILE / FILE_STORAGE_LOCAL_ROOT
  // anchors them. When unset, data lives at `${LODE_DIR}/data` (under lode) or
  // `${ROOT_DIR}/data` (standalone) — LODE_DIR/ROOT_DIR are locators, DATA_DIR is
  // the dir itself. An absolute DB_PATH / LOG_FILE / FILE_STORAGE_LOCAL_ROOT wins.
  DATA_DIR: z.string().optional(),
  DB_PATH: z.string().default("data/db/app.db"),
  DB_ENCRYPTION: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  // Application slug — lowercase letters, digits, dashes. Used as the
  // backup filename prefix, localStorage namespace, etc.
  APP_NAME: z.string().regex(RE_APP_NAME, "APP_NAME must match /^[a-z][a-z0-9-]*$/").default("mica-res"),
  // Human-readable display name used in HTML title, TOTP issuer, etc.
  APP_DISPLAY_NAME: z.string().min(1).default("Mica Resources"),
  // URL prefix the app is mounted under. Empty (default) means the app is
  // served at root: SPA at "/" and API at "/api". When set, the value is
  // normalised so "app", "/app", and "/app/" all resolve to "/app".
  BASE_PATH: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FILE: z.string().default("data/logs/app.log"),
  // When true, write logs to stdout instead of LOG_FILE — preferred for
  // container deployments that capture stdout/stderr at the runtime level.
  LOG_TO_STDOUT: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  CORS_ORIGIN: z.string().optional(),

  // When true, honour the rightmost `X-Forwarded-For` entry (and, as a
  // fallback only, `X-Real-IP`) for client-IP resolution. Default is false:
  // forwarding headers are ignored and the connection peer IP is used.
  // Only enable behind a sanitising proxy that strips client-supplied
  // forwarding headers. `TRUSTED_PROXY_IPS` further restricts which hop
  // addresses are allowed to set those headers.
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

  // Comma-separated CIDR allow-list of proxy peer addresses. Forwarding
  // headers are honoured only when the immediate TCP peer matches one of
  // these ranges. Empty (default) means "any peer is trusted" — equivalent
  // to the pre-`TRUSTED_PROXY_IPS` behaviour. Recommended in production:
  // set this to the load-balancer / ingress subnet (e.g.
  // `10.0.0.0/8,fd00::/8`).
  TRUSTED_PROXY_IPS: z.string().default(""),

  // Opt-in flag for the experimental DEK-rotation flow. When false (default)
  // the rotation endpoints respond with 501 Not Implemented.
  ENABLE_EXPERIMENTAL_DEK_ROTATION: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

  // OAuth / OIDC is **runtime config**, not stored in the settings DB —
  // operators set these as env vars (or `OAUTH_ISSUER` + the discovery
  // cache) and the API reads them at boot. `seedSettingsFromEnv` does
  // mirror a subset into the settings table for the admin UI to display,
  // but the runtime path never reads from there.
  OAUTH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_ISSUER: z.string().url().optional(),
  OAUTH_AUTHORIZE_URL: z.string().url().optional(),
  OAUTH_TOKEN_URL: z.string().url().optional(),
  OAUTH_USERINFO_URL: z.string().url().optional(),
  OAUTH_PKCE: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  OAUTH_SCOPES: z.string().min(1).default("openid profile email"),
  OAUTH_GROUPS_CLAIM: z.string().min(1).optional(),

  SESSION_MAX_AGE: z.coerce.number().int().positive().default(86400),

  // Audit retention. 0 = keep forever (default). Otherwise the audit module
  // runs an hourly sweep that drops events older than this many days.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),

  // Attachment limits — apply to every upload-capable module (documents,
  // issues, …). Single source so per-file caps stay consistent.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_ATTACHMENTS_PER_RESOURCE: z.coerce.number().int().positive().default(20),
  // Total disk quota across all attachment tables. 0 = unlimited (default).
  // When set and an upload would push usage past this, the request returns
  // 413 PAYLOAD_TOO_LARGE.
  UPLOADS_TOTAL_BYTES: z.coerce.number().int().nonnegative().default(0),

  // Per-user caps on content creation, counted per resource (issue,
  // document, comment, attachment) in fixed windows stored in the database
  // so they survive a restart. The minute window bounds a burst; the hour
  // window bounds the sustained rate a burst limit alone would still allow.
  // Either at 0 disables that window.
  CREATE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().nonnegative().default(60),
  CREATE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().nonnegative().default(600),

  // Per-client cap on the raw API (`${BASE_PATH}/api/raw/*`), the bare surface
  // other services integrate with. Counted per IP in a one-minute window.
  // 0 = unlimited.
  RAW_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().nonnegative().default(120),
  // Resources to leave unthrottled, comma-separated (e.g. `attachment`).
  // Names are the singular collection names the limiter derives from the
  // route table — `issue`, `document`, `comment`, `attachment`, ...
  CREATE_RATE_LIMIT_EXEMPT: z.string().default("").transform(v => v.split(",").map(s => s.trim()).filter(Boolean)),

  // ─── File module ─────────────────────────────────────────────────────
  // Storage backend selector. Built-in: `local`. Downstream projects can
  // register additional drivers (e.g. `s3`, `azure-blob`) and switch by
  // changing this value — no fork of the file module required.
  FILE_STORAGE_DRIVER: z.string().min(1).default("local"),
  // On-disk root for the local driver. Resolved against the project root
  // when relative.
  FILE_STORAGE_LOCAL_ROOT: z.string().default("data/uploads/files"),
  // GC mode. `async` (default): `releaseReference` only decrements
  // `ref_count`; a background sweep deletes the blob + the `files` row
  // once a minute. `sync`: the foreground request also performs the
  // driver delete — used by tests and local-only deployments that want
  // immediate disk reclamation.
  FILE_GC_MODE: z.enum(["async", "sync"]).default("async"),
  // Sweep interval for the GC. Set to 0 to disable the periodic sweep
  // entirely (orphans accumulate; admin runs a manual sweep).
  FILE_GC_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  // When true and the active driver implements `presignDownload`, file
  // downloads 302 to a short-lived signed URL rather than streaming
  // through the API. Per-deployment toggle; setting false forces every
  // download to flow through the API (easier audit / firewall).
  FILE_PRESIGN_ENABLED: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  // TTL for signed URLs in seconds. Short by design: a leaked URL stays
  // valid only briefly; re-issuing requires the consumer permission hook
  // to pass again.
  FILE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // ─── Resource service ────────────────────────────────────────────────
  // Public URLs of the three hosts: the home page and API, the R2 custom
  // domain public bytes are downloaded from, and the S3 read endpoint.
  RES_HOME_URL: z.string().url().default("https://res.micaos.dev"),
  RES_DOWNLOAD_URL: z.string().url().default("https://dl.res.micaos.dev"),
  RES_S3_URL: z.string().url().default("https://s3.res.micaos.dev"),
  // Bucket names behind the RES_PUBLIC and RES_PROTECT bindings. Only the
  // public bucket has a custom domain.
  RES_PUBLIC_BUCKET: z.string().min(1).default("res-micaos-dev"),
  RES_PROTECT_BUCKET: z.string().min(1).default("protect-res-micaos-dev"),
  // R2's S3 API, for the two operations a binding cannot do: server-side copy
  // and presigned URLs. Scope the token to the res buckets. Optional: without
  // them copies stream binding-to-binding, uploads come through this service
  // and protected downloads are streamed (see docs/modules/resource.md).
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Overrides `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
  R2_S3_ENDPOINT: z.string().url().optional(),
  // Zone and token for purging download URLs from the CDN after a replace,
  // a cache policy change or a delete. Without them purges are skipped.
  CF_ZONE_ID: z.string().min(1).optional(),
  CF_PURGE_TOKEN: z.string().min(1).optional(),
  // 32 random bytes, base64. Seals access-key secrets at rest; required to
  // create access keys for protected namespaces.
  RES_KEY_KEK: z.string().min(1).optional(),
  // Seconds between a delete and the removal of the bytes.
  RES_DELETE_GRACE_SECONDS: z.coerce.number().int().min(60).default(604800),
  // Lifetime of a presigned upload URL.
  RES_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),
  // Upper bound for a signed download URL minted for a protected object.
  RES_SIGNED_URL_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),

  DEFAULT_ADMIN: z.string().default(""),

  // ─── Single-user mode (OAuth bypass) ─────────────────────────────────
  // When true the app stops requiring an OIDC provider and authenticates
  // against the SINGLE_USER_USERNAME / SINGLE_USER_PASSWORD_HASH pair set
  // here. Registration and password change are not exposed. Generate the
  // hash with `bun run hash-password`.
  SINGLE_USER_MODE: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  SINGLE_USER_USERNAME: z.string().min(1).optional(),
  // Inline hash. Bun dotenv expands `$VAR` (even in single quotes), so the
  // `$` separators in argon2id / bcrypt / pbkdf2 hashes must be escaped.
  // Prefer SINGLE_USER_PASSWORD_HASH_FILE for the common case — that path
  // avoids the dotenv parser entirely.
  SINGLE_USER_PASSWORD_HASH: z.string().min(1).optional(),
  // Path to a file containing the hash. First non-blank line wins. If the
  // line is in htpasswd `user:hash` form, the prefix up to and including
  // the first `:` is stripped — so `htpasswd -B -n admin > file` works
  // without any post-processing.
  SINGLE_USER_PASSWORD_HASH_FILE: z.string().min(1).optional(),
  SINGLE_USER_NAME: z.string().min(1).optional(),
  SINGLE_USER_EMAIL: z.string().email().optional(),

  APP_URL: z.string().url().optional(),
  OIDC_LOGOUT_URL: z.string().url().optional(),

  // Bearer tokens for non-interactive tooling. Each scope is independent so
  // a leaked metrics scraper credential cannot also dump the database.
  // Constant-time compare; min length forces a real value.
  SERVICE_TOKEN_METRICS: z.string().min(32).optional(),
  SERVICE_TOKEN_BACKUP: z.string().min(32).optional(),

  // Minimum seconds between consecutive successful
  // `/api/backup/export-via-token` calls. Throttles a leaked backup token
  // from being turned into a DOS lever (repeated full-DB reads amplify
  // WAL pressure). Default 300s = 5 minutes; pair with a per-token
  // in-flight semaphore enforced at the route layer.
  BACKUP_EXPORT_MIN_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(300),

  // Optional file containing the master password. When set, the unlock
  // helper reads the first non-blank line, performs an
  // `/api/encryption/unlock` POST against `127.0.0.1:${PORT}`, and the
  // file is **deleted** immediately on success so a subsequent operator
  // process or backup snapshot cannot recover it. Mode must be 0600. Use
  // it for unattended container restarts (autoscaling, node drain)
  // where typing a password is not an option.
  MASTER_PASSWORD_FILE: z.string().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;
