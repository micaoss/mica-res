#!/usr/bin/env bun
/**
 * Compose the Worker's static assets: the home page SPA (apps/site) at the
 * root and the admin SPA (apps/web, built with BASE_PATH=/admin) under
 * /admin/. Both must be built first; this only copies.
 *
 *   bun run --filter @app/site build
 *   BASE_PATH=/admin bun run --filter @app/web build
 *   bun scripts/build-worker-assets.ts
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { consola } from "consola";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "dist/worker-assets");
const site = resolve(ROOT, "apps/site/dist");
const web = resolve(ROOT, "apps/web/dist");

for (const [name, dir] of [["apps/site", site], ["apps/web", web]] as const) {
  if (!existsSync(resolve(dir, "index.html"))) {
    consola.error(`${name} is not built (${dir}/index.html is missing)`);
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(site, OUT, { recursive: true });
cpSync(web, resolve(OUT, "admin"), { recursive: true });
consola.success(`worker assets written to ${OUT}`);
