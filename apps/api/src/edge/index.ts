import type { R2Bucket } from "@cloudflare/workers-types";
import type { EdgeDeps } from "./http";
import type { ResStore } from "@/modules/resource/storage/types";
import { PROTECT_BINDING, PUBLIC_BINDING } from "@/modules/resource/resource.service";
import { createR2Store } from "@/modules/resource/storage/r2-store";
import { s3ClientFrom } from "@/modules/resource/storage/s3-client";
import { StoreUnavailableError } from "@/modules/resource/storage/types";
import { createCatalogReader } from "./catalog-reader";
import { handleResHost } from "./http";
import { handleS3Host } from "./s3";

export interface EdgeEnv {
  readonly RES_PUBLIC?: R2Bucket;
  readonly RES_PROTECT?: R2Bucket;
  readonly ASSETS?: { fetch: (request: Request) => Promise<Response> };
  readonly [key: string]: unknown;
}

function str(env: EdgeEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

let cached: { deps: EdgeDeps; s3Host: string } | undefined;

/** Built once per isolate: the bindings cannot change under a running version. */
function depsFor(env: EdgeEnv): { deps: EdgeDeps; s3Host: string } {
  if (cached)
    return cached;
  const s3 = s3ClientFrom({
    R2_ACCOUNT_ID: str(env, "R2_ACCOUNT_ID"),
    R2_ACCESS_KEY_ID: str(env, "R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: str(env, "R2_SECRET_ACCESS_KEY"),
    R2_S3_ENDPOINT: str(env, "R2_S3_ENDPOINT"),
  });
  const stores = new Map<string, ResStore>();
  const buckets: Record<string, [R2Bucket | undefined, string]> = {
    [PUBLIC_BINDING]: [env.RES_PUBLIC, str(env, "RES_PUBLIC_BUCKET") ?? "res-micaos-dev"],
    [PROTECT_BINDING]: [env.RES_PROTECT, str(env, "RES_PROTECT_BUCKET") ?? "protect-res-micaos-dev"],
  };
  for (const [binding, [bucket, name]] of Object.entries(buckets)) {
    if (bucket)
      stores.set(binding, createR2Store(name, bucket, s3));
  }
  const store = (binding: string): ResStore => {
    const found = stores.get(binding);
    if (!found)
      throw new StoreUnavailableError(`No bucket is bound as ${binding}`);
    return found;
  };
  const basePath = (str(env, "BASE_PATH") ?? "/admin").replace(/\/+$/, "");
  cached = {
    deps: {
      reader: createCatalogReader({ store, publicBinding: PUBLIC_BINDING, protectBinding: PROTECT_BINDING }),
      store,
      assets: env.ASSETS,
      kek: str(env, "RES_KEY_KEK"),
      adminBase: basePath.startsWith("/") ? basePath : `/${basePath}`,
    },
    s3Host: new URL(str(env, "RES_S3_URL") ?? "https://s3.res.micaos.dev").host,
  };
  return cached;
}

/**
 * The edge plane. Returns a response for every request it owns, or `null`
 * for the admin API, which the caller forwards to the Durable Object.
 */
export async function handleEdge(request: Request, env: EdgeEnv): Promise<Response | null> {
  const { deps, s3Host } = depsFor(env);
  if (new URL(request.url).host === s3Host)
    return handleS3Host(request, deps);
  return handleResHost(request, deps);
}
