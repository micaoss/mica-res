/**
 * AWS Signature Version 4, on WebCrypto only, so the same code signs in Bun
 * and in a Worker. Used three ways: the control plane signs its own S3 calls
 * to R2 (copy, delete, presigned PUT/GET), and the S3 host verifies the
 * signature a client sent for a protected namespace.
 */
import { encodeRfc3986 } from "../paths";

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ALGORITHM = "AWS4-HMAC-SHA256";

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigningScope {
  readonly region: string;
  readonly service: string;
}

const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

export async function hmacHex(key: string, data: string): Promise<string> {
  return toHex(await hmac(encoder.encode(key), data));
}

/** `YYYYMMDDTHHMMSSZ` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function signingKey(secret: string, day: string, scope: SigningScope): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), day);
  const kRegion = await hmac(kDate, scope.region);
  const kService = await hmac(kRegion, scope.service);
  return hmac(kService, "aws4_request");
}

/** Query string in SigV4 canonical form: every name and value RFC 3986 encoded, sorted. */
export function canonicalQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return params
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export interface CanonicalInput {
  readonly method: string;
  /** Already URI-encoded path, exactly as it appears on the wire. */
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  /** Header name (any case) to value, only the headers being signed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

function canonicalRequest(input: CanonicalInput): { request: string; signedHeaders: string } {
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const request = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    `${entries.map(([k, v]) => `${k}:${v}`).join("\n")}\n`,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  return { request, signedHeaders };
}

/** The hex signature over a canonical request at `date`. */
export async function signCanonical(
  input: CanonicalInput,
  credentials: Credentials,
  scope: SigningScope,
  date: string,
): Promise<{ signature: string; signedHeaders: string; credentialScope: string }> {
  const day = date.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const { request, signedHeaders } = canonicalRequest(input);
  const stringToSign = [ALGORITHM, date, credentialScope, await sha256Hex(request)].join("\n");
  const signature = toHex(await hmac(await signingKey(credentials.secretAccessKey, day, scope), stringToSign));
  return { signature, signedHeaders, credentialScope };
}

/** Headers for a request signed with the `Authorization` header. */
export async function signHeaders(opts: {
  readonly method: string;
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadHash?: string;
  readonly credentials: Credentials;
  readonly scope: SigningScope;
  readonly now?: Date;
}): Promise<Record<string, string>> {
  const date = amzDate(opts.now ?? new Date());
  const payloadHash = opts.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = {
    ...opts.headers,
    "host": opts.url.host,
    "x-amz-date": date,
    "x-amz-content-sha256": payloadHash,
  };
  const { signature, signedHeaders, credentialScope } = await signCanonical({
    method: opts.method,
    path: opts.url.pathname,
    query: [...opts.url.searchParams.entries()],
    headers,
    payloadHash,
  }, opts.credentials, opts.scope, date);
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `${ALGORITHM} Credential=${opts.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A presigned URL (query-string authentication). */
export async function presignUrl(opts: {
  readonly method: string;
  readonly url: URL;
  readonly expiresSeconds: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials: Credentials;
  readonly scope: SigningScope;
  readonly now?: Date;
}): Promise<string> {
  const date = amzDate(opts.now ?? new Date());
  const day = date.slice(0, 8);
  const headers = { ...opts.headers, host: opts.url.host };
  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(";");
  const url = new URL(opts.url);
  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${opts.credentials.accessKeyId}/${day}/${opts.scope.region}/${opts.scope.service}/aws4_request`);
  url.searchParams.set("X-Amz-Date", date);
  url.searchParams.set("X-Amz-Expires", String(opts.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
  const { signature } = await signCanonical({
    method: opts.method,
    path: url.pathname,
    query: [...url.searchParams.entries()],
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  }, opts.credentials, opts.scope, date);
  // Appended by hand: URLSearchParams would re-encode the other parameters
  // with form rules ('+' for space), which is not what was signed.
  const query = canonicalQuery([...url.searchParams.entries()]);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}

/** Constant-time comparison of two hex or ASCII strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
