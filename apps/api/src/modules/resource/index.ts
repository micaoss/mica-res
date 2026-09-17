import type { R2Bucket } from "@cloudflare/workers-types";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { registerBackupContribution } from "@/modules/backup/registry";
import { registerTokenScope } from "@/shared/lib/token-scopes";
import { resourceBackupContribution } from "./resource.backup";
import { PROTECT_BINDING, PUBLIC_BINDING, seedResources } from "./resource.service";
import { createMemoryStore } from "./storage/memory-store";
import { createR2Store } from "./storage/r2-store";
import { hasStore, registerStore } from "./storage/registry";
import { s3ClientFrom } from "./storage/s3-client";
// Side-effect import: the namespace policy resource and its route bindings.
import "./resource.policy";

export { startResourceJobs, stopResourceJobs } from "./jobs";
export { resourceRoutes } from "./resource.routes";
export { s3ClientFrom } from "./storage/s3-client";

registerBackupContribution(resourceBackupContribution);

registerTokenScope({
  name: "res:publish",
  description: "Publish objects, uploads, aliases and registry tags into the namespaces the token's user may publish to. Cannot delete.",
  routes: [
    { method: "GET", path: "/res/namespaces" },
    { method: "GET", path: "/res/namespaces/:name" },
    { method: "GET", path: "/res/namespaces/:name/objects" },
    { method: "PUT", path: "/res/namespaces/:name/objects" },
    { method: "POST", path: "/res/namespaces/:name/batch" },
    { method: "POST", path: "/res/namespaces/:name/uploads" },
    { method: "PUT", path: "/res/uploads/:id/content" },
    { method: "POST", path: "/res/namespaces/:name/uploads/pull" },
    { method: "GET", path: "/res/namespaces/:name/aliases" },
    { method: "PUT", path: "/res/namespaces/:name/aliases" },
    { method: "PUT", path: "/res/namespaces/:name/oci-tags" },
  ],
});

registerTokenScope({
  name: "res:read",
  description: "List namespaces and objects.",
  routes: [
    { method: "GET", path: "/res/namespaces" },
    { method: "GET", path: "/res/namespaces/:name" },
    { method: "GET", path: "/res/namespaces/:name/objects" },
    { method: "GET", path: "/res/namespaces/:name/aliases" },
  ],
});

const bindings = new Map<string, R2Bucket>();

/** Called by the Workers entry with the R2 bindings before boot. */
export function registerResourceBindings(env: Record<string, unknown>): void {
  for (const name of [PUBLIC_BINDING, PROTECT_BINDING]) {
    const binding = env[name];
    if (binding && typeof binding === "object")
      bindings.set(name, binding as R2Bucket);
  }
}

/**
 * Register a store per bucket and seed the default stores and namespaces.
 * Without R2 bindings (Bun, local development) the buckets are in memory and
 * nothing survives a restart; the log says so.
 */
export async function initResourceModule(db: AppDatabase, config: Config, logger: Pick<Logger, "warn">): Promise<void> {
  const s3 = s3ClientFrom(config);
  const buckets: Record<string, string> = { [PUBLIC_BINDING]: config.RES_PUBLIC_BUCKET, [PROTECT_BINDING]: config.RES_PROTECT_BUCKET };
  const peers = new Map();
  for (const [binding, bucket] of Object.entries(buckets)) {
    if (hasStore(binding))
      continue;
    const r2 = bindings.get(binding);
    if (r2) {
      registerStore(binding, createR2Store(bucket, r2, s3));
    }
    else {
      logger.warn({ binding }, "no R2 binding; using an in-memory bucket that does not survive a restart");
      registerStore(binding, createMemoryStore(bucket, peers));
    }
  }
  if (bindings.size > 0 && !s3) {
    logger.warn(
      "R2 S3 credentials are not configured: copies stream binding-to-binding, uploads come through this service (about 95 MiB at most) and protected downloads are streamed rather than signed",
    );
  }
  await seedResources(db, config);
}
