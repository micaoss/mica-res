import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { ScheduledHandle } from "@/platform";
import type { Logger } from "@/shared/lib/logger";
import { getPlatform } from "@/platform";
import { publishAccessSnapshot } from "./access/keys";
import { isCatalogDirty, pruneSnapshots, republish } from "./publisher";
import { processPurges } from "./purge";
import { enqueuePurge, expireUploads, refreshStaleMetadata, sweepDeletedObjects } from "./resource.service";

const INTERVAL_MS = 60 * 1000;
const FIRST_RUN_DELAY_MS = 20 * 1000;
// The access snapshot carries expiry; republishing it hourly drops expired
// keys even when nothing else changed.
const ACCESS_REFRESH_MS = 60 * 60 * 1000;

let task: ScheduledHandle | undefined;
let currentDb: AppDatabase | undefined;

/** One pass of every background duty. Exported for tests and the admin UI. */
export async function runResourceJobs(db: AppDatabase, config: Config, logger: Logger, opts: { refreshAccess?: boolean } = {}): Promise<void> {
  const swept = await sweepDeletedObjects(db);
  const refreshed = await refreshStaleMetadata(db);
  await enqueuePurge(db, [...swept.urls, ...refreshed]);
  if (swept.purged > 0 || await isCatalogDirty(db))
    await republish(db, config, logger);
  const purges = await processPurges(db, config);
  const expired = await expireUploads(db);
  const pruned = await pruneSnapshots(db);
  if (opts.refreshAccess)
    await publishAccessSnapshot(db).catch(err => logger.warn({ err }, "access snapshot refresh failed"));
  if (swept.purged + refreshed.length + purges.done + purges.failed + expired + pruned > 0)
    logger.info({ purgedObjects: swept.purged, refreshedMetadata: refreshed.length, purges, expiredUploads: expired, prunedSnapshots: pruned }, "resource jobs");
}

export function startResourceJobs(db: AppDatabase, config: Config, logger: Logger): void {
  currentDb = db;
  if (task)
    return;
  let lastAccessRefresh = 0;
  task = getPlatform().scheduler.every("resource-jobs", { delayMs: FIRST_RUN_DELAY_MS, intervalMs: INTERVAL_MS }, async () => {
    const liveDb = currentDb;
    if (!liveDb)
      return;
    const refreshAccess = Date.now() - lastAccessRefresh >= ACCESS_REFRESH_MS;
    try {
      await runResourceJobs(liveDb, config, logger, { refreshAccess });
      if (refreshAccess)
        lastAccessRefresh = Date.now();
    }
    catch (err) {
      logger.error({ err }, "resource jobs failed");
    }
  });
}

export async function stopResourceJobs(): Promise<void> {
  const t = task;
  task = undefined;
  await t?.stop();
}
