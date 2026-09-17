/**
 * Authorisation for protected namespaces at the edge, from the access
 * snapshot alone: a bearer key, a res-signed URL, or an S3 SigV4 signature.
 */
import type { CatalogReader } from "./catalog-reader";
import type { AccessSnapshotKey, Grant } from "@/modules/resource/access/keys";
import { BEARER_PREFIX, openSecret, verifyUrlSignature } from "@/modules/resource/access/keys";
import { sha256Hex, signCanonical, timingSafeEqual } from "@/modules/resource/storage/sigv4";

export type AccessResult
  = | { readonly kind: "anonymous" }
    | { readonly kind: "granted"; readonly keyId: string; readonly grants: readonly Grant[] }
    | { readonly kind: "denied"; readonly code: string; readonly message: string };

const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

async function activeKey(reader: CatalogReader, id: string, at: number): Promise<AccessSnapshotKey | undefined> {
  const snapshot = await reader.access();
  const key = snapshot?.keys.find(k => k.id === id);
  if (!key || (key.expiresAt !== null && new Date(key.expiresAt).getTime() <= at))
    return undefined;
  return key;
}

/** `Authorization: Bearer rk_<id>_<secret>` or `X-Res-*` query parameters. */
export async function authorizeHttp(request: Request, url: URL, key: string, reader: CatalogReader, kek: string | undefined, at = Date.now()): Promise<AccessResult> {
  const header = request.headers.get("authorization");
  if (header?.startsWith(`Bearer ${BEARER_PREFIX}`)) {
    const token = header.slice(`Bearer ${BEARER_PREFIX}`.length).trim();
    const split = token.indexOf("_");
    if (split <= 0)
      return { kind: "denied", code: "INVALID_KEY", message: "Malformed access key" };
    const found = await activeKey(reader, token.slice(0, split), at);
    if (!found || !timingSafeEqual(await sha256Hex(token.slice(split + 1)), found.secretHash))
      return { kind: "denied", code: "INVALID_KEY", message: "Unknown, expired or revoked access key" };
    return { kind: "granted", keyId: found.id, grants: found.grants };
  }

  const keyId = url.searchParams.get("X-Res-Key");
  if (keyId !== null) {
    const expires = Number(url.searchParams.get("X-Res-Expires"));
    const signature = url.searchParams.get("X-Res-Signature") ?? "";
    if (!Number.isSafeInteger(expires) || expires * 1000 <= at)
      return { kind: "denied", code: "EXPIRED", message: "The signed URL has expired" };
    const found = await activeKey(reader, keyId, at);
    if (!found)
      return { kind: "denied", code: "INVALID_KEY", message: "Unknown, expired or revoked access key" };
    const secret = await openSecret(kek, found.secretSealed);
    if (!(await verifyUrlSignature(secret, request.method === "HEAD" ? "GET" : request.method, key, expires, signature)))
      return { kind: "denied", code: "INVALID_SIGNATURE", message: "The signature does not match" };
    return { kind: "granted", keyId: found.id, grants: found.grants };
  }
  return { kind: "anonymous" };
}

/** The request path exactly as sent, still percent-encoded. */
export function rawPath(request: Request): string {
  const afterScheme = request.url.slice(request.url.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  const path = slash < 0 ? "/" : afterScheme.slice(slash);
  const q = path.indexOf("?");
  return q < 0 ? path : path.slice(0, q);
}

function parseCredential(credential: string): { id: string; date: string; region: string; service: string } | null {
  const parts = credential.split("/");
  if (parts.length !== 5 || parts[4] !== "aws4_request")
    return null;
  return { id: parts[0]!, date: parts[1]!, region: parts[2]!, service: parts[3]! };
}

/**
 * Verify an S3 request signed with SigV4, in either form (Authorization
 * header or presigned query). Unsigned requests are anonymous.
 */
export async function authorizeS3(request: Request, url: URL, reader: CatalogReader, kek: string | undefined, at = Date.now()): Promise<AccessResult> {
  const header = request.headers.get("authorization");
  const presigned = url.searchParams.get("X-Amz-Signature");
  if (!header?.startsWith("AWS4-HMAC-SHA256 ") && presigned === null)
    return { kind: "anonymous" };

  let credential: string;
  let signedHeaders: string;
  let signature: string;
  let date: string;
  let payloadHash: string;
  let query: [string, string][];
  if (presigned !== null) {
    credential = url.searchParams.get("X-Amz-Credential") ?? "";
    signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    date = url.searchParams.get("X-Amz-Date") ?? "";
    signature = presigned;
    payloadHash = "UNSIGNED-PAYLOAD";
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    if (!Number.isFinite(signedAt) || !Number.isSafeInteger(expires) || signedAt + expires * 1000 < at)
      return { kind: "denied", code: "AccessDenied", message: "Request has expired" };
    query = [...url.searchParams.entries()].filter(([k]) => k !== "X-Amz-Signature");
  }
  else {
    const fields = Object.fromEntries(header!.slice("AWS4-HMAC-SHA256 ".length).split(",").map((f) => {
      const [k, ...v] = f.trim().split("=");
      return [k, v.join("=")];
    })) as Record<string, string | undefined>;
    credential = fields.Credential ?? "";
    signedHeaders = fields.SignedHeaders ?? "";
    signature = fields.Signature ?? "";
    date = request.headers.get("x-amz-date") ?? "";
    payloadHash = request.headers.get("x-amz-content-sha256") ?? "UNSIGNED-PAYLOAD";
    const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    if (!Number.isFinite(signedAt) || Math.abs(signedAt - at) > MAX_CLOCK_SKEW_MS)
      return { kind: "denied", code: "RequestTimeTooSkewed", message: "The difference between the request time and the server's time is too large" };
    query = [...url.searchParams.entries()];
  }

  const scope = parseCredential(credential);
  if (!scope || scope.date !== date.slice(0, 8))
    return { kind: "denied", code: "AuthorizationHeaderMalformed", message: "The credential scope is malformed" };
  const key = await activeKey(reader, scope.id, at);
  if (!key)
    return { kind: "denied", code: "InvalidAccessKeyId", message: "The access key id does not exist in our records" };

  const names = signedHeaders.split(";").filter(Boolean);
  const headers: Record<string, string> = {};
  for (const name of names)
    headers[name] = name === "host" ? (request.headers.get("host") ?? url.host) : (request.headers.get(name) ?? "");
  const credentials = { accessKeyId: key.id, secretAccessKey: await openSecret(kek, key.secretSealed) };
  // Cloudflare rewrites Accept-Encoding before the Worker sees it, and some
  // SDKs (aws-sdk-go-v2, so rclone) sign it. The value the client sent is
  // gone, so the common ones are tried; each try still needs the secret.
  const encodings = names.includes("accept-encoding") ? [headers["accept-encoding"]!, "identity", "gzip", "gzip, deflate", "gzip, deflate, br", "br, gzip", ""] : [undefined];
  for (const encoding of new Set(encodings)) {
    const expected = await signCanonical(
      { method: request.method, path: rawPath(request), query, headers: encoding === undefined ? headers : { ...headers, "accept-encoding": encoding }, payloadHash },
      credentials,
      { region: scope.region, service: scope.service },
      date,
    );
    if (timingSafeEqual(expected.signature, signature))
      return { kind: "granted", keyId: key.id, grants: key.grants };
  }
  return { kind: "denied", code: "SignatureDoesNotMatch", message: "The request signature we calculated does not match the signature you provided" };
}
