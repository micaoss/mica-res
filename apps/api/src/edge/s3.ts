/**
 * s3.res.micaos.dev: the anonymous, read-only subset of the S3 API, path
 * style, with a namespace as the bucket. Listing and HEAD answer from the
 * catalog; GetObject is a 307 to the download host (or, for a protected
 * namespace, to a presigned R2 URL), so no object bytes pass through here.
 */
import type { AccessResult } from "./access";
import type { CatalogReader } from "./catalog-reader";
import type { CatalogNamespace, CatalogObject } from "@/modules/resource/catalog";
import type { ResStore } from "@/modules/resource/storage/types";
import { grantsAllow, grantsNamespace } from "@/modules/resource/access/keys";
import { findObject, listShard } from "@/modules/resource/catalog";
import { encodeKeyPath, encodeRfc3986 } from "@/modules/resource/paths";
import { authorizeS3, rawPath } from "./access";

export interface S3Deps {
  readonly reader: CatalogReader;
  readonly store: (binding: string) => ResStore;
  readonly kek: string | undefined;
}

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
const NS = "http://s3.amazonaws.com/doc/2006-03-01/";

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function requestId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
}

function xml(body: string, status = 200, extra: HeadersInit = {}): Response {
  return new Response(`${XML_HEADER}${body}`, { status, headers: { "content-type": "application/xml", "x-amz-request-id": requestId(), "cache-control": "no-store", ...extra } });
}

export function s3Error(status: number, code: string, message: string, resource: string, method = "GET"): Response {
  if (method === "HEAD")
    return new Response(null, { status, headers: { "x-amz-request-id": requestId(), "x-amz-error-code": code } });
  return xml(`<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><Resource>${xmlEscape(resource)}</Resource><RequestId>${requestId()}</RequestId></Error>`, status);
}

function httpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  }
  catch {
    return null;
  }
}

/** Bucket and key from a path-style URL; the key keeps its inner slashes. */
function parse(request: Request): { bucket: string; key: string } | null {
  const path = rawPath(request);
  const trimmed = path.replace(/^\/+/, "");
  if (trimmed === "")
    return { bucket: "", key: "" };
  const slash = trimmed.indexOf("/");
  const bucket = decode(slash < 0 ? trimmed : trimmed.slice(0, slash));
  const key = slash < 0 ? "" : trimmed.slice(slash + 1).split("/").map(decode);
  if (bucket === null || (Array.isArray(key) && key.includes(null)))
    return null;
  return { bucket, key: Array.isArray(key) ? key.join("/") : key };
}

function mayRead(ns: CatalogNamespace, access: AccessResult, path: string): boolean {
  return ns.visibility === "public" || (access.kind === "granted" && grantsAllow(access.grants, ns.name, path));
}

export async function handleS3Host(request: Request, deps: S3Deps): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parse(request);
  const resource = url.pathname;
  if (!parsed)
    return s3Error(400, "InvalidURI", "Couldn't parse the specified URI.", resource, request.method);
  if (request.method !== "GET" && request.method !== "HEAD")
    return s3Error(403, "AccessDenied", "This endpoint is read-only.", resource, request.method);

  const access = await authorizeS3(request, url, deps.reader, deps.kek);
  if (access.kind === "denied")
    return s3Error(403, access.code, access.message, resource, request.method);

  const manifest = await deps.reader.manifest();
  if (!manifest)
    return s3Error(503, "ServiceUnavailable", "No catalog has been published yet.", resource, request.method);

  if (parsed.bucket === "")
    return listBuckets(manifest.namespaces, access, manifest.publishedAt);

  const ns = manifest.namespaces.find(n => n.name === parsed.bucket);
  const visible = ns && (ns.visibility === "public" || (access.kind === "granted" && grantsNamespace(access.grants, ns.name)));
  if (!ns || !visible) {
    if (ns && access.kind === "anonymous")
      return s3Error(403, "AccessDenied", "Access Denied", resource, request.method);
    return s3Error(404, "NoSuchBucket", "The specified bucket does not exist", resource, request.method);
  }

  if (parsed.key === "") {
    if (request.method === "HEAD")
      return new Response(null, { status: 200, headers: { "x-amz-request-id": requestId(), "x-amz-bucket-region": "auto" } });
    if (url.searchParams.has("location"))
      return xml(`<LocationConstraint xmlns="${NS}">auto</LocationConstraint>`);
    for (const unsupported of ["versioning", "acl", "policy", "cors", "lifecycle", "uploads", "tagging", "website", "encryption", "versions"]) {
      if (url.searchParams.has(unsupported))
        return s3Error(501, "NotImplemented", "A header you provided implies functionality that is not implemented", resource);
    }
    return listObjects(url, ns, access, deps);
  }

  if (url.searchParams.has("uploadId") || url.searchParams.has("partNumber") || url.searchParams.has("acl") || url.searchParams.has("tagging"))
    return s3Error(501, "NotImplemented", "A header you provided implies functionality that is not implemented", resource, request.method);

  if (!mayRead(ns, access, parsed.key))
    return s3Error(403, "AccessDenied", "Access Denied", resource, request.method);
  const shard = await deps.reader.shard(ns);
  const object = shard ? findObject(shard, parsed.key) : undefined;
  if (!object)
    return s3Error(404, "NoSuchKey", "The specified key does not exist.", resource, request.method);

  if (request.method === "HEAD")
    return new Response(null, { status: 200, headers: objectHeaders(object) });
  return getObject(ns, object, manifest.site.download, deps, resource);
}

