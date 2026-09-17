import type { AppDeps } from "./app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __resetRateLimitForTests } from "@/shared/middleware/rate-limit";
import { buildOpenApp, buildOuterApp } from "./app";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

function config(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "test",
    TRUST_PROXY: false,
    BASE_PATH: "",
    APP_URL: "https://app.example.test",
    OPEN_API_RATE_LIMIT_PER_MINUTE: 100,
    ...overrides,
  } as unknown as Config;
}

function deps(cfg: Config): AppDeps {
  return {
    config: cfg,
    // No route under test touches the database.
    db: {} as AppDatabase,
    logger: noop,
    encryption: { isSystemLocked: () => false } as unknown as AppDeps["encryption"],
  };
}

/** The full outer composition: a stand-in `/api`, plus the open API. */
function buildApp(cfg: Config, openRoutes?: Hono<AppEnv>) {
  const api = new Hono<AppEnv>();
  api.get("/ping", c => c.json({ ok: true }));
  const open = openRoutes ? buildOpenApp(deps(cfg), openRoutes) : buildOpenApp(deps(cfg));
  return buildOuterApp(api, cfg, open);
}

const BROWSER_SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
];

beforeEach(async () => {
  await __resetRateLimitForTests();
});

describe("open API — headers", () => {
  test("carries none of the browser security headers", async () => {
    const res = await buildApp(config()).request("/open/health");
    expect(res.status).toBe(200);
    for (const header of BROWSER_SECURITY_HEADERS)
      expect(res.headers.get(header)).toBeNull();
  });

  test("the rest of the app keeps them — the exemption is scoped", async () => {
    const res = await buildApp(config()).request("/api/ping");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("a path that only starts with the prefix is not exempt", async () => {
    const res = await buildApp(config()).request("/openx");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  test("the prefix follows BASE_PATH", async () => {
    const app = buildApp(config({ BASE_PATH: "/app" }));
    const res = await app.request("/app/open/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("without a mounted open API the prefix gets the normal headers", async () => {
    // A locked deployment has no open API. The prefix must not become an
    // unprotected hole into whatever answers it instead.
    const api = new Hono<AppEnv>();
    const res = await buildOuterApp(api, config()).request("/open/health");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });
});

describe("open API — what is not applied", () => {
  test("a state-changing request needs no CSRF headers", async () => {
    const routes = new Hono<AppEnv>();
    routes.post("/echo", async c => c.json({ got: await c.req.json() }));

    // No Origin, no X-Requested-With: the `/api` guard would refuse this.
    const res = await buildApp(config(), routes).request("/open/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { hello: "world" } });
  });
});

describe("open API — rate limiting", () => {
  test("refuses a client past the per-minute cap, with Retry-After", async () => {
    const app = buildApp(config({ OPEN_API_RATE_LIMIT_PER_MINUTE: 2 }));
    expect((await app.request("/open/health")).status).toBe(200);
    expect((await app.request("/open/health")).status).toBe(200);

    const limited = await app.request("/open/health");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  test("unknown paths spend the same budget", async () => {
    const app = buildApp(config({ OPEN_API_RATE_LIMIT_PER_MINUTE: 1 }));
    expect((await app.request("/open/does-not-exist")).status).toBe(404);
    expect((await app.request("/open/health")).status).toBe(429);
  });

  test("a cap of 0 turns it off", async () => {
    const app = buildApp(config({ OPEN_API_RATE_LIMIT_PER_MINUTE: 0 }));
    for (let i = 0; i < 5; i++)
      expect((await app.request("/open/health")).status).toBe(200);
  });

  test("does not share its budget with /api", async () => {
    const app = buildApp(config({ OPEN_API_RATE_LIMIT_PER_MINUTE: 1 }));
    expect((await app.request("/open/health")).status).toBe(200);
    expect((await app.request("/open/health")).status).toBe(429);
    expect((await app.request("/api/ping")).status).toBe(200);
  });
});

describe("open API — plumbing", () => {
  test("an unknown path answers JSON 404, never the SPA", async () => {
    const res = await buildApp(config()).request("/open/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("echoes a request id to correlate with", async () => {
    const res = await buildApp(config()).request("/open/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("a failing route answers the JSON error shape", async () => {
    const routes = new Hono<AppEnv>();
    routes.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await buildApp(config(), routes).request("/open/boom");
    expect(res.status).toBe(500);
    expect((await res.json() as { success: boolean }).success).toBe(false);
  });
});
