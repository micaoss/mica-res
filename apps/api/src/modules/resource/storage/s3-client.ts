/**
 * The few S3 calls the control plane makes against R2's S3 endpoint: the
 * operations a bucket binding cannot do (server-side copy, presigning).
 * Path-style, region `auto`, signed with SigV4.
 */
import type { Credentials } from "./sigv4";
import type { Config } from "@/config";
import { encodeKeyPath } from "../paths";
import { presignUrl, signHeaders } from "./sigv4";

export interface S3ClientOptions {
  /** e.g. `https://<account>.r2.cloudflarestorage.com` */
  readonly endpoint: string;
  readonly credentials: Credentials;
  readonly region?: string;
  readonly fetch?: typeof fetch;
}

export class S3Error extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string) {
    super(`S3 ${operation} failed: ${status} ${code}`);
    this.name = "S3Error";
  }
}

function errorCode(body: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "Unknown";
}

export class S3Client {
  readonly #endpoint: string;
  readonly #credentials: Credentials;
  readonly #scope: { region: string; service: string };
  readonly #fetch: typeof fetch;

  constructor(opts: S3ClientOptions) {
    this.#endpoint = opts.endpoint.replace(/\/+$/, "");
    this.#credentials = opts.credentials;
    this.#scope = { region: opts.region ?? "auto", service: "s3" };
    this.#fetch = opts.fetch ?? fetch;
  }

  objectUrl(bucket: string, key: string): URL {
    return new URL(`${this.#endpoint}/${bucket}/${encodeKeyPath(key)}`);
  }

  async #send(operation: string, method: string, url: URL, headers: Record<string, string> = {}): Promise<Response> {
    const signed = await signHeaders({ method, url, headers, credentials: this.#credentials, scope: this.#scope });
    const res = await this.#fetch(url, { method, headers: signed });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const body = await res.text();
      throw new S3Error(operation, res.status, errorCode(body));
    }
    return res;
  }

  async copyObject(opts: {
    readonly sourceBucket: string;
    readonly sourceKey: string;
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string;
    readonly cacheControl: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    const headers: Record<string, string> = {
      "x-amz-copy-source": `/${opts.sourceBucket}/${encodeKeyPath(opts.sourceKey)}`,
      "x-amz-metadata-directive": "REPLACE",
      "content-type": opts.contentType,
      "cache-control": opts.cacheControl,
    };
    for (const [k, v] of Object.entries(opts.metadata))
      headers[`x-amz-meta-${k}`] = v;
    const res = await this.#send("CopyObject", "PUT", this.objectUrl(opts.bucket, opts.key), headers);
    // A copy can fail after the 200 status line; the body then carries <Error>.
    const body = await res.text();
    if (body.includes("<Error>"))
      throw new S3Error("CopyObject", 200, errorCode(body));
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await (await this.#send("DeleteObject", "DELETE", this.objectUrl(bucket, key))).arrayBuffer();
  }

  presignGet(bucket: string, key: string, expiresSeconds: number): Promise<string> {
    return presignUrl({ method: "GET", url: this.objectUrl(bucket, key), expiresSeconds, credentials: this.#credentials, scope: this.#scope });
  }

  /**
   * A presigned PUT whose content type and SHA-256 checksum are signed, so
   * the uploader cannot change them and R2 refuses bytes that do not hash to
   * the declared digest.
   */
  async presignPut(bucket: string, key: string, opts: { sha256Base64: string; contentType: string; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }> {
    const headers = { "content-type": opts.contentType, "x-amz-checksum-sha256": opts.sha256Base64 };
    const url = await presignUrl({ method: "PUT", url: this.objectUrl(bucket, key), expiresSeconds: opts.expiresSeconds, headers, credentials: this.#credentials, scope: this.#scope });
    return { url, headers };
  }
}

export function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes));
}

export function s3ClientFrom(config: Pick<Config, "R2_ACCOUNT_ID" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_S3_ENDPOINT">): S3Client | undefined {
  if (!config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY)
    return undefined;
  const endpoint = config.R2_S3_ENDPOINT ?? (config.R2_ACCOUNT_ID ? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint)
    return undefined;
  return new S3Client({ endpoint, credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY } });
}
