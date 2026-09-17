import type { EdgeDeps } from "./http";
import type { AppDatabase } from "@/db";
import type { MemoryStore } from "@/modules/resource/storage/memory-store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { createAccessKey, mintSignedUrl, publishAccessSnapshot, revokeAccessKey } from "@/modules/resource/access/keys";
import { publishCatalog } from "@/modules/resource/publisher";
import { createNamespace, createUpload, PROTECT_BINDING, PUBLIC_BINDING, publishObject, seedResources, setAlias, setOciTag, setRedirect } from "@/modules/resource/resource.service";
import { createMemoryStore, seedMemoryObject } from "@/modules/resource/storage/memory-store";
import { __resetStoresForTests, getStore, registerStore } from "@/modules/resource/storage/registry";
import { sha256Hex, signHeaders } from "@/modules/resource/storage/sigv4";
import { createCatalogReader } from "./catalog-reader";
import { handleResHost } from "./http";
import { handleS3Host } from "./s3";

const config = {
  RES_HOME_URL: "https://res.example.test",
  RES_DOWNLOAD_URL: "https://dl.example.test",
  RES_S3_URL: "https://s3.example.test",
  RES_PUBLIC_BUCKET: "res-public",
  RES_PROTECT_BUCKET: "res-protect",
  RES_DELETE_GRACE_SECONDS: 604800,
  RES_UPLOAD_TTL_SECONDS: 3600,
  RES_SIGNED_URL_MAX_TTL_SECONDS: 3600,
  RES_KEY_KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
};
const actorId = "u_admin";

let db: AppDatabase;
let dir: string;
let protectStore: MemoryStore;
let clock = Date.now();
let deps: EdgeDeps;
const shas: Record<string, string> = {};

