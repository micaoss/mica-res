import type { ResStore, StoredObjectInfo } from "./types";
import { sha256Hex } from "./sigv4";

interface Entry {
  bytes: Uint8Array;
  info: StoredObjectInfo;
}

export interface MemoryStore extends ResStore {
  readonly objects: Map<string, Entry>;
}

/**
 * An in-memory bucket with R2's write rules (a declared sha256 is enforced),
 * for tests and for a local control plane with no R2 at all. Presigned URLs
 * point at a fake host; nothing can fetch them.
 */
export function createMemoryStore(bucket: string, peers?: Map<string, MemoryStore>, opts: { canPresign?: boolean } = {}): MemoryStore {
  const objects = new Map<string, Entry>();
  const canPresign = opts.canPresign ?? true;

  const store: MemoryStore = {
    bucket,
    objects,
    async head(key) {
      return objects.get(key)?.info ?? null;
    },
    async getText(key) {
      const entry = objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : null;
    },
    async putText(key, text, meta) {
      const bytes = new TextEncoder().encode(text);
      return write(key, bytes, meta);
    },
    async putStream(key, body, size, meta) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.length !== size)
        throw new Error(`stream length ${bytes.length} is not the declared ${size}`);
      return write(key, bytes, meta);
    },
    async getStream(key) {
      const entry = objects.get(key);
      return entry ? { body: new Response(entry.bytes as BodyInit).body!, info: entry.info } : null;
    },
    async copyFrom(source, key, meta) {
      const from = source.bucket === bucket ? store : peers?.get(source.bucket);
      const entry = from?.objects.get(source.key);
      if (!entry)
        throw new Error(`NoSuchKey: ${source.bucket}/${source.key}`);
      const copied: Entry = {
        bytes: entry.bytes,
        info: { ...entry.info, sha256: meta.sha256, contentType: meta.contentType, cacheControl: meta.cacheControl },
      };
      objects.set(key, copied);
      return copied.info;
    },
    async delete(key) {
      objects.delete(key);
    },
    async presignGet(key, expiresSeconds) {
      return canPresign ? `https://memory.invalid/${bucket}/${key}?expires=${expiresSeconds}` : null;
    },
    async presignPut(key, opts) {
      if (!canPresign)
        return null;
      return {
        url: `https://memory.invalid/${bucket}/${key}?put`,
        headers: { "content-type": opts.contentType },
        expiresAt: new Date(Date.now() + opts.expiresSeconds * 1000).toISOString(),
      };
    },
    async list(prefix) {
      return {
        keys: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, size: e.info.size })).sort((a, b) => (a.key < b.key ? -1 : 1)),
        cursor: undefined,
      };
    },
  };

  async function write(key: string, bytes: Uint8Array, meta: { sha256: string; contentType: string; cacheControl: string }): Promise<StoredObjectInfo> {
    const digest = await sha256Hex(bytes);
    if (digest !== meta.sha256)
      throw new Error(`sha256 mismatch for ${key}: ${digest} is not ${meta.sha256}`);
    const info: StoredObjectInfo = {
      size: bytes.length,
      etag: digest.slice(0, 32),
      sha256: meta.sha256,
      contentType: meta.contentType,
      cacheControl: meta.cacheControl,
    };
    objects.set(key, { bytes, info });
    return info;
  }

  peers?.set(bucket, store);
  return store;
}

/** Test helper: put bytes as an uploader would (e.g. to a staging key). */
export async function seedMemoryObject(store: MemoryStore, key: string, text: string, contentType = "application/octet-stream"): Promise<string> {
  const sha256 = await sha256Hex(text);
  await store.putText(key, text, { sha256, contentType, cacheControl: "no-store" });
  return sha256;
}