function objectHeaders(object: CatalogObject): Record<string, string> {
  return {
    "content-length": String(object.size),
    "content-type": object.contentType,
    "etag": `"${object.etag}"`,
    "last-modified": httpDate(object.publishedAt),
    "accept-ranges": "bytes",
    "x-amz-meta-sha256": object.sha256,
    "x-amz-request-id": requestId(),
  };
}

async function getObject(ns: CatalogNamespace, object: CatalogObject, downloadBase: string, deps: S3Deps, resource: string): Promise<Response> {
  const key = `${ns.name}/${object.path}`;
  let location: string;
  if (ns.visibility === "public") {
    location = `${downloadBase.replace(/\/+$/, "")}/${encodeKeyPath(key)}`;
  }
  else {
    try {
      location = await deps.store(ns.store).presignGet(key, 300);
    }
    catch {
      return s3Error(503, "ServiceUnavailable", "Protected downloads are not configured.", resource);
    }
  }
  return new Response(null, { status: 307, headers: { "location": location, "x-amz-request-id": requestId(), "cache-control": ns.visibility === "public" ? "public, max-age=300" : "private, no-store" } });
}

function listBuckets(namespaces: readonly CatalogNamespace[], access: AccessResult, created: string): Response {
  const buckets = namespaces
    .filter(n => n.visibility === "public" || (access.kind === "granted" && grantsNamespace(access.grants, n.name)))
    .map(n => `<Bucket><Name>${xmlEscape(n.name)}</Name><CreationDate>${created}</CreationDate></Bucket>`)
    .join("");
  const owner = access.kind === "granted" ? access.keyId : "anonymous";
  return xml(`<ListAllMyBucketsResult xmlns="${NS}"><Owner><ID>${owner}</ID><DisplayName>${owner}</DisplayName></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`);
}

function b64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): string | undefined {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
  }
  catch {
    return undefined;
  }
}

async function listObjects(url: URL, ns: CatalogNamespace, access: AccessResult, deps: S3Deps): Promise<Response> {
  const q = url.searchParams;
  const v2 = q.get("list-type") === "2";
  const prefix = q.get("prefix") ?? "";
  const delimiter = q.get("delimiter") || undefined;
  const maxKeys = Math.min(Math.max(Number(q.get("max-keys") ?? 1000) || 0, 0), 1000);
  const encode = q.get("encoding-type") === "url";
  const enc = (value: string) => (encode ? value.split("/").map(encodeRfc3986).join("/") : xmlEscape(value));
  const token = q.get("continuation-token");
  const startAfter = q.get("start-after") ?? undefined;
  const marker = q.get("marker") ?? undefined;
  const after = v2 ? (token ? unb64url(token) : startAfter) : marker;
  if (v2 && token && after === undefined)
    return s3Error(400, "InvalidArgument", "The continuation token provided is incorrect", url.pathname);

  const shard = await deps.reader.shard(ns);
  let listing = shard ? listShard(shard, { prefix, delimiter, after, limit: maxKeys }) : { prefix, directories: [], objects: [], next: undefined };
  if (ns.visibility === "protected" && access.kind === "granted") {
    listing = {
      ...listing,
      objects: listing.objects.filter(o => grantsAllow(access.grants, ns.name, o.path)),
      directories: listing.directories.filter(d => access.grants.some(g => g.namespace === ns.name && (d.startsWith(g.prefix) || g.prefix.startsWith(d)))),
    };
  }
  const truncated = maxKeys > 0 && listing.next !== undefined;
  const contents = listing.objects.map(o => `<Contents><Key>${enc(o.path)}</Key><LastModified>${new Date(o.publishedAt).toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("");
  const common = listing.directories.map(d => `<CommonPrefixes><Prefix>${enc(d)}</Prefix></CommonPrefixes>`).join("");
  const head = [
    `<Name>${xmlEscape(ns.name)}</Name>`,
    `<Prefix>${enc(prefix)}</Prefix>`,
    v2 ? `<KeyCount>${listing.objects.length + listing.directories.length}</KeyCount>` : `<Marker>${enc(marker ?? "")}</Marker>`,
    `<MaxKeys>${maxKeys}</MaxKeys>`,
    delimiter ? `<Delimiter>${enc(delimiter)}</Delimiter>` : "",
    encode ? "<EncodingType>url</EncodingType>" : "",
    `<IsTruncated>${truncated}</IsTruncated>`,
    v2 && token ? `<ContinuationToken>${xmlEscape(token)}</ContinuationToken>` : "",
    v2 && truncated ? `<NextContinuationToken>${b64url(listing.next!)}</NextContinuationToken>` : "",
    v2 && startAfter ? `<StartAfter>${enc(startAfter)}</StartAfter>` : "",
    !v2 && truncated && delimiter ? `<NextMarker>${enc(listing.next!)}</NextMarker>` : "",
  ].join("");
  return xml(`<ListBucketResult xmlns="${NS}">${head}${contents}${common}</ListBucketResult>`);
}
