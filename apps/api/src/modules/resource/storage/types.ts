/**
 * One bucket, as the control plane and the edge see it. The public bucket's
 * bytes are served by R2 itself on the download host; nothing here streams
 * a public object to a client.
 */

export interface StoredObjectInfo {
  readonly size: number;
  /** The bare ETag, without quotes. */
  readonly etag: string;
  readonly sha256: string | undefined;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
}

export interface ObjectMetadata {
  /** Lowercase hex. Stored as custom metadata and, on a write, enforced by R2. */
  readonly sha256: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface PresignedPut {
  readonly url: string;
  /** Headers the uploader must send exactly, because they are signed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface ResStore {
  readonly bucket: string;
  head: (key: string) => Promise<StoredObjectInfo | null>;
  getText: (key: string) => Promise<string | null>;
  /** Small documents (catalog snapshots). */
  putText: (key: string, text: string, meta: ObjectMetadata) => Promise<StoredObjectInfo>;
  /** Streams `body` into the bucket; R2 refuses it unless it hashes to `meta.sha256`. */
  putStream: (key: string, body: ReadableStream<Uint8Array>, size: number, meta: ObjectMetadata) => Promise<StoredObjectInfo>;
  /** Server-side copy, replacing the metadata. The source may be in another bucket. */
  copyFrom: (source: { readonly bucket: string; readonly key: string }, key: string, meta: ObjectMetadata) => Promise<StoredObjectInfo>;
  delete: (key: string) => Promise<void>;
  presignGet: (key: string, expiresSeconds: number) => Promise<string>;
  presignPut: (key: string, opts: { readonly sha256: string; readonly size: number; readonly contentType: string; readonly expiresSeconds: number }) => Promise<PresignedPut>;
  /** One page of keys under a prefix, for audits. */
  list: (prefix: string, cursor?: string) => Promise<{ keys: { key: string; size: number }[]; cursor: string | undefined }>;
}

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}
