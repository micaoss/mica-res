import type { R2Bucket } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, test } from "bun:test";
import { createR2Store } from "./r2-store";
import { __resetStoresForTests, registerStore } from "./registry";
import { sha256Hex } from "./sigv4";

interface Stored {
  bytes: Uint8Array;
  httpMetadata: { contentType?: string; cacheControl?: string };
  customMetadata: Record<string, string>;
}

/** Enough of an R2 binding for the paths that do not need workerd. */
function fakeBucket(objects = new Map<string, Stored>()): R2Bucket & { objects: Map<string, Stored> } {
  const object = (key: string, stored: Stored) => ({
    key,
    size: stored.bytes.length,
    etag: `etag-${stored.bytes.length}`,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
    body: new Response(stored.bytes as BodyInit).body,
    text: async () => new TextDecoder().decode(stored.bytes),
  });
  return {
    objects,
    async head(key: string) {
      const stored = objects.get(key);
      return stored ? object(key, stored) : null;
    },
    async get(key: string) {
      const stored = objects.get(key);
      return stored ? object(key, stored) : null;
    },
    async put(key: string, value: unknown, opts: { sha256?: string; httpMetadata?: Stored["httpMetadata"]; customMetadata?: Record<string, string> }) {
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      // R2 refuses a put whose bytes do not hash to the declared digest.
      if (opts.sha256 !== undefined && opts.sha256 !== await sha256Hex(bytes))
        throw new Error("The SHA-256 checksum you specified did not match what we received.");
      const stored: Stored = { bytes, httpMetadata: opts.httpMetadata ?? {}, customMetadata: opts.customMetadata ?? {} };
      objects.set(key, stored);
      return object(key, stored);
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket & { objects: Map<string, Stored> };
}

const meta = { sha256: "", contentType: "application/gzip", cacheControl: "public, max-age=31536000, immutable" };

beforeEach(() => {
  __resetStoresForTests();
});

describe("R2 store without S3 credentials", () => {
  test("copies inside one bucket by streaming through the binding, with the digest enforced", async () => {
    const bucket = fakeBucket();
    const store = createR2Store("res-public", bucket, undefined);
    registerStore("RES_PUBLIC", store);
    const text = "release image";
    await bucket.put("blob/aa/old", text, { customMetadata: {} });

    const sha256 = await sha256Hex(text);
    const copied = await store.copyFrom({ bucket: "res-public", key: "blob/aa/old" }, "mica/x/y.img.gz", { ...meta, sha256 });
    expect(copied.sha256).toBe(sha256);
    expect(copied.cacheControl).toBe(meta.cacheControl);
    expect(new TextDecoder().decode(bucket.objects.get("mica/x/y.img.gz")!.bytes)).toBe(text);

    await expect(store.copyFrom({ bucket: "res-public", key: "blob/aa/old" }, "mica/x/wrong", { ...meta, sha256: "f".repeat(64) }))
      .rejects
      .toThrow(/SHA-256/);
  });

  test("copies from another bucket through that bucket's own store", async () => {
    const source = fakeBucket();
    const target = fakeBucket();
    registerStore("RES_PROTECT", createR2Store("res-protect", source, undefined));
    const store = createR2Store("res-public", target, undefined);
    registerStore("RES_PUBLIC", store);
    const text = "staged bytes";
    await source.put("_staging/1", text, { customMetadata: {} });

    const copied = await store.copyFrom({ bucket: "res-protect", key: "_staging/1" }, "brand/logo.svg", { ...meta, sha256: await sha256Hex(text) });
    expect(copied.size).toBe(text.length);
    expect(target.objects.has("brand/logo.svg")).toBe(true);
    await expect(store.copyFrom({ bucket: "nowhere", key: "x" }, "brand/other", meta)).rejects.toThrow(/missing/);
  });

  test("answers null instead of a presigned URL, and streams the bytes instead", async () => {
    const bucket = fakeBucket();
    const store = createR2Store("res-protect", bucket, undefined);
    await bucket.put("vault/a", "secret", { customMetadata: {} });
    expect(await store.presignGet("vault/a", 300)).toBeNull();
    expect(await store.presignPut("vault/a", { sha256: "a".repeat(64), size: 1, contentType: "text/plain", expiresSeconds: 60 })).toBeNull();
    const streamed = await store.getStream("vault/a");
    expect(await new Response(streamed!.body).text()).toBe("secret");
    expect(await store.getStream("vault/missing")).toBeNull();
  });
});
