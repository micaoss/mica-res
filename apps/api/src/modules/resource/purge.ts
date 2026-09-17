import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { and, asc, eq, lt } from "drizzle-orm";
import { resPurges } from "./schema";

export type PurgeConfig = Pick<Config, "CF_ZONE_ID" | "CF_PURGE_TOKEN">;

const MAX_ATTEMPTS = 20;

/**
 * Work the CDN purge queue. Without a zone and token every entry is marked
 * `skipped` rather than left pending forever, and the admin UI shows it.
 */
export async function processPurges(db: AppDatabase, config: PurgeConfig, fetcher: typeof fetch = fetch, limit = 20): Promise<{ done: number; failed: number; skipped: number }> {
  const pending = await db.select().from(resPurges).where(and(eq(resPurges.state, "pending"), lt(resPurges.attempts, MAX_ATTEMPTS))).orderBy(asc(resPurges.createdAt)).limit(limit).all();
  const result = { done: 0, failed: 0, skipped: 0 };
  for (const entry of pending) {
    const at = new Date().toISOString();
    if (!config.CF_ZONE_ID || !config.CF_PURGE_TOKEN) {
      await db.update(resPurges).set({ state: "skipped", lastError: "CF_ZONE_ID or CF_PURGE_TOKEN is not set", updatedAt: at }).where(eq(resPurges.id, entry.id)).run();
      result.skipped++;
      continue;
    }
    try {
      const res = await fetcher(`https://api.cloudflare.com/client/v4/zones/${config.CF_ZONE_ID}/purge_cache`, {
        method: "POST",
        headers: { "authorization": `Bearer ${config.CF_PURGE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ files: JSON.parse(entry.urls) as string[] }),
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; errors?: { message?: string }[] };
      if (!res.ok || body.success !== true)
        throw new Error(body.errors?.map(e => e.message).join("; ") || `HTTP ${res.status}`);
      await db.update(resPurges).set({ state: "done", attempts: entry.attempts + 1, lastError: null, updatedAt: at }).where(eq(resPurges.id, entry.id)).run();
      result.done++;
    }
    catch (err) {
      await db.update(resPurges).set({ attempts: entry.attempts + 1, lastError: err instanceof Error ? err.message : String(err), updatedAt: at }).where(eq(resPurges.id, entry.id)).run();
      result.failed++;
    }
  }
  return result;
}

export async function retryPurge(db: AppDatabase, id: string): Promise<boolean> {
  const res = await db.update(resPurges).set({ state: "pending", attempts: 0, updatedAt: new Date().toISOString() }).where(eq(resPurges.id, id)).run();
  return res.rowsAffected > 0;
}
