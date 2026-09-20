import type { CatalogManifest, CatalogPointer, NamespaceShard } from "./catalog";
import type { MemoryStore } from "./storage/memory-store";
import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { ACCESS_SNAPSHOT_KEY, createAccessKey, grantsAllow, listAccessKeys, mintSignedUrl, openSecret, publishAccessSnapshot, revokeAccessKey, sealSecret, verifyUrlSignature } from "./access/keys";
import { CATALOG_POINTER_KEY } from "./catalog";
import { pruneSnapshots, publishCatalog } from "./publisher";
import { processPurges } from "./purge";
import {
  createNamespace,
  createUpload,
  deleteObjects,
  enqueuePurge,
  getLiveObject,
  listObjects,
  PROTECT_BINDING,
  PUBLIC_BINDING,
  publishObject,
  pullUpload,
  purgeNow,
  refreshStaleMetadata,
  restoreObject,
  seedResources,
  setAlias,
  setOciTag,
  sweepDeletedObjects,
  updateNamespace,
  writeUploadBody,
} from "./resource.service";
import { resObjects, resPurges } from "./schema";
import { createMemoryStore, seedMemoryObject } from "./storage/memory-store";
import { __resetStoresForTests, registerStore } from "./storage/registry";
import { sha256Hex } from "./storage/sigv4";

const config = {
  RES_HOME_URL: "https://res.example.test",
  RES_DOWNLOAD_URL: "https://dl.example.test",
  RES_S3_URL: "https://s3.example.test",
  RES_PUBLIC_BUCKET: "res-public",
  RES_PROTECT_BUCKET: "res-protect",
  RES_DELETE_GRACE_SECONDS: 604800,
  RES_UPLOAD_TTL_SECONDS: 3600,
  RES_SIGNED_URL_MAX_TTL_SECONDS: 3600,
  RES_KEY_KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  CF_ZONE_ID: undefined as string | undefined,
  CF_PURGE_TOKEN: undefined as string | undefined,
};

let db: AppDatabase;
let dir: string;
let publicStore: MemoryStore;
let protectStore: MemoryStore;
const actorId = "u_admin";

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "resource-svc-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetStoresForTests();
  const peers = new Map<string, MemoryStore>();
  publicStore = createMemoryStore(config.RES_PUBLIC_BUCKET, peers);
  protectStore = createMemoryStore(config.RES_PROTECT_BUCKET, peers);
  registerStore(PUBLIC_BINDING, publicStore);
  registerStore(PROTECT_BINDING, protectStore);
  await seedResources(db, config);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stage bytes the way an uploader would: presign, then PUT to the staging key. */
async function upload(text: string, contentType = "application/octet-stream"): Promise<{ id: string; sha256: string }> {
  const sha256 = await sha256Hex(text);
  const created = await createUpload(db, config, { sha256, size: new TextEncoder().encode(text).length, contentType, actorId });
  const stagingKey = new URL(created.url).pathname.split("/").slice(2).join("/");
  await seedMemoryObject(protectStore, stagingKey, text, contentType);
  return { id: created.id, sha256 };
}

