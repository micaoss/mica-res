import type { MemoryStore } from "./storage/memory-store";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { createApiToken } from "@/modules/account/tokens/tokens.service";
import { users } from "@/modules/account/users/schema";
import { policyMiddleware } from "@/modules/policy";
import { createTuple } from "@/modules/policy/policy.service";
import { protectedRoutes } from "@/routes/protected";
import { errorHandler } from "@/shared/middleware/error-handler";
import { CATALOG_POINTER_KEY } from "./catalog";
import { PROTECT_BINDING, PUBLIC_BINDING, seedResources } from "./resource.service";
import { createMemoryStore, seedMemoryObject } from "./storage/memory-store";
import { __resetStoresForTests, registerStore } from "./storage/registry";
import { sha256Hex } from "./storage/sigv4";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;
const config = {
  NODE_ENV: "test",
  TRUST_PROXY: false,
  BASE_PATH: "",
  RES_HOME_URL: "https://res.example.test",
  RES_DOWNLOAD_URL: "https://dl.example.test",
  RES_S3_URL: "https://s3.example.test",
  RES_PUBLIC_BUCKET: "res-public",
  RES_PROTECT_BUCKET: "res-protect",
  RES_DELETE_GRACE_SECONDS: 604800,
  RES_UPLOAD_TTL_SECONDS: 3600,
  RES_SIGNED_URL_MAX_TTL_SECONDS: 3600,
} as unknown as Config;

let db: AppDatabase;
let dir: string;
let publicStore: MemoryStore;
let protectStore: MemoryStore;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "resource-routes-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetStoresForTests();
  const peers = new Map<string, MemoryStore>();
  publicStore = createMemoryStore("res-public", peers);
  protectStore = createMemoryStore("res-protect", peers);
  registerStore(PUBLIC_BINDING, publicStore);
  registerStore(PROTECT_BINDING, protectStore);
  await seedResources(db, config);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(): Hono<AppEnv> {
  const root = new Hono<AppEnv>();
  root.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", noop);
    c.set("encryption", { isSystemLocked: () => false } as unknown as AppEnv["Variables"]["encryption"]);
    await next();
  });
  root.use("*", policyMiddleware({ basePath: "/api" }));
  root.route("/api", protectedRoutes());
  root.onError(errorHandler);
  return root;
}

async function user(role: "admin" | "user"): Promise<{ id: string; cookie: string }> {
  const id = `u${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  return { id, cookie: `session_id=${await createSession(db, id, "tok", undefined, 3600)}` };
}

function json(method: string, body: unknown, headers: Record<string, string>): RequestInit {
  return { method, body: JSON.stringify(body), headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", ...headers } };
}

async function stage(text: string): Promise<{ uploadId: string; sha256: string }> {
  const sha256 = await sha256Hex(text);
  const admin = await user("admin");
  const res = await app().request("/api/res/namespaces/brand/uploads", json("POST", { sha256, size: text.length, contentType: "text/plain" }, { cookie: admin.cookie }));
  const { data } = await res.json() as { data: { id: string; url: string } };
  await seedMemoryObject(protectStore, new URL(data.url).pathname.split("/").slice(2).join("/"), text, "text/plain");
  return { uploadId: data.id, sha256 };
}

describe("resource routes", () => {
  test("an admin publishes, and the catalog is written in the same request", async () => {
    const admin = await user("admin");
    const { uploadId } = await stage("hello");
    const res = await app().request("/api/res/namespaces/brand/objects", json("PUT", { path: "hello.txt", source: { uploadId } }, { cookie: admin.cookie }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { outcome: string; catalog: string } };
    expect(body.data).toMatchObject({ outcome: "created", catalog: "published" });
    expect(await publicStore.getText(CATALOG_POINTER_KEY)).not.toBeNull();
    const list = await app().request("/api/res/namespaces/brand/objects", { headers: { cookie: admin.cookie } });
    expect(((await list.json()) as { data: { url: string }[] }).data[0]!.url).toBe("https://dl.example.test/brand/hello.txt");
  });

  test("a non-admin needs a publisher tuple on the namespace", async () => {
    const member = await user("user");
    const { uploadId } = await stage("by member");
    const put = () => app().request("/api/res/namespaces/brand/objects", json("PUT", { path: "m.txt", source: { uploadId } }, { cookie: member.cookie }));
    expect((await put()).status).toBe(403);
    await createTuple(db, { namespace: "res_namespace", objectId: "brand", relation: "publisher", subjectNamespace: "user", subjectId: member.id }, member.id);
    expect((await put()).status).toBe(200);
    // Publishing into another namespace is still refused.
    expect((await app().request("/api/res/namespaces/status/objects", json("PUT", { path: "m.txt", source: { uploadId } }, { cookie: member.cookie }))).status).toBe(403);
    // Managing the namespace needs manager.
    expect((await app().request("/api/res/namespaces/brand", json("PATCH", { title: "x" }, { cookie: member.cookie }))).status).toBe(403);
  });

  test("an API token publishes within its scope but can never delete", async () => {
    const admin = await user("admin");
    const { token } = await createApiToken(db, admin.id, { name: "ci", scopes: ["res:publish"], expiresAt: null });
    const auth = { authorization: `Bearer ${token}` };
    const { uploadId } = await stage("from ci");
    expect((await app().request("/api/res/namespaces/brand/objects", json("PUT", { path: "ci.txt", source: { uploadId } }, auth))).status).toBe(200);
    expect((await app().request("/api/res/namespaces/brand/objects/delete", json("POST", { path: "ci.txt", reason: "x" }, auth))).status).toBe(403);
    expect((await app().request("/api/res/access-keys", { headers: auth })).status).toBe(403);
  });

  test("deleting is admin-only and returns a dry-run count without changing anything", async () => {
    const admin = await user("admin");
    const member = await user("user");
    const { uploadId } = await stage("deletable");
    await app().request("/api/res/namespaces/brand/objects", json("PUT", { path: "d/x.txt", source: { uploadId } }, { cookie: admin.cookie }));
    expect((await app().request("/api/res/namespaces/brand/objects/delete", json("POST", { prefix: "d/", reason: "x" }, { cookie: member.cookie }))).status).toBe(403);
    const dry = await app().request("/api/res/namespaces/brand/objects/delete", json("POST", { prefix: "d/", reason: "x", dryRun: true }, { cookie: admin.cookie }));
    expect(((await dry.json()) as { data: { count: number } }).data.count).toBe(1);
    const real = await app().request("/api/res/namespaces/brand/objects/delete", json("POST", { prefix: "d/", reason: "retired" }, { cookie: admin.cookie }));
    expect(((await real.json()) as { data: { count: number; catalog: string } }).data).toMatchObject({ count: 1, catalog: "published" });
  });

  test("an invalid namespace name and a reserved one are refused", async () => {
    const admin = await user("admin");
    for (const name of ["admin", "Bad"]) {
      const res = await app().request("/api/res/namespaces", json("POST", { name, store: "public", title: "x" }, { cookie: admin.cookie }));
      expect(res.status).toBe(422);
    }
  });
});
