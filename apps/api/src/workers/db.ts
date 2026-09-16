import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AppDatabase } from "@/db/types";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "@/db/migrations.generated";
import * as schema from "@/db/schema";

/**
 * Open the Durable Object's embedded SQLite database.
 *
 * Why a Durable Object rather than D1: this API issues many small queries
 * per request (the policy engine walks relation tuples recursively), and it
 * relies on interactive read-then-write transactions in 20+ places. D1 is a
 * remote service in auto-commit mode — every query is a network round trip
 * and `BEGIN`/`COMMIT` are not available, so those call sites would have to
 * be rewritten as static batches and would lose rollback. A Durable Object
 * owns its SQLite file locally: queries are in-process and transactions are
 * real.
 *
 * Two seams need care here:
 *
 *  1. *Dialect.* drizzle's Durable Object driver is synchronous while the
 *     libsql driver is asynchronous, so the two database types are not
 *     structurally identical. Every call site in this codebase already
 *     `await`s its queries, and awaiting a synchronous result is a no-op,
 *     so the handle is cast once here instead of forking the type through
 *     the whole app. See `db/types.ts`.
 *
 *  2. *Transactions.* drizzle's Durable Object `transaction()` wraps
 *     `storage.transactionSync()`, which requires a synchronous callback —
 *     it commits as soon as the callback returns, so an `async` callback
 *     would commit at its first `await` and run the rest unprotected. This
 *     app's transaction bodies are all `async`, so `transaction()` is
 *     replaced below with the storage-level async transaction, which does
 *     accept a promise and rolls back when it rejects.
 */
export async function createWorkersDb(storage: DurableObjectStorage): Promise<AppDatabase> {
  const db = drizzle(storage, { schema });

  // Runs before the transaction override: drizzle's migrator drives
  // `db.transaction()` synchronously and calls `tx.rollback()` itself.
  await migrate(db, migrations);

  return Object.assign(db, {
    close: () => {},
    // Durability is the host's job; there is no WAL to fold in.
    checkpoint: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      storage.transaction(async () => fn(db)) as Promise<T>,
  }) as unknown as AppDatabase;
}
