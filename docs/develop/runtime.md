# Runtimes

The app runs on **Bun** by default and on **Cloudflare Workers** as a
selectable second target. Both run the same modules, routes, schema and
tests. Nothing in a module knows which host it is on.

## The seam

`apps/api/src/platform/` defines the narrow contract the app needs from its
host. Module code reaches it through `getPlatform()` and never touches
`Bun.*`, `node:fs`, `setInterval` or a database driver directly.

| Seam | Bun | Cloudflare Workers |
| --- | --- | --- |
| `env` | `Bun.env` | Worker bindings (`vars` + secrets) |
| `kv` | in-process `Map` per namespace, TTL swept by one `unref()`'d timer | same, inside the Durable Object |
| `scheduler` | `setTimeout` + `setInterval`, non-overlapping | Durable Object alarm, multiplexed onto one slot |
| `openDatabase` | libsql file (`db/bun.ts`) | Durable Object SQLite (`workers/db.ts`) |
| `capabilities` | everything | see the table below |

The adapter is installed once at startup: `src/index.ts` on Bun,
`src/workers/entry.ts` on Workers. Tests can install a fake with
`setPlatform()`.

## Capabilities

A runtime declares what it can do; the app refuses configuration it cannot
honour rather than failing later at request time.

| Capability | Bun | Workers | Enforced at |
| --- | --- | --- | --- |
| `encryptionAtRest` | yes | no | boot — `DB_ENCRYPTION=true` is rejected |
| `argon2` | yes | no | boot and login — use a `pbkdf2-sha256` hash |
| `subprocess` | yes | no | the cron `shell` action throws |
| `filesystem` | yes | no | static assets, file logs and the OIDC discovery cache fall back |
| `residentTimers` | yes | no | boot — `CRON_ENABLED=true` is rejected |

Workers-specific consequences:

- **Database encryption** is the host's job. Durable Object storage is
  encrypted by Cloudflare; libsql's page-level encryption has no counterpart
  and the `meta.db` / DEK rotation machinery is Bun-only.
- **Passwords** must be `pbkdf2-sha256`. `Bun.password`'s argon2 and bcrypt
  verification has no WebCrypto equivalent.
- **Logs** go to the console as JSON, which is what `wrangler tail` reads.
- **The SPA** is served by Cloudflare's asset pipeline, not by the app's
  static middleware.
- **Scheduled jobs** do not run in-process. See below.
- **Rate limits that matter survive eviction.** The per-user creation cap is
  stored in the `rate_limits` table precisely because an in-memory window
  could be reset by pacing requests around an eviction. The in-memory,
  IP-keyed limiters keep short windows only, where the reset is not worth
  exploiting.
- **In-flight OAuth logins** are more fragile. The PKCE verifier is sealed
  with a key held in memory and never persisted, so a login that spans an
  eviction fails with `oauth_state_invalid` and the user retries. On Bun the
  same thing happens across a restart; it is just rarer there.

## Why Durable Objects and not D1

D1 was the obvious first choice and is the wrong one for this codebase.

- D1 runs in auto-commit. `BEGIN` / `COMMIT` are not available through the
  Worker API, and its only atomic unit is a static `batch()`. This app opens
  an interactive transaction in 20+ places, several of which read before they
  write (policy tuple rewrites, backup restore, file reference counting).
  Those cannot be expressed as a batch without losing rollback.
- Every D1 query is a network round trip. The policy engine walks relation
  tuples recursively, so a single authorized request can issue dozens of
  small queries — the pathological shape for a remote database.

A Durable Object owns its SQLite file locally: queries are in-process, and
`storage.transaction()` accepts an async callback and rolls back when it
rejects (verified in `tests/workers/smoke.ts`). The whole app lives in one
object named `app`, which keeps the same single-writer, single-memory-space
model the Bun process has — so the in-memory rate-limit buckets, step-up
tokens and per-request policy cache stay correct.

The trade-off is a single instance in a single location, with 10 GB of
storage and a 2 MB row ceiling. Blob content goes to R2, so the row limit
does not bind; throughput is bounded by one object's sequential execution.

### Cost shape

Row pricing is identical to D1 (25 billion reads and 50 million writes
included per month on the paid plan, then $0.001 per million rows read and
$1.00 per million rows written). Stored data is cheaper than D1 — $0.20 per
GB-month against $0.75, with the first 5 GB included. The difference is that
Durable Objects also bill compute duration: 400,000 GB-s are included per
month, and a 128 MB object held in memory for an entire 30-day month costs
about 332,000 GB-s, so a continuously warm single-instance deployment fits
inside the included allowance. Request billing is $0.15 per million after the
first million.

## Scheduled jobs on Workers

The cron module delegates scheduling to cronbake, which arms a timer per job
and assumes the process stays resident. A Durable Object is evicted when it
goes idle and only an alarm wakes it, so those timers would stop without an
error and jobs would silently never run. `CRON_ENABLED=true` is therefore
rejected at boot on Workers — the `residentTimers` capability is what that
check reads.

The job catalog, history and routes all still work; only the in-process
ticker is absent. Drive jobs from outside instead: point a Cloudflare Cron
Trigger (or any external scheduler) at

```
POST /api/cron/jobs/:id/trigger
```

which executes a job without the in-process scheduler and records the run in
the same history. The route is admin-only.

The app's own background sweeps — file GC and audit retention — are
unaffected: they go through the `scheduler` seam, which is backed by the
Durable Object alarm and survives eviction.

## Running on Workers

```bash
bun run --filter @app/web build      # the asset pipeline serves apps/web/dist
cd apps/api
cp .dev.vars.example .dev.vars       # local secrets, gitignored
bun run workers:dev                  # workerd via wrangler
bun run workers:build                # bundle only, no deploy
bun run workers:deploy               # wrangler deploy
```

Configuration lives in `apps/api/wrangler.toml`: the Durable Object binding
and its SQLite migration tag, the R2 bucket for blobs, the asset directory,
and the non-secret `vars`. Real secrets go through `wrangler secret put`.

Migrations are bundled into `src/db/migrations.generated.ts` because a Worker
has no filesystem to read `drizzle/` from. `bun run db:generate` regenerates
both; `bun run db:check-migrations` fails when the committed bundle is stale,
and CI runs it.

`bun run test:workers` boots the Worker in workerd and exercises boot,
login, transaction commit, transaction rollback and an R2 round trip. Pass
`--url https://…` to run the same suite against a deployment; the `workers`
workflow does that against a preview version when the repository has
Cloudflare credentials.
