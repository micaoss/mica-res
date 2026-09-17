import type { CatalogInput, NamespaceShard } from "./catalog";
import { describe, expect, test } from "bun:test";
import { buildCatalog, CATALOG_SCHEMA, findObject, listShard } from "./catalog";

const site = { title: "t", description: "d", download: "https://dl.example", s3: "https://s3.example", home: "https://res.example" };

function object(namespace: string, path: string, sha: string, publishedAt = "2026-09-17T00:00:00.000Z") {
  return { namespace, path, sha256: sha.repeat(64).slice(0, 64), size: 10, etag: "e", contentType: "application/octet-stream", publishedAt };
}

function input(overrides: Partial<CatalogInput> = {}): CatalogInput {
  return {
    version: "v1",
    publishedAt: "2026-09-17T00:00:00.000Z",
    site,
    publicStore: "RES_PUBLIC",
    namespaces: [
      { name: "mica", title: "Mica", description: "", visibility: "public", store: "RES_PUBLIC", listable: true, immutable: true, siteMode: false, cachePolicy: "immutable", examples: ["mica/a/"] },
      { name: "secret", title: "Secret", description: "keys only", visibility: "protected", store: "RES_PROTECT", listable: true, immutable: false, siteMode: false, cachePolicy: "no-store", examples: ["secret/x/"] },
    ],
    objects: [object("mica", "b/2", "b"), object("mica", "a/1", "a"), object("secret", "x/1", "c")],
    aliases: [{ namespace: "mica", path: "latest", targetPath: "b/2" }],
    redirects: [{ fromPath: "/d/mica/old", targetKey: "mica/a/1" }, { fromPath: "/d/secret/old", targetKey: "secret/x/1" }],
    ociTags: [{ repository: "micaoss/env", tag: "base", digest: "sha256:aa" }],
    ...overrides,
  };
}

describe("buildCatalog", () => {
  test("writes sorted shards to each namespace's store and the index files to the public store", () => {
    const { pointer, manifest, files } = buildCatalog(input());
    expect(pointer.manifest).toBe("_catalog/v1/manifest.json");
    expect(manifest.schema).toBe(CATALOG_SCHEMA);
    const shard = JSON.parse(files.find(f => f.key === "_catalog/v1/ns/mica.json")!.text) as NamespaceShard;
    expect(shard.objects.map(o => o.path)).toEqual(["a/1", "b/2"]);
    expect(shard.aliases).toEqual({ latest: "b/2" });
    expect(files.find(f => f.key === "_catalog/v1/ns/secret.json")!.store).toBe("RES_PROTECT");
    expect(files.filter(f => f.store === "RES_PUBLIC").map(f => f.key).sort()).toEqual([
      "_catalog/v1/digests.json",
      "_catalog/v1/manifest.json",
      "_catalog/v1/ns/mica.json",
      "_catalog/v1/redirects.json",
    ]);
  });

  test("never exposes a protected namespace's content in public documents", () => {
    const { manifest, files } = buildCatalog(input());
    const secret = manifest.namespaces.find(n => n.name === "secret")!;
    expect(secret.objects).toBeNull();
    expect(secret.examples).toEqual([]);
    const digests = JSON.parse(files.find(f => f.key.endsWith("digests.json"))!.text) as Record<string, string>;
    expect(Object.values(digests).sort()).toEqual(["mica/a/1", "mica/b/2"]);
    const redirects = JSON.parse(files.find(f => f.key.endsWith("redirects.json"))!.text) as Record<string, string>;
    expect(redirects).toEqual({ "/d/mica/old": "mica/a/1" });
  });

  test("indexes a digest under its earliest published key and counts public bytes", () => {
    const { manifest, files } = buildCatalog(input({
      objects: [object("mica", "z", "a", "2026-09-18T00:00:00.000Z"), object("mica", "a/1", "a", "2026-09-17T00:00:00.000Z")],
    }));
    const digests = JSON.parse(files.find(f => f.key.endsWith("digests.json"))!.text) as Record<string, string>;
    expect(digests["a".repeat(64)]).toBe("mica/a/1");
    expect(manifest.namespaces.find(n => n.name === "mica")!.bytes).toBe(20);
    expect(manifest.registry).toEqual({ "micaoss/env": { base: "sha256:aa" } });
  });
});

describe("shard lookup and listing", () => {
  const shard: NamespaceShard = {
    schema: "mica-res/catalog-namespace/v1",
    version: "v",
    name: "n",
    aliases: {},
    objects: ["a/1", "a/2", "b/x/1", "b/x/2", "b/y", "c"].map(path => ({ path, sha256: "s", size: 1, etag: "e", contentType: "t", publishedAt: "p" })),
  };

  test("finds an exact path", () => {
    expect(findObject(shard, "b/y")?.path).toBe("b/y");
    expect(findObject(shard, "b")).toBeUndefined();
  });

  test("rolls up directories at the delimiter", () => {
    const top = listShard(shard, { prefix: "", delimiter: "/", limit: 100 });
    expect(top.directories).toEqual(["a/", "b/"]);
    expect(top.objects.map(o => o.path)).toEqual(["c"]);
    const b = listShard(shard, { prefix: "b/", delimiter: "/", limit: 100 });
    expect(b.directories).toEqual(["b/x/"]);
    expect(b.objects.map(o => o.path)).toEqual(["b/y"]);
  });

  test("pages without repeating a rolled-up directory", () => {
    const first = listShard(shard, { prefix: "", delimiter: "/", limit: 1 });
    expect(first.directories).toEqual(["a/"]);
    expect(first.next).toBe("a/");
    const second = listShard(shard, { prefix: "", delimiter: "/", after: first.next, limit: 1 });
    expect(second.directories).toEqual(["b/"]);
    const third = listShard(shard, { prefix: "", delimiter: "/", after: second.next, limit: 1 });
    expect(third.objects.map(o => o.path)).toEqual(["c"]);
    expect(third.next).toBeUndefined();
  });

  test("lists flat when no delimiter is given", () => {
    const flat = listShard(shard, { prefix: "b/", limit: 2 });
    expect(flat.objects.map(o => o.path)).toEqual(["b/x/1", "b/x/2"]);
    expect(flat.next).toBe("b/x/2");
  });
});
