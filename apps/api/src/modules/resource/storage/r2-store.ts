import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import type { S3Client } from "./s3-client";
import type { ObjectMetadata, ResStore, StoredObjectInfo } from "./types";
import { hexToBase64 } from "./s3-client";
import { StoreUnavailableError } from "./types";

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
 * A bucket reached through its Worker binding, with R2's S3 endpoint for the
 * two things a binding cannot do: copy server-side and presign. Without S3
 * credentials those two fail loudly; everything else works.
 */
export function createR2Store(bucketName: string, binding: R2Bucket, s3: S3Client | undefined): ResStore {
  const requireS3 = (what: string): S3Client => {
    if (!s3)
      throw new StoreUnavailableError(`${what} needs R2 S3 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)`);
    return s3;
  };

  const head = async (key: string): Promise<StoredObjectInfo | null> => {
    const object = await binding.head(key);
    return object ? info(object) : null;
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
    async copyFrom(source, key, meta) {
      await requireS3("A server-side copy").copyObject({
        sourceBucket: source.bucket,
        sourceKey: source.key,
        bucket: bucketName,
        key,
        contentType: meta.contentType,
        cacheControl: meta.cacheControl,
        metadata: { sha256: meta.sha256 },
      });
      const copied = await head(key);
      if (!copied)
        throw new Error(`copy to ${key} left no object`);
      return copied;
    },
    async delete(key) {
      await binding.delete(key);
    },
    presignGet(key, expiresSeconds) {
      return requireS3("A presigned download").presignGet(bucketName, key, expiresSeconds);
    },
    async presignPut(key, opts) {
      const signed = await requireS3("A presigned upload").presignPut(bucketName, key, {
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