async function put(namespace: string, path: string, text: string, contentType?: string): Promise<void> {
  const sha256 = await sha256Hex(text);
  const upload = await createUpload(db, config, { sha256, size: text.length, contentType: contentType ?? "application/octet-stream", actorId });
  await seedMemoryObject(protectStore, new URL(upload.url).pathname.split("/").slice(2).join("/"), text);
  await publishObject(db, { namespace, path, source: { kind: "upload", uploadId: upload.id }, contentType, actorId });
  shas[`${namespace}/${path}`] = sha256;
}

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "edge-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetStoresForTests();
  const peers = new Map<string, MemoryStore>();
  registerStore(PUBLIC_BINDING, createMemoryStore(config.RES_PUBLIC_BUCKET, peers));
  protectStore = createMemoryStore(config.RES_PROTECT_BUCKET, peers);
  registerStore(PROTECT_BINDING, protectStore);
  await seedResources(db, config);
  await createNamespace(db, { name: "vault", store: "protect", title: "Vault", description: "keys only" });

  await put("mica", "uefi-x64/20260917-0000/mica.img.gz", "image");
  await put("mica", "uefi-x64/20260917-0000/mica.micaupd", "update");
  await put("mica", "cx3576/20260917-0000/mica.img.gz", "cx image");
  await setAlias(db, { namespace: "mica", path: "uefi-x64/latest", targetPath: "uefi-x64/20260917-0000/mica.img.gz" });
  await setRedirect(db, "/d/mica/uefi-x64/20260917-0000/mica.img.gz", "mica/uefi-x64/20260917-0000/mica.img.gz");
  const index = "{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\"}";
  const indexSha = await sha256Hex(index);
  await put("oci", `blobs/sha256/${indexSha}`, index, "application/vnd.oci.image.index.v1+json");
  await put("oci", `blobs/sha256/${await sha256Hex("layer")}`, "layer");
  await setOciTag(db, { repository: "micaoss/mica-build-env", tag: "base.1", digest: `sha256:${indexSha}` });
  await put("docs", "guide/1.0/index.html", "<h1>guide</h1>");
  await put("vault", "team/secret.bin", "secret");
  await put("vault", "other/x.bin", "other");
  await publishCatalog(db, config);

  clock = Date.now();
  deps = {
    reader: createCatalogReader({ store: getStore, publicBinding: PUBLIC_BINDING, protectBinding: PROTECT_BINDING, now: () => clock }),
    store: getStore,
    assets: { fetch: async req => new URL(req.url).pathname === "/index.html" ? new Response("<!doctype html>home") : new Response("nope", { status: 404 }) },
    kek: config.RES_KEY_KEK,
    adminBase: "/admin",
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const res = (path: string, init?: RequestInit) => handleResHost(new Request(`https://res.example.test${path}`, init), deps);
const s3 = (path: string, init?: RequestInit) => handleS3Host(new Request(`https://s3.example.test${path}`, init), deps);

describe("res host", () => {
  test("hands the admin API to the Durable Object and serves everything else itself", async () => {
    expect(await res("/admin/api/res/namespaces")).toBeNull();
    expect((await res("/"))!.status).toBe(200);
    expect(await (await res("/admin/resources"))!.text()).toBe("nope");
  });

  test("redirects an object to the download host and never serves its bytes", async () => {
    const r = (await res("/mica/uefi-x64/20260917-0000/mica.img.gz"))!;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://dl.example.test/mica/uefi-x64/20260917-0000/mica.img.gz");
    expect(await r.text()).toBe("");
  });

  test("lists a directory as JSON and HTML, and redirects a directory named without its slash", async () => {
    const top = (await res("/mica/", { headers: { accept: "application/json" } }))!;
    expect((await top.json() as { directories: { path: string }[] }).directories.map(d => d.path)).toEqual(["cx3576/", "uefi-x64/"]);
    const inner = await (await res("/mica/uefi-x64/20260917-0000/?format=json"))!.json() as { objects: { name: string; url: string }[] };
    expect(inner.objects.map(o => o.name)).toEqual(["mica.img.gz", "mica.micaupd"]);
    expect(inner.objects[0]!.url).toBe("https://dl.example.test/mica/uefi-x64/20260917-0000/mica.img.gz");
    const html = await (await res("/mica/uefi-x64/"))!.text();
    expect(html).toContain("20260917-0000/");
    expect((await res("/mica"))!.status).toBe(301);
    expect((await res("/mica/uefi-x64"))!.headers.get("location")).toBe("/mica/uefi-x64/");
    expect((await res("/mica/nope/"))!.status).toBe(404);
  });

  test("resolves aliases, a docs site index and legacy URLs", async () => {
    expect((await res("/mica/uefi-x64/latest"))!.headers.get("location")).toBe("https://dl.example.test/mica/uefi-x64/20260917-0000/mica.img.gz");
    expect((await res("/docs/guide/1.0/"))!.headers.get("location")).toBe("https://dl.example.test/docs/guide/1.0/index.html");
    const digest = shas["mica/uefi-x64/20260917-0000/mica.img.gz"]!;
    expect((await res(`/blob/${digest.slice(0, 2)}/${digest}`))!.headers.get("location")).toBe("https://dl.example.test/mica/uefi-x64/20260917-0000/mica.img.gz");
    expect((await res(`/blob/ff/${digest}`))!.status).toBe(404);
    expect((await res("/d/mica/uefi-x64/20260917-0000/mica.img.gz"))!.status).toBe(302);
    expect((await res("/d/mica/cx3576/20260917-0000/mica.img.gz"))!.headers.get("location")).toBe("https://dl.example.test/mica/cx3576/20260917-0000/mica.img.gz");
    expect((await res("/index/current.json"))!.headers.get("location")).toBe("https://dl.example.test/index/current.json");
  });

  test("describes the site without counting protected content", async () => {
    const site = await (await res("/.well-known/res.json"))!.json() as { site: { download: string }; namespaces: { name: string; objects: number | null }[] };
    expect(site.site.download).toBe("https://dl.example.test");
    expect(site.namespaces.find(n => n.name === "mica")!.objects).toBe(3);
    expect(site.namespaces.find(n => n.name === "vault")!.objects).toBeNull();
  });

  test("serves registry manifests and redirects blobs", async () => {
    expect((await res("/v2/"))!.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    const manifest = (await res("/v2/micaoss/mica-build-env/manifests/base.1"))!;
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/vnd.oci.image.index.v1+json");
    expect(await manifest.text()).toContain("schemaVersion");
    const layer = await sha256Hex("layer");
    const blob = (await res(`/v2/micaoss/mica-build-env/blobs/sha256:${layer}`))!;
    expect(blob.status).toBe(307);
    expect(blob.headers.get("location")).toBe(`https://dl.example.test/oci/blobs/sha256/${layer}`);
    expect((await res("/v2/micaoss/mica-build-env/manifests/missing"))!.status).toBe(404);
  });

  test("requires a key for a protected namespace and honours its grants, signatures and revocation", async () => {
    expect((await res("/vault/team/secret.bin"))!.status).toBe(401);
    const created = await createAccessKey(db, config, { name: "team", grants: [{ namespace: "vault", prefix: "team/" }], actorId });
    await publishAccessSnapshot(db);
    const bearer = { headers: { authorization: `Bearer ${created.bearer}` } };
    const ok = (await res("/vault/team/secret.bin", bearer))!;
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toStartWith("https://memory.invalid/res-protect/vault/team/secret.bin");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect((await res("/vault/other/x.bin", bearer))!.status).toBe(401);
    expect((await res("/vault/team/secret.bin", { headers: { authorization: `Bearer rk_${created.key.id}_wrong` } }))!.status).toBe(403);

    const signed = await mintSignedUrl(db, config, { id: created.key.id, namespace: "vault", path: "team/secret.bin", ttlSeconds: 600 });
    const u = new URL(signed.url);
    expect((await res(`${u.pathname}${u.search}`))!.status).toBe(302);
    expect((await res(`/vault/other/x.bin${u.search}`))!.status).toBe(403);

    await revokeAccessKey(db, created.key.id);
    await publishAccessSnapshot(db);
    expect((await res("/vault/team/secret.bin", bearer))!.status).toBe(302);
    clock += 31_000;
    expect((await res("/vault/team/secret.bin", bearer))!.status).toBe(403);
  });
});

describe("s3 host", () => {
  test("lists public buckets anonymously and refuses every write", async () => {
    const body = await (await s3("/"))!.text();
    expect(body).toContain("<Name>mica</Name>");
    expect(body).not.toContain("<Name>vault</Name>");
    for (const method of ["PUT", "POST", "DELETE"])
      expect((await s3("/mica/x", { method }))!.status).toBe(403);
  });

  test("lists objects with delimiter, pagination and url encoding", async () => {
    const first = await (await s3("/mica?list-type=2&delimiter=/&prefix=&max-keys=1"))!.text();
    expect(first).toContain("<CommonPrefixes><Prefix>cx3576/</Prefix></CommonPrefixes>");
    expect(first).toContain("<IsTruncated>true</IsTruncated>");
    const token = /<NextContinuationToken>([^<]+)</.exec(first)![1]!;
    const second = await (await s3(`/mica?list-type=2&delimiter=/&max-keys=1&continuation-token=${token}`))!.text();
    expect(second).toContain("<Prefix>uefi-x64/</Prefix></CommonPrefixes>");
    expect(second).toContain("<IsTruncated>false</IsTruncated>");
    const flat = await (await s3("/mica?list-type=2&prefix=uefi-x64/2&encoding-type=url"))!.text();
    expect(flat).toContain("<Key>uefi-x64/20260917-0000/mica.img.gz</Key>");
    expect(flat).toContain("<KeyCount>2</KeyCount>");
    expect(await (await s3("/mica?location"))!.text()).toContain(">auto</LocationConstraint>");
  });

  test("answers HeadObject from the catalog and redirects GetObject", async () => {
    const head = (await s3("/mica/uefi-x64/20260917-0000/mica.img.gz", { method: "HEAD" }))!;
    expect(head.headers.get("content-length")).toBe("5");
    expect(head.headers.get("x-amz-meta-sha256")).toBe(shas["mica/uefi-x64/20260917-0000/mica.img.gz"]!);
    const get = (await s3("/mica/uefi-x64/20260917-0000/mica.img.gz"))!;
    expect(get.status).toBe(307);
    expect(get.headers.get("location")).toBe("https://dl.example.test/mica/uefi-x64/20260917-0000/mica.img.gz");
    expect((await s3("/mica/missing"))!.status).toBe(404);
    expect((await s3("/nope?list-type=2"))!.status).toBe(404);
  });

  test("a protected bucket needs a valid SigV4 signature from a key that grants it", async () => {
    expect((await s3("/vault?list-type=2"))!.status).toBe(403);
    const created = await createAccessKey(db, config, { name: "s3", grants: [{ namespace: "vault", prefix: "team/" }], actorId });
    await publishAccessSnapshot(db);
    const signed = async (path: string, secret = created.secret) => {
      const url = new URL(`https://s3.example.test${path}`);
      const headers = await signHeaders({ method: "GET", url, credentials: { accessKeyId: created.key.id, secretAccessKey: secret }, scope: { region: "auto", service: "s3" }, payloadHash: "UNSIGNED-PAYLOAD" });
      return s3(path, { headers: { ...headers, host: url.host } });
    };
    const list = await (await signed("/vault?list-type=2"))!.text();
    expect(list).toContain("<Key>team/secret.bin</Key>");
    expect(list).not.toContain("other/x.bin");
    const buckets = await (await signed("/"))!.text();
    expect(buckets).toContain("<Name>vault</Name>");
    const get = (await signed("/vault/team/secret.bin"))!;
    expect(get.status).toBe(307);
    expect(get.headers.get("location")).toStartWith("https://memory.invalid/res-protect/vault/team/secret.bin");
    expect((await signed("/vault/other/x.bin"))!.status).toBe(403);
    expect(await (await signed("/vault?list-type=2", "wrong-secret"))!.text()).toContain("SignatureDoesNotMatch");
  });

  test("a signature over Accept-Encoding survives the edge rewriting that header", async () => {
    const created = await createAccessKey(db, config, { name: "go-sdk", grants: [{ namespace: "vault", prefix: "" }], actorId });
    await publishAccessSnapshot(db);
    const url = new URL("https://s3.example.test/vault?list-type=2");
    // Signed the way aws-sdk-go-v2 signs, with accept-encoding: identity ...
    const headers = await signHeaders({ method: "GET", url, headers: { "accept-encoding": "identity" }, credentials: { accessKeyId: created.key.id, secretAccessKey: created.secret }, scope: { region: "auto", service: "s3" }, payloadHash: "UNSIGNED-PAYLOAD" });
    // ... and received with the value Cloudflare substitutes.
    const res = await s3("/vault?list-type=2", { headers: { ...headers, "host": url.host, "accept-encoding": "gzip, br" } });
    expect(res!.status).toBe(200);
  });
});
