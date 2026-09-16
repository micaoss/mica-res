import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "@/db";
import { protectedRoutes, publicRoutes } from "@/routes";
import { rateLimits } from "@/shared/schema";
import { creationRateLimit, discoverCreationRoutes } from "./creation-rate-limit";

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "creation-rate-limit-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Limits {
  perMinute: number;
  perHour: number;
  exempt?: string[];
}

/**
 * A stand-in router shaped like the real ones: a collection answers GET and
 * POST, an action answers POST alone.
 */
function buildApp(limits: Limits, userId: string | null = "user-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", {
      CREATE_RATE_LIMIT_PER_MINUTE: limits.perMinute,
      CREATE_RATE_LIMIT_PER_HOUR: limits.perHour,
      CREATE_RATE_LIMIT_EXEMPT: limits.exempt ?? [],
    } as unknown as AppEnv["Variables"]["config"]);
    if (userId !== null)
      c.set("user", { id: userId } as unknown as NonNullable<AppEnv["Variables"]["user"]>);
    await next();
  });
  app.use("*", creationRateLimit({ app }));

  app.get("/issues", c => c.json([]));
  app.post("/issues", c => c.json({ ok: true }, 201));
  app.get("/documents", c => c.json([]));
  app.post("/documents", c => c.json({ ok: true }, 201));
  app.get("/issues/:id/attachments", c => c.json([]));
  app.post("/issues/:id/attachments", c => c.json({ ok: true }, 201));
  // Action, not a collection: no GET on the same path.
  app.post("/issues/:id/close", c => c.json({ ok: true }, 200));
  return app;
}

function post(app: Hono<AppEnv>, path = "/issues") {
  return app.request(path, { method: "POST" });
}

async function counter(key: string) {
  return await db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
}

describe("discoverCreationRoutes", () => {
  test("picks collection POSTs and ignores actions", () => {
    const found = discoverCreationRoutes(buildApp({ perMinute: 1, perHour: 0 }));
    expect(found.map(f => f.resource).sort()).toEqual(["attachment", "document", "issue"]);
  });

  test("honours the mount prefix", () => {
    const found = discoverCreationRoutes(buildApp({ perMinute: 1, perHour: 0 }), "/app/api");
    const issues = found.find(f => f.resource === "issue")!;
    expect(issues.regex.test("/app/api/issues")).toBe(true);
    expect(issues.regex.test("/issues")).toBe(false);
  });

  /**
   * Pins what the real router exposes. The limiter derives this set instead
   * of being wired route by route, so a route entering or leaving it is a
   * decision that should be made deliberately, not noticed in production.
   */
  test("the live route table yields exactly the creating resources", () => {
    const app = new Hono<AppEnv>();
    app.route("/", publicRoutes());
    app.route("/", protectedRoutes());

    const resources = [...new Set(discoverCreationRoutes(app).map(f => f.resource))].sort();
    expect(resources).toEqual([
      "attachment",
      "comment",
      "document",
      "group",
      "issue",
      "job",
      "member",
      "resource-group",
      "share",
      "totp",
      "tuple",
    ]);
  });
});

describe("creationRateLimit — minute window", () => {
  test("allows up to the cap, then answers 429 with Retry-After", async () => {
    const app = buildApp({ perMinute: 3, perHour: 0 });
    for (let i = 0; i < 3; i++)
      expect((await post(app)).status).toBe(201);

    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("an elapsed window starts a fresh count", async () => {
    const app = buildApp({ perMinute: 1, perHour: 0 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);

    await db.update(rateLimits).set({ resetAt: Date.now() - 1 }).where(eq(rateLimits.key, "issue:minute:user-1"));

    expect((await post(app)).status).toBe(201);
    expect((await counter("issue:minute:user-1"))?.count).toBe(1);
  });
});

describe("creationRateLimit — hour window", () => {
  test("caps the sustained rate the minute window alone would allow", async () => {
    const app = buildApp({ perMinute: 100, perHour: 3 });
    for (let i = 0; i < 3; i++)
      expect((await post(app)).status).toBe(201);

    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(60);
  });

  test("both windows advance together and rejected requests keep counting", async () => {
    const app = buildApp({ perMinute: 2, perHour: 10 });
    for (let i = 0; i < 5; i++)
      await post(app);

    // 2 accepted, 3 rejected by the minute window — all 5 charged to the
    // hour window, so sustained abuse escalates instead of settling in.
    expect((await counter("issue:minute:user-1"))?.count).toBe(5);
    expect((await counter("issue:hour:user-1"))?.count).toBe(5);
  });
});

describe("creationRateLimit — scoping", () => {
  test("each resource drains its own budget", async () => {
    const app = buildApp({ perMinute: 1, perHour: 0 });
    expect((await post(app, "/issues")).status).toBe(201);
    expect((await post(app, "/issues")).status).toBe(429);
    // A spent issue budget must not block creating a document.
    expect((await post(app, "/documents")).status).toBe(201);
    expect((await post(app, "/issues/abc/attachments")).status).toBe(201);
  });

  test("each user drains their own budget", async () => {
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "alice"))).status).toBe(201);
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "alice"))).status).toBe(429);
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "bob"))).status).toBe(201);
  });

  test("the counter survives a new app instance — the state is in the database", async () => {
    for (let i = 0; i < 3; i++)
      await post(buildApp({ perMinute: 3, perHour: 0 }));
    // A fresh instance stands in for a restarted process or a re-created
    // Durable Object: an in-memory limiter would have forgotten the window.
    expect((await post(buildApp({ perMinute: 3, perHour: 0 }))).status).toBe(429);
  });

  test("an action route is not a create and is never counted", async () => {
    const app = buildApp({ perMinute: 1, perHour: 1 });
    for (let i = 0; i < 5; i++)
      expect((await post(app, "/issues/abc/close")).status).toBe(200);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });
});

describe("creationRateLimit — escape hatches", () => {
  test("an exempt resource is skipped while the others stay limited", async () => {
    const app = buildApp({ perMinute: 1, perHour: 0, exempt: ["issue"] });
    for (let i = 0; i < 3; i++)
      expect((await post(app, "/issues")).status).toBe(201);
    expect(await counter("issue:minute:user-1")).toBeUndefined();

    expect((await post(app, "/documents")).status).toBe(201);
    expect((await post(app, "/documents")).status).toBe(429);
  });

  test("both caps at 0 disable the gate and write nothing", async () => {
    const app = buildApp({ perMinute: 0, perHour: 0 });
    for (let i = 0; i < 5; i++)
      expect((await post(app)).status).toBe(201);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });

  test("one window at 0 leaves the other enforced", async () => {
    const app = buildApp({ perMinute: 0, perHour: 2 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);
    expect(await counter("issue:minute:user-1")).toBeUndefined();
  });

  test("an unauthenticated request is passed through to the auth layer", async () => {
    const app = buildApp({ perMinute: 1, perHour: 1 }, null);
    expect((await post(app)).status).toBe(201);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });
});

describe("creationRateLimit — concurrency", () => {
  test("concurrent requests cannot lose an increment in either window", async () => {
    const app = buildApp({ perMinute: 100, perHour: 100 });
    await Promise.all(Array.from({ length: 20 }, () => post(app)));
    expect((await counter("issue:minute:user-1"))?.count).toBe(20);
    expect((await counter("issue:hour:user-1"))?.count).toBe(20);
  });
});
