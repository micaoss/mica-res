import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import type { S3Client } from "./s3-client";
import type { ObjectMetadata, ResStore, StoredObjectInfo } from "./types";
import { storeByBucket } from "./registry";
import { hexToBase64 } from "./s3-client";

function info(object: R2Object): StoredObjectInfo {
  return {
    size: object.size,
    etag: object.etag,
    sha256: object.customMetadata?.sha256,
    contentType: object.httpMetadata?.contentType,
    cacheControl: object.httpMetadata?.cacheControl,
  };
}

function putOptions(meta: ObjectMetadata) {
  return {
    sha256: meta.sha256,
    httpMetadata: { contentType: meta.contentType, cacheControl: meta.cacheControl },
    customMetadata: { sha256: meta.sha256 },
  };
}

/**
 * A bucket reached through its Worker binding. Two things a binding cannot
 * do are done through R2's S3 endpoint when credentials are configured:
 * copying server-side and presigning. Without them the store still works --
 * a copy streams binding-to-binding inside Cloudflare, and presigning
 * answers null so the caller falls back to a path through the Worker.
 */
export function createR2Store(bucketName: string, binding: R2Bucket, s3: S3Client | undefined): ResStore {
  const head = async (key: string): Promise<StoredObjectInfo | null> => {
    const object = await binding.head(key);
    return object ? info(object) : null;
  };

  const getStream: ResStore["getStream"] = async (key) => {
    const object = await binding.get(key);
    return object?.body ? { body: object.body as unknown as ReadableStream<Uint8Array>, info: info(object) } : null;
  };

  return {
    bucket: bucketName,
    head,
    async getText(key) {
      const object = await binding.get(key);
      return object ? object.text() : null;
    },
    async putText(key, text, meta) {
      return info(await binding.put(key, text, putOptions(meta)));
    },
    async putStream(key, body, size, meta) {
      // A binding needs a known length to stream; FixedLengthStream supplies
      // it and refuses a body that turns out longer or shorter.
      const fixed = new FixedLengthStream(size);
      void body.pipeTo(fixed.writable as never).catch(() => {});
      const object = await binding.put(key, fixed.readable as never, putOptions(meta));
      if (!object)
        throw new Error(`put of ${key} returned no object`);
      return info(object);
    },
    getStream,
    async copyFrom(source, key, meta) {
      if (s3) {
        await s3.copyObject({
          sourceBucket: source.bucket,
          sourceKey: source.key,
          bucket: bucketName,
          key,
          contentType: meta.contentType,
          cacheControl: meta.cacheControl,
          metadata: { sha256: meta.sha256 },
        });
      }
      else {
        // No S3 credentials: read the source through its own binding and
        // write it back. The bytes stay inside Cloudflare (no egress), and
        // R2 still refuses them unless they hash to the declared sha256.
        const from = source.bucket === bucketName ? { getStream } : storeByBucket(source.bucket);
        const object = await from?.getStream(source.key);
        if (!object)
          throw new Error(`copy source ${source.bucket}/${source.key} is missing`);
        const written = await binding.put(key, object.body as never, putOptions(meta));
        if (!written)
          throw new Error(`copy to ${key} left no object`);
        return info(written);
      }
      const copied = await head(key);
      if (!copied)
        throw new Error(`copy to ${key} left no object`);
      return copied;
    },
    async delete(key) {
      await binding.delete(key);
    },
    async presignGet(key, expiresSeconds) {
      return s3 ? s3.presignGet(bucketName, key, expiresSeconds) : null;
    },
    async presignPut(key, opts) {
      if (!s3)
        return null;
      const signed = await s3.presignPut(bucketName, key, {
        sha256Base64: hexToBase64(opts.sha256),
        contentType: opts.contentType,
        expiresSeconds: opts.expiresSeconds,
      });
      return { ...signed, expiresAt: new Date(Date.now() + opts.expiresSeconds * 1000).toISOString() };
    },
    async list(prefix, cursor) {
      const page = await binding.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      return {
        keys: page.objects.map(o => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
}

declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
