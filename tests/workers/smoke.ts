#!/usr/bin/env bun
/**
 * Cloudflare Workers smoke test.
 *
 * Boots the app the way it actually runs on Cloudflare — one Durable
 * Object owning a SQLite database, R2 for blobs — and drives the paths
 * whose behaviour differs from Bun:
 *
 *   1. boot          — migrations run inside the Durable Object
 *   2. transactions  — `createDocument` wraps a multi-statement write, and
 *                      Durable Object transactions are async-callback based
 *                      (see `db/workers.ts`)
 *   3. R2 storage    — upload, then read the blob back through the API
 *   4. rate limiting — the platform key/value seam backs the limiter
 *
 * Usage:
 *   bun tests/workers/smoke.ts                 # spawns `wrangler dev`
 *   bun tests/workers/smoke.ts --url https://… # runs against a deployment
 */
import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";

// Local runs use the fixture in apps/api/.dev.vars.example. A run against a
// real deployment passes freshly generated credentials instead, so a
// publicly reachable URL never carries a password that is committed here.
const USERNAME = process.env.SMOKE_USERNAME ?? "smoke";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-test-password";
const PORT = 8787;

interface Case {
  name: string;
  run: () => Promise<void>;
}

class SmokeError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond)
    throw new SmokeError(msg);
}

let baseUrl = "";
let cookie = "";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // csrfGuard wants both an `X-Requested-With` header and a matching Origin
  // on state-changing requests; the SPA client sets the same pair.
  headers.set("Origin", baseUrl);
  headers.set("X-Requested-With", "XMLHttpRequest");
  if (cookie)
    headers.set("Cookie", cookie);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0)
    cookie = setCookie.map(c => c.split(";")[0]).join("; ");
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  }
  catch {
    throw new SmokeError(`expected JSON, got ${res.status}: ${text.slice(0, 300)}`);
  }
}

const cases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
      const body = await json<{ status: string }>(res);
      assert(body.status === "ok", `health status was ${body.status}`);
    },
  },
  {
    name: "single-user login issues a session",
    async run() {
      const res = await call("/api/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      if (res.status !== 200)
        throw new SmokeError(`login returned ${res.status}: ${await res.text()}`);
      assert(cookie !== "", "login did not set a session cookie");
    },
  },
  {
    name: "document create commits its transaction",
    async run() {
      const res = await call("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "smoke document", content: "written on workers", tags: ["smoke"] }),
      });
      if (res.status !== 201)
        throw new SmokeError(`create returned ${res.status}: ${await res.text()}`);
      const created = await json<{ data: { id: string; title: string } }>(res);
      const id = created.data.id;

      // Read it back: the transaction must have committed every statement,
      // including the tag rows written inside the same transaction.
      const read = await call(`/api/documents/${id}`);
      assert(read.status === 200, `read-back returned ${read.status}`);
      const doc = await json<{ data: { title: string; tags?: string[] } }>(read);
      assert(doc.data.title === "smoke document", "document title did not round-trip");
      assert(doc.data.tags?.includes("smoke") ?? false, "document tags did not round-trip");
    },
  },
  {
    name: "invalid document create rolls its transaction back",
    async run() {
      const before = await json<{ data: unknown[] }>(await call("/api/documents?limit=100"));
      const count = before.data.length;

      // `parentId` pointing at nothing is rejected after the handler has
      // begun writing, which is the rollback path.
      const res = await call("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "should not persist", parentId: "does-not-exist" }),
      });
      assert(res.status >= 400, `invalid create unexpectedly returned ${res.status}`);

      const after = await json<{ data: unknown[] }>(await call("/api/documents?limit=100"));
      assert(after.data.length === count, "a rejected create left a document behind");
    },
  },
  {
    name: "attachment upload round-trips through R2",
    async run() {
      const created = await json<{ data: { id: string } }>(
        await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "smoke attachment host" }),
        }),
      );
      const docId = created.data.id;

      const content = `workers smoke ${Date.now()}`;
      const form = new FormData();
      form.append("file", new Blob([content], { type: "text/plain" }), "smoke.txt");

      const res = await call(`/api/documents/${docId}/attachments`, { method: "POST", body: form });
      if (res.status !== 201 && res.status !== 200)
        throw new SmokeError(`upload returned ${res.status}: ${await res.text()}`);
      const uploaded = await json<{ data: { id: string; fileId?: string } }>(res);
      const ref = uploaded.data.id;

      // Reading it back pulls the blob out of R2 and streams it through the
      // Worker (the bucket binding cannot presign).
      const download = await call(`/api/files/${uploaded.data.fileId ?? ref}/content?ref=${ref}`);
      if (download.status !== 200)
        throw new SmokeError(`download returned ${download.status}: ${await download.text()}`);
      const got = await download.text();
      assert(got === content, "downloaded blob did not match the uploaded bytes");
    },
  },
  {
    // Runs last: it spends whatever creation budget the cases above left.
    name: "creation rate limit is enforced from the database",
    async run() {
      let limited: Response | undefined;
      for (let i = 0; i < 40; i++) {
        const res = await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `burst ${i}` }),
        });
        if (res.status === 429) {
          limited = res;
          break;
        }
        await res.text();
      }
      assert(limited !== undefined, "the creation limit never tripped");
      const body = await limited.json() as { error: { code: string } };
      assert(body.error.code === "RATE_LIMITED", `unexpected error code ${body.error.code}`);
      const retryAfter = Number(limited.headers.get("Retry-After"));
      assert(retryAfter > 0, "429 carried no usable Retry-After");
    },
  },
];

async function waitForBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok)
        return;
    }
    catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new SmokeError(`app did not become healthy within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const urlArg = process.argv.indexOf("--url");
  let dev: Subprocess | undefined;

  if (urlArg !== -1) {
    baseUrl = process.argv[urlArg + 1]?.replace(/\/+$/, "") ?? "";
    assert(baseUrl !== "", "--url needs a value");
  }
  else {
    baseUrl = `http://127.0.0.1:${PORT}`;
    // wrangler keeps the Durable Object's SQLite between runs. Start clean so
    // the run is deterministic: a regenerated baseline migration would
    // collide with the old schema, and the rate-limit case needs a fresh
    // creation budget.
    rmSync(new URL("../../apps/api/.wrangler/state", import.meta.url).pathname, {
      recursive: true,
      force: true,
    });
    dev = Bun.spawn(
      ["./node_modules/.bin/wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"],
      {
        cwd: new URL("../../apps/api", import.meta.url).pathname,
        env: {
          ...process.env,
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
        },
        stdout: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
        stderr: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
      },
    );
  }

  let failures = 0;
  try {
    await waitForBoot(120_000);
    for (const c of cases) {
      try {
        await c.run();
        console.log(`  ok    ${c.name}`);
      }
      catch (err) {
        failures++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  finally {
    dev?.kill();
  }

  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