describe("publishing", () => {
  test("an upload is copied to its key with the namespace cache policy and the staging bytes are dropped", async () => {
    const { id, sha256 } = await upload("image bytes");
    const result = await publishObject(db, { namespace: "mica", path: "uefi-x64/20260917-0000/x.img.gz", source: { kind: "upload", uploadId: id }, actorId });
    expect(result.outcome).toBe("created");
    const stored = publicStore.objects.get("mica/uefi-x64/20260917-0000/x.img.gz")!;
    expect(stored.info.sha256).toBe(sha256);
    expect(stored.info.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(stored.info.contentType).toBe("application/gzip");
    expect([...protectStore.objects.keys()].filter(k => k.startsWith("_staging/"))).toEqual([]);
  });

  test("an upload that was never completed is refused", async () => {
    const created = await createUpload(db, config, { sha256: "a".repeat(64), size: 3, contentType: "text/plain", actorId });
    await expect(publishObject(db, { namespace: "brand", path: "x.txt", source: { kind: "upload", uploadId: created.id }, actorId })).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
  });

  test("publishing the same bytes again is a no-op, and an immutable key refuses other bytes", async () => {
    const first = await upload("v1");
    await publishObject(db, { namespace: "mica", path: "a/b", source: { kind: "upload", uploadId: first.id }, actorId });
    const again = await publishObject(db, { namespace: "mica", path: "a/b", source: { kind: "sha256", sha256: first.sha256 }, actorId });
    expect(again.outcome).toBe("unchanged");
    const second = await upload("v2");
    await expect(publishObject(db, { namespace: "mica", path: "a/b", source: { kind: "upload", uploadId: second.id }, actorId })).rejects.toMatchObject({ code: "IMMUTABLE" });
  });

  test("replacing a mutable key asks for a CDN purge of its download URL", async () => {
    const first = await upload("logo v1");
    await publishObject(db, { namespace: "brand", path: "logo/icon.svg", source: { kind: "upload", uploadId: first.id }, actorId });
    const second = await upload("logo v2");
    const result = await publishObject(db, { namespace: "brand", path: "logo/icon.svg", source: { kind: "upload", uploadId: second.id }, actorId });
    expect(result.outcome).toBe("replaced");
    expect(result.purge).toEqual(["https://dl.example.test/brand/logo/icon.svg"]);
    expect(publicStore.objects.get("brand/logo/icon.svg")!.info.sha256).toBe(second.sha256);
  });

  test("bytes already in the store are copied by sha256 without an upload", async () => {
    const { id, sha256 } = await upload("shared");
    await publishObject(db, { namespace: "upstream", path: "source/a/a.tar", source: { kind: "upload", uploadId: id }, actorId });
    const copy = await publishObject(db, { namespace: "mica", path: "x/a.tar", source: { kind: "sha256", sha256 }, actorId });
    expect(copy.outcome).toBe("created");
    expect(publicStore.objects.get("mica/x/a.tar")!.info.sha256).toBe(sha256);
    await expect(publishObject(db, { namespace: "mica", path: "x/b", source: { kind: "sha256", sha256: "f".repeat(64) }, actorId })).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  test("an invalid path or namespace is refused before anything is written", async () => {
    await expect(publishObject(db, { namespace: "mica", path: "a/../b", source: { kind: "sha256", sha256: "a".repeat(64) }, actorId })).rejects.toMatchObject({ statusCode: 422 });
    await expect(publishObject(db, { namespace: "nope", path: "a", source: { kind: "sha256", sha256: "a".repeat(64) }, actorId })).rejects.toMatchObject({ statusCode: 404 });
  });

  test("a pull streams an https origin into staging and refuses wrong bytes", async () => {
    const body = "origin bytes";
    const sha256 = await sha256Hex(body);
    const fetcher = (async (url: string) => {
      if (url === "https://origin.test/redirect")
        return new Response(null, { status: 302, headers: { location: "https://origin.test/file" } });
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }) as unknown as typeof fetch;
    const pulled = await pullUpload(db, config, { origin: "https://origin.test/redirect", sha256, contentType: "application/octet-stream", actorId }, fetcher);
    const result = await publishObject(db, { namespace: "upstream", path: "source/o/o.bin", source: { kind: "upload", uploadId: pulled.id }, actorId });
    expect(result.object.size).toBe(body.length);
    await expect(pullUpload(db, config, { origin: "https://origin.test/file", sha256: "0".repeat(64), contentType: "x", actorId }, fetcher)).rejects.toMatchObject({ code: "SHA256_MISMATCH" });
    await expect(pullUpload(db, config, { origin: "http://origin.test/file", sha256, contentType: "x", actorId }, fetcher)).rejects.toMatchObject({ code: "ORIGIN_NOT_HTTPS" });
  });
});

describe("deletion", () => {
  test("a delete hides the object, keeps the bytes through the grace period, and a restore brings it back", async () => {
    const { id } = await upload("gone soon");
    await publishObject(db, { namespace: "mica", path: "a/1", source: { kind: "upload", uploadId: id }, actorId });
    const dry = await deleteObjects(db, config, { namespace: "mica", prefix: "a/", reason: "test", dryRun: true });
    expect(dry).toEqual({ count: 1, keys: ["mica/a/1"] });
    expect((await listObjects(db, "mica")).length).toBe(1);
    await deleteObjects(db, config, { namespace: "mica", path: "a/1", reason: "test" });
    expect(await listObjects(db, "mica")).toEqual([]);
    expect((await sweepDeletedObjects(db)).purged).toBe(0);
    expect(publicStore.objects.has("mica/a/1")).toBe(true);
    await restoreObject(db, "mica", "a/1");
    expect((await listObjects(db, "mica")).length).toBe(1);
  });

  test("after the grace period the sweeper deletes the bytes and returns the URL to purge", async () => {
    const { id } = await upload("purge me");
    await publishObject(db, { namespace: "brand", path: "old.png", source: { kind: "upload", uploadId: id }, actorId });
    await deleteObjects(db, config, { namespace: "brand", path: "old.png", reason: "retired" });
    await purgeNow(db, "brand", "old.png");
    await db.update(resObjects).set({ purgeAfter: new Date(Date.now() - 1000).toISOString() }).run();
    const swept = await sweepDeletedObjects(db);
    expect(swept).toEqual({ purged: 1, urls: ["https://dl.example.test/brand/old.png"] });
    expect(publicStore.objects.has("brand/old.png")).toBe(false);
    expect(await getLiveObject(db, "brand", "old.png")).toBeUndefined();
    // The key is free again for a new object.
    const next = await upload("new logo");
    expect((await publishObject(db, { namespace: "brand", path: "old.png", source: { kind: "upload", uploadId: next.id }, actorId })).outcome).toBe("created");
  });

  test("a namespace cache policy change marks objects stale and the refresh rewrites their cache-control", async () => {
    const { id } = await upload("doc");
    await publishObject(db, { namespace: "brand", path: "readme.txt", source: { kind: "upload", uploadId: id }, actorId });
    expect((await updateNamespace(db, "brand", { cachePolicy: "short" })).staleObjects).toBe(1);
    expect(await refreshStaleMetadata(db)).toEqual(["https://dl.example.test/brand/readme.txt"]);
    expect(publicStore.objects.get("brand/readme.txt")!.info.cacheControl).toBe("public, max-age=60, must-revalidate");
    expect(await refreshStaleMetadata(db)).toEqual([]);
  });
});

describe("catalog", () => {
  test("publishes shards, digests, redirects and tags, pointer last", async () => {
    await createNamespace(db, { name: "vault", store: "protect", title: "Vault" });
    const img = await upload("image");
    await publishObject(db, { namespace: "mica", path: "s/1/x.img", source: { kind: "upload", uploadId: img.id }, actorId });
    const manifestBytes = await upload("{\"schemaVersion\":2}");
    await publishObject(db, { namespace: "oci", path: `blobs/sha256/${manifestBytes.sha256}`, source: { kind: "upload", uploadId: manifestBytes.id }, contentType: "application/vnd.oci.image.index.v1+json", actorId });
    await setOciTag(db, { repository: "micaoss/mica-build-env", tag: "base.1", digest: `sha256:${manifestBytes.sha256}` });
    await setAlias(db, { namespace: "mica", path: "s/latest", targetPath: "s/1/x.img" });
    const secret = await upload("secret");
    await publishObject(db, { namespace: "vault", path: "p/key.bin", source: { kind: "upload", uploadId: secret.id }, actorId });

    const version = await publishCatalog(db, config);
    const pointer = JSON.parse((await publicStore.getText(CATALOG_POINTER_KEY))!) as CatalogPointer;
    expect(pointer.version).toBe(version);
    const manifest = JSON.parse((await publicStore.getText(pointer.manifest))!) as CatalogManifest;
    expect(manifest.registry).toEqual({ "micaoss/mica-build-env": { "base.1": `sha256:${manifestBytes.sha256}` } });
    expect(manifest.namespaces.map(n => n.name)).toEqual(["brand", "docs", "mica", "oci", "status", "upstream", "vault"]);
    const vault = manifest.namespaces.find(n => n.name === "vault")!;
    expect(await publicStore.getText(vault.shard)).toBeNull();
    const vaultShard = JSON.parse((await protectStore.getText(vault.shard))!) as NamespaceShard;
    expect(vaultShard.objects.map(o => o.path)).toEqual(["p/key.bin"]);
    const micaShard = JSON.parse((await publicStore.getText(manifest.namespaces.find(n => n.name === "mica")!.shard))!) as NamespaceShard;
    expect(micaShard.aliases).toEqual({ "s/latest": "s/1/x.img" });
    const digests = JSON.parse((await publicStore.getText(manifest.digests))!) as Record<string, string>;
    expect(digests[secret.sha256]).toBeUndefined();
    expect(digests[img.sha256]).toBe("mica/s/1/x.img");
  });

  test("keeps the ten newest snapshots and deletes the rest", async () => {
    for (let i = 0; i < 12; i++)
      await publishCatalog(db, config);
    expect(await pruneSnapshots(db)).toBe(2);
    const versions = new Set([...publicStore.objects.keys()].filter(k => k.startsWith("_catalog/") && k !== CATALOG_POINTER_KEY).map(k => k.split("/")[1]));
    expect(versions.size).toBe(10);
  });
});

describe("purge queue", () => {
  test("is skipped without Cloudflare credentials and sent in one call per entry with them", async () => {
    await enqueuePurge(db, ["https://dl.example.test/a"]);
    expect(await processPurges(db, config)).toEqual({ done: 0, failed: 0, skipped: 1 });

    await enqueuePurge(db, Array.from({ length: 31 }, (_, i) => `https://dl.example.test/${i}`));
    const calls: string[][] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      calls.push((JSON.parse(init.body as string) as { files: string[] }).files);
      return Response.json({ success: calls.length === 1 });
    }) as unknown as typeof fetch;
    const result = await processPurges(db, { CF_ZONE_ID: "z", CF_PURGE_TOKEN: "t" }, fetcher);
    expect(calls.map(c => c.length)).toEqual([30, 1]);
    expect(result).toEqual({ done: 1, failed: 1, skipped: 0 });
    const failed = (await db.select().from(resPurges).all()).find(p => p.state === "pending")!;
    expect(failed.attempts).toBe(1);
  });
});

describe("access keys", () => {
  test("seal and open a secret, and refuse without a KEK", async () => {
    const sealed = await sealSecret(config.RES_KEY_KEK, "s3cret");
    expect(await openSecret(config.RES_KEY_KEK, sealed)).toBe("s3cret");
    await expect(sealSecret(undefined, "x")).rejects.toMatchObject({ code: "KEK_NOT_CONFIGURED" });
  });

  test("grant protected namespaces only, sign URLs, and drop revoked keys from the snapshot", async () => {
    await createNamespace(db, { name: "vault", store: "protect", title: "Vault" });
    await expect(createAccessKey(db, config, { name: "x", grants: [{ namespace: "mica", prefix: "" }], actorId })).rejects.toMatchObject({ statusCode: 422 });
    const created = await createAccessKey(db, config, { name: "ci", grants: [{ namespace: "vault", prefix: "team/" }], actorId });
    expect(created.bearer).toBe(`rk_${created.key.id}_${created.secret}`);
    expect(grantsAllow(created.key.grants, "vault", "team/a")).toBe(true);
    expect(grantsAllow(created.key.grants, "vault", "other/a")).toBe(false);

    const signed = await mintSignedUrl(db, config, { id: created.key.id, namespace: "vault", path: "team/a.bin", ttlSeconds: 99999 });
    const url = new URL(signed.url);
    const expires = Number(url.searchParams.get("X-Res-Expires"));
    expect(expires - Date.now() / 1000).toBeLessThanOrEqual(3600);
    expect(await verifyUrlSignature(created.secret, "GET", "vault/team/a.bin", expires, url.searchParams.get("X-Res-Signature")!)).toBe(true);
    await expect(mintSignedUrl(db, config, { id: created.key.id, namespace: "vault", path: "other/a", ttlSeconds: 60 })).rejects.toMatchObject({ statusCode: 403 });

    await publishAccessSnapshot(db);
    expect((JSON.parse((await protectStore.getText(ACCESS_SNAPSHOT_KEY))!) as { keys: unknown[] }).keys.length).toBe(1);
    expect(await publicStore.getText(ACCESS_SNAPSHOT_KEY)).toBeNull();
    await revokeAccessKey(db, created.key.id);
    await publishAccessSnapshot(db);
    expect((JSON.parse((await protectStore.getText(ACCESS_SNAPSHOT_KEY))!) as { keys: unknown[] }).keys).toEqual([]);
    expect((await listAccessKeys(db))[0]!.revokedAt).not.toBeNull();
  });
});

describe("without R2 S3 credentials", () => {
  // The store cannot presign, so uploads come through the service and
  // protected downloads are streamed; copies still happen inside the store.
  beforeEach(async () => {
    __resetStoresForTests();
    const peers = new Map<string, MemoryStore>();
    publicStore = createMemoryStore(config.RES_PUBLIC_BUCKET, peers, { canPresign: false });
    protectStore = createMemoryStore(config.RES_PROTECT_BUCKET, peers, { canPresign: false });
    registerStore(PUBLIC_BINDING, publicStore);
    registerStore(PROTECT_BINDING, protectStore);
  });

  test("an upload is offered on this service and its bytes are checked on arrival", async () => {
    const text = "bytes through the service";
    const created = await createUpload(db, config, { sha256: await sha256Hex(text), size: text.length, contentType: "text/plain", actorId });
    expect(created).toMatchObject({ direct: true, url: `https://res.example.test/admin/api/res/uploads/${created.id}/content` });

    const wrong = new Response("other bytes").body!;
    await expect(writeUploadBody(db, created.id, wrong, actorId)).rejects.toMatchObject({ code: "SHA256_MISMATCH" });
    await expect(writeUploadBody(db, created.id, new Response(text).body!, "someone-else")).rejects.toMatchObject({ statusCode: 404 });

    expect(await writeUploadBody(db, created.id, new Response(text).body!, actorId)).toEqual({ id: created.id, size: text.length });
    const published = await publishObject(db, { namespace: "brand", path: "note.txt", source: { kind: "upload", uploadId: created.id }, actorId });
    expect(published.outcome).toBe("created");
    expect(publicStore.objects.get("brand/note.txt")!.info.sha256).toBe(await sha256Hex(text));
  });
});

describe("first boot", () => {
  test("a database with no snapshot is marked for publishing, and publishing clears it", async () => {
    const { hasPublishedCatalog, isCatalogDirty, markCatalogDirty, republish } = await import("./publisher");
    expect(await hasPublishedCatalog(db)).toBe(false);
    await markCatalogDirty(db);
    expect(await isCatalogDirty(db)).toBe(true);
    expect(await republish(db, config, { warn: () => {} })).toBe("published");
    expect(await hasPublishedCatalog(db)).toBe(true);
    expect(await isCatalogDirty(db)).toBe(false);
  });
});
