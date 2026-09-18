#!/usr/bin/env bun
/**
 * Cloudflare Workers smoke test.
 *
 * Boots the app the way it actually runs on Cloudflare — one Durable
 * Object owning a SQLite database, R2 for blobs — and drives the paths
 * whose behaviour differs from Bun:
 *
 *   1. boot          — migrations run inside the Durable Object
 *   2. writes        — create, update and delete through the Durable Object
 *                      driver, whose results differ from libsql's (see
 *                      `workers/db.ts`); rollback is covered by its unit test
 *   3. rate limiting — the creation limit is stored in the database
 *
 * With `--oidc` it checks a deployment configured for OpenID Connect
 * instead. Such a deployment has no local password to log in with — the SPA
 * offers one login method or the other — so the authenticated cases are
 * replaced by ones that prove the provider wiring: the app reports an
 * OAuth-configured mode, and starting a login redirects to the issuer
 * carrying a PKCE challenge.
 *
 * Usage:
 *   bun tests/workers/smoke.ts                 # spawns `wrangler dev`
 *   bun tests/workers/smoke.ts --url https://… # runs against a deployment
 *   bun tests/workers/smoke.ts --url … --oidc  # OIDC deployment
 */
import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

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
      const res = await call("/admin/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
      const body = await json<{ status: string }>(res);
      assert(body.status === "ok", `health status was ${body.status}`);
    },
  },
  {
    name: "single-user login issues a session",
    async run() {
      const res = await call("/admin/api/account/auth/login-local", {
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
    name: "group create commits and reads back",
    async run() {
      const res = await call("/admin/api/account/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `smoke-${Date.now()}`, description: "written on workers" }),
      });
      if (res.status !== 201)
        throw new SmokeError(`create returned ${res.status}: ${await res.text()}`);
      const created = await json<{ data: { id: string; name: string } }>(res);

      const read = await call(`/admin/api/account/groups/${created.data.id}`);
      assert(read.status === 200, `read-back returned ${read.status}`);
      const group = await json<{ data: { name: string; description: string | null } }>(read);
      assert(group.data.name === created.data.name, "group name did not round-trip");
      assert(group.data.description === "written on workers", "group description did not round-trip");
    },
  },
  {
    // On Workers the Durable Object driver's run() returned nothing, and
    // every update that read `rowsAffected` off it threw.
    name: "editing and deleting a group commit",
    async run() {
      const created = await json<{ data: { id: string } }>(
        await call("/admin/api/account/groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `smoke-edit-${Date.now()}` }),
        }),
      );
      const { id } = created.data;

      const edit = await call(`/admin/api/account/groups/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "edited" }),
      });
      if (edit.status !== 200)
        throw new SmokeError(`edit returned ${edit.status}: ${await edit.text()}`);
      await edit.text();

      const del = await call(`/admin/api/account/groups/${id}`, { method: "DELETE" });
      if (del.status >= 300)
        throw new SmokeError(`delete returned ${del.status}: ${await del.text()}`);
      await del.text();

      const gone = await call(`/admin/api/account/groups/${id}`);
      assert(gone.status === 404, `a deleted group still answers ${gone.status}`);
      await gone.text();
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/admin/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    name: "a published catalog is served by the edge without the Durable Object",
    async run() {
      const publish = await call("/admin/api/res/catalog/publish", { method: "POST" });
      if (publish.status !== 200)
        throw new SmokeError(`publish returned ${publish.status}: ${await publish.text()}`);
      await publish.text();
      const site = await fetch(`${baseUrl}/.well-known/res.json`);
      assert(site.status === 200, `res.json returned ${site.status}`);
      const body = await json<{ namespaces: { name: string }[] }>(site);
      assert(body.namespaces.some(n => n.name === "mica"), "the seeded namespaces are missing from the catalog");
      const listing = await fetch(`${baseUrl}/mica/`, { headers: { accept: "application/json" } });
      assert(listing.status === 200, `the mica listing returned ${listing.status}`);
      await listing.text();
      const home = await fetch(`${baseUrl}/`);
      assert(home.status === 200 && (await home.text()).toLowerCase().includes("<!doctype html"), "the home page is not served");
    },
  },
  {
    // Runs last: it spends whatever creation budget the cases above left.
    name: "creation rate limit is enforced from the database",
    async run() {
      let limited: Response | undefined;
      for (let i = 0; i < 40; i++) {
        const res = await call("/admin/api/account/groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `burst-${Date.now()}-${i}` }),
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

const oidcCases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/admin/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/admin/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    name: "the SPA is served from the asset pipeline",
    async run() {
      const res = await call("/");
      assert(res.status === 200, `index returned ${res.status}`);
      const body = await res.text();
      assert(body.includes("<!doctype html") || body.includes("<!DOCTYPE html"), "index was not HTML");
    },
  },
  {
    // Asking the asset pipeline for index.html by name answers a redirect,
    // which the SPA turned into a loop between /admin/ and /admin/login.
    name: "an admin SPA route is served as the SPA, not redirected",
    async run() {
      const res = await fetch(`${baseUrl}/admin/login?redirect=%2Fadmin%2F`, { redirect: "manual" });
      assert(res.status === 200, `/admin/login returned ${res.status} ${res.headers.get("location") ?? ""}`);
      assert((await res.text()).toLowerCase().includes("<!doctype html"), "/admin/login was not HTML");
    },
  },
  {
    name: "login mode reports a configured OAuth provider",
    async run() {
      const res = await call("/admin/api/account/auth/mode");
      assert(res.status === 200, `mode returned ${res.status}`);
      const body = await json<{ data: { mode: string; oauthConfigured: boolean } }>(res);
      assert(body.data.mode === "oauth", `mode was '${body.data.mode}', so the SPA would not offer OAuth`);
      // False here means discovery did not resolve the endpoints at boot.
      assert(body.data.oauthConfigured, "the provider's endpoints are not configured");
    },
  },
  {
    name: "starting a login redirects to the issuer with a PKCE challenge",
    async run() {
      const res = await call("/admin/api/account/auth/login");
      assert(res.status === 302, `login returned ${res.status}, expected a redirect`);
      const location = res.headers.get("Location");
      assert(location !== null, "the redirect carried no Location");

      const target = new URL(location);
      const issuer = process.env.SMOKE_OAUTH_ISSUER;
      if (issuer)
        assert(target.host === new URL(issuer).host, `redirected to ${target.host}, not the issuer's host`);

      const clientId = process.env.SMOKE_OAUTH_CLIENT_ID;
      if (clientId)
        assert(target.searchParams.get("client_id") === clientId, "the redirect carried a different client_id");

      assert(target.searchParams.get("response_type") === "code", "response_type was not 'code'");
      assert(target.searchParams.get("code_challenge_method") === "S256", "PKCE is not in use: no S256 challenge method");
      assert((target.searchParams.get("code_challenge") ?? "").length > 0, "PKCE is not in use: the challenge is empty");
      assert(
        target.searchParams.get("redirect_uri") === `${baseUrl}/admin/api/account/auth/callback`,
        `redirect_uri was ${target.searchParams.get("redirect_uri")}, which the provider must have registered`,
      );
    },
  },
];

async function waitForBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/admin/api/health`);
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

  const suite = process.argv.includes("--oidc") ? oidcCases : cases;

  let failures = 0;
  try {
    await waitForBoot(120_000);
    for (const c of suite) {
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

  console.log(`\n${suite.length - failures}/${suite.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
