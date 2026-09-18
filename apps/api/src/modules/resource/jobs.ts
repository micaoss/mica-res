import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { PlatformScheduler, ScheduledHandle } from "@/platform";
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
// The scheduler the task lives on. On Workers a Durable Object can be
// constructed again inside a warm isolate (a reset after a configuration
// change, an eviction): the new instance brings a new scheduler, and a task
// guarded only by "already started" would never be registered on it.
let scheduledOn: PlatformScheduler | undefined;
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
  const scheduler = getPlatform().scheduler;
  if (task && scheduledOn === scheduler)
    return;
  scheduledOn = scheduler;
  let lastAccessRefresh = 0;
  // On Workers the object is evicted when idle and an alarm wakes a fresh
  // instance, which registers this task again. A first-run delay would push
  // the task past the alarm that woke it, every time, and it would never
  // run; the object is fully booted before any event, so there is nothing
  // to wait for.
  const delayMs = getPlatform().name === "workers" ? 0 : FIRST_RUN_DELAY_MS;
  task = scheduler.every("resource-jobs", { delayMs, intervalMs: INTERVAL_MS }, async () => {
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
  scheduledOn = undefined;
  await t?.stop();
}
