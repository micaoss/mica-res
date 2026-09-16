import type { DurableObjectNamespace, DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { bootstrap } from "@/app";
import { setPlatform } from "@/platform";
import { createWorkersPlatform } from "./platform";
import { registerR2Driver } from "./r2";

/**
 * Cloudflare Workers entry point.
 *
 * The Worker itself holds no state: it forwards every request to a single
 * Durable Object instance that owns the SQLite database and runs the whole
 * Hono app. That keeps the deployment shaped like the Bun one — one
 * process, one database, in-process caches — rather than spreading state
 * across isolates.
 *
 * Static assets are served by the platform's asset pipeline (see
 * `wrangler.jsonc`), so the app's own filesystem-backed static middleware
 * stays disabled here.
 */

export interface WorkerEnv {
  /** Binding for the Durable Object class exported below. */
  APP: DurableObjectNamespace;
  /** Blob storage for the file module. Required when FILE_STORAGE_DRIVER=r2. */
  FILES?: R2Bucket;
  [key: string]: unknown;
}

type FetchHandler = (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;

export class AppDurableObject {
  readonly #state: DurableObjectState;
  #fetchApp: FetchHandler | undefined;
  #runDueTasks: (() => Promise<void>) | undefined;

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.#state = state;
    // Nothing is served until the platform is installed and migrations have
    // run: `blockConcurrencyWhile` holds every inbound event, including the
    // alarm, until boot resolves.
    void state.blockConcurrencyWhile(async () => {
      const { platform, runDueTasks } = createWorkersPlatform({
        env: env as Record<string, unknown>,
        storage: state.storage,
      });
      setPlatform(platform);
      if (env.FILES) {
        registerR2Driver(env.FILES);
      }
      const app = await bootstrap();
      this.#fetchApp = app.fetch;
      this.#runDueTasks = runDueTasks;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#fetchApp) {
      return new Response("Service starting", { status: 503 });
    }
    return this.#fetchApp(request, {});
  }

  /** Durable Object alarm: the Workers stand-in for the Bun sweep timers. */
  async alarm(): Promise<void> {
    await this.#runDueTasks?.();
  }

  /** Exposed for the deployed smoke test; see tests/workers. */
  get id(): string {
    return this.#state.id.toString();
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // One named instance: this app has a single database, so it has a
    // single object. Sharding would mean sharding the database too.
    const stub = env.APP.get(env.APP.idFromName("app"));
    return stub.fetch(request as never) as unknown as Response;
  },
};
