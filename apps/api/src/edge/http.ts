/**
 * res.micaos.dev at the edge. Nothing here returns the bytes of a public
 * object: an object is a redirect to the download host, a directory is a
 * listing built from the catalog, a legacy URL is a redirect, and a
 * protected object is a redirect to a short-lived presigned URL. Only the
 * admin API reaches the Durable Object; this returns `null` for it.
 */
import type { CatalogReader } from "./catalog-reader";
import type { CatalogNamespace, CatalogObject } from "@/modules/resource/catalog";
import type { ResStore } from "@/modules/resource/storage/types";
import { grantsAllow } from "@/modules/resource/access/keys";
import { findObject, listShard, lowerBound } from "@/modules/resource/catalog";
import { encodeKeyPath } from "@/modules/resource/paths";
import { authorizeHttp } from "./access";
import { renderListing } from "./listing";

export interface EdgeDeps {
  readonly reader: CatalogReader;
  readonly store: (binding: string) => ResStore;
  readonly assets: { fetch: (request: Request) => Promise<Response> } | undefined;
  readonly kek: string | undefined;
  readonly adminBase: string;
  readonly presignTtlSeconds?: number;
}

const OBJECT_REDIRECT_CACHE = "public, max-age=300";
const ALIAS_REDIRECT_CACHE = "public, max-age=60";
const LEGACY_REDIRECT_CACHE = "public, max-age=3600";
const LISTING_CACHE = "public, max-age=30";

function jsonError(status: number, code: string, message: string, extra: HeadersInit = {}): Response {
  return Response.json({ success: false, error: { code, message } }, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*", ...extra } });
}

function redirect(location: string, status: 301 | 302 | 307, cacheControl: string): Response {
  return new Response(null, { status, headers: { "location": location, "cache-control": cacheControl, "access-control-allow-origin": "*" } });
}

function downloadUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeKeyPath(key)}`;
}

/** Decode a URL path into key segments; `null` when a segment is malformed. */
export function decodePath(pathname: string): string[] | null {
  try {
    const segments = pathname.split("/").slice(1).map(decodeURIComponent);
    return segments.some(s => s.includes("/") || s === "." || s === "..") ? null : segments;
  }
  catch {
    return null;
  }
}

function wantsJson(request: Request, url: URL): boolean {
  return url.searchParams.get("format") === "json" || (request.headers.get("accept") ?? "").includes("application/json");
}

export async function handleResHost(request: Request, deps: EdgeDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const admin = deps.adminBase;

  if (path === `${admin}/api` || path.startsWith(`${admin}/api/`))
    return null;
  if (path === admin)
    return redirect(`${admin}/`, 301, LEGACY_REDIRECT_CACHE);
  if (path.startsWith(`${admin}/`))
    return serveAsset(request, url, deps, `${admin}/`);

  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "authorization, range" } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return jsonError(405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are served here", { allow: "GET, HEAD" });

  if (path === "/" || path === "/index.html" || path.startsWith("/_site/") || path === "/favicon.ico" || path === "/favicon.svg")
    return serveAsset(request, url, deps, "/");
  if (path === "/.well-known/res.json")
    return siteJson(deps);
  if (path === "/v2" || path.startsWith("/v2/"))
    return registry(request, path, deps);

  const segments = decodePath(path);
  if (!segments)
    return jsonError(400, "BAD_PATH", "Malformed path");

  const manifest = await deps.reader.manifest();
  if (!manifest)
    return jsonError(503, "CATALOG_UNAVAILABLE", "No catalog has been published yet");
  const base = manifest.site.download;

  // Legacy v1 URLs.
  if (segments[0] === "blob" && segments.length === 3) {
    const key = (await deps.reader.digests())[segments[2]!];
    return key && segments[2]!.startsWith(segments[1]!) ? redirect(downloadUrl(base, key), 302, LEGACY_REDIRECT_CACHE) : jsonError(404, "NOT_FOUND", "No object has this digest");
  }
  if (segments[0] === "d") {
    const target = (await deps.reader.redirects())[`/${segments.join("/")}`];
    if (target)
      return redirect(downloadUrl(base, target), 302, LEGACY_REDIRECT_CACHE);
    return resolveNamespacePath(request, url, segments.slice(1), deps, base, true);
  }
  if (segments[0] === "index" && segments.length === 2)
    return redirect(downloadUrl(base, segments.join("/")), 302, "no-store");

  return resolveNamespacePath(request, url, segments, deps, base, false);
}

async function resolveNamespacePath(request: Request, url: URL, segments: string[], deps: EdgeDeps, base: string, legacy: boolean): Promise<Response> {
  const [name, ...rest] = segments;
  const ns = name ? await deps.reader.namespace(name) : undefined;
  if (!ns)
    return jsonError(404, "NOT_FOUND", "No such namespace");
  if (rest.length === 0 && !legacy)
    return redirect(`/${encodeURIComponent(ns.name)}/`, 301, LEGACY_REDIRECT_CACHE);

  const isDirectory = rest.length === 0 || rest.at(-1) === "";
  const relative = rest.filter((s, i) => s !== "" || i < rest.length - 1).join("/");
  const prefix = isDirectory ? (relative === "" ? "" : `${relative}/`) : relative;

  if (ns.visibility === "protected") {
    const access = await authorizeHttp(request, url, `${ns.name}/${prefix}`, deps.reader, deps.kek);
    if (access.kind === "denied")
      return jsonError(403, access.code, access.message);
    if (access.kind === "anonymous" || !grantsAllow(access.grants, ns.name, prefix))
      return jsonError(401, "KEY_REQUIRED", "This namespace needs an access key", { "www-authenticate": "Bearer realm=\"res\"" });
  }

  const shard = await deps.reader.shard(ns);
  if (!shard)
    return jsonError(503, "CATALOG_UNAVAILABLE", "The namespace catalog is missing");

  if (isDirectory) {
    if (ns.siteMode) {
      const index = findObject(shard, `${prefix}index.html`);
      if (index)
        return objectRedirect(ns, index, deps, base);
    }
    if (!ns.listable)
      return jsonError(404, "NOT_FOUND", "This namespace is not listable");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1000, 1), 1000);
    const listing = listShard(shard, { prefix, delimiter: "/", after: url.searchParams.get("after") ?? undefined, limit });
    if (prefix !== "" && listing.directories.length === 0 && listing.objects.length === 0 && url.searchParams.get("after") === null)
      return jsonError(404, "NOT_FOUND", "No such directory");
    const headers = { "cache-control": ns.visibility === "protected" ? "private, no-store" : LISTING_CACHE, "access-control-allow-origin": "*" };
    if (wantsJson(request, url)) {
      return Response.json({
        namespace: ns.name,
        prefix,
        directories: listing.directories.map(d => ({ name: d.slice(prefix.length), path: d })),
        objects: listing.objects.map(o => ({
          name: o.path.slice(prefix.length),
          path: o.path,
          size: o.size,
          sha256: o.sha256,
          etag: o.etag,
          contentType: o.contentType,
          publishedAt: o.publishedAt,
          url: ns.visibility === "public" ? downloadUrl(base, `${ns.name}/${o.path}`) : null,
        })),
        next: listing.next ?? null,
      }, { headers });
    }
    return new Response(renderListing(ns, prefix, listing, base), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }

  const object = findObject(shard, prefix);
  if (object)
    return objectRedirect(ns, object, deps, base);
  const alias = shard.aliases[prefix];
  if (alias) {
    const target = findObject(shard, alias);
    if (target && ns.visibility === "public")
      return redirect(downloadUrl(base, `${ns.name}/${target.path}`), 302, ALIAS_REDIRECT_CACHE);
    if (target)
      return objectRedirect(ns, target, deps, base);
    // An alias to a directory.
    return redirect(`/${encodeKeyPath(`${ns.name}/${alias}`)}/`, 302, ALIAS_REDIRECT_CACHE);
  }
  // A directory named without its trailing slash.
  const next = shard.objects[lowerBound(shard.objects, `${prefix}/`)];
  if (next?.path.startsWith(`${prefix}/`))
    return redirect(`/${encodeKeyPath(`${ns.name}/${prefix}`)}/`, 301, LISTING_CACHE);
  return jsonError(404, "NOT_FOUND", "No such object");
}

async function objectRedirect(ns: CatalogNamespace, object: CatalogObject, deps: EdgeDeps, base: string): Promise<Response> {
  const key = `${ns.name}/${object.path}`;
  if (ns.visibility === "public")
    return redirect(downloadUrl(base, key), 302, OBJECT_REDIRECT_CACHE);
  const store = deps.store(ns.store);
  const url = await store.presignGet(key, deps.presignTtlSeconds ?? 300);
  if (url !== null)
    return redirect(url, 302, "private, no-store");
  // No S3 credentials to sign with: a protected object is streamed here.
  // Public objects never take this path -- they are redirected above.
  const streamed = await store.getStream(key);
  if (!streamed)
    return jsonError(404, "NOT_FOUND", "No such object");
  return new Response(streamed.body, {
    headers: {
      "content-type": streamed.info.contentType ?? object.contentType,
      "content-length": String(streamed.info.size),
      "etag": `"${streamed.info.etag}"`,
      "x-checksum-sha256": object.sha256,
      "cache-control": "private, no-store",
    },
  });
}

/**
 * An asset, or the SPA's entry for a client-side route. The fallback is the
 * directory, never `index.html` by name: the asset pipeline answers that with
 * a 307 to the directory, which the SPA then sends to its login route, which
 * falls back again -- a redirect loop.
 */
async function serveAsset(request: Request, url: URL, deps: EdgeDeps, fallback: string): Promise<Response> {
  if (!deps.assets)
    return jsonError(404, "NOT_FOUND", "No static assets are bound");
  const res = await deps.assets.fetch(new Request(url, request));
  if (res.status !== 404 || request.method !== "GET")
    return res;
  return deps.assets.fetch(new Request(new URL(fallback, url), request));
}

async function siteJson(deps: EdgeDeps): Promise<Response> {
  const manifest = await deps.reader.manifest();
  if (!manifest)
    return jsonError(503, "CATALOG_UNAVAILABLE", "No catalog has been published yet");
  return Response.json({
    site: manifest.site,
    namespaces: manifest.namespaces.map(n => ({
      name: n.name,
      title: n.title,
      description: n.description,
      visibility: n.visibility,
      listable: n.listable,
      objects: n.objects,
      bytes: n.bytes,
      examples: n.examples,
    })),
    registry: Object.keys(manifest.registry).sort(),
    snapshot: { version: manifest.version, publishedAt: manifest.publishedAt },
  }, { headers: { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" } });
}

function registryError(status: number, code: string, message: string): Response {
  return Response.json({ errors: [{ code, message }] }, { status, headers: { "docker-distribution-api-version": "registry/2.0", "cache-control": "no-store" } });
}

/**
 * The read side of the distribution API for the build-env images. A blob is
 * a redirect to the download host (clients follow blob redirects); a
 * manifest is small and served here, because clients do not reliably follow
 * a redirect for one.
 */
async function registry(request: Request, path: string, deps: EdgeDeps): Promise<Response> {
  if (path === "/v2" || path === "/v2/")
    return Response.json({}, { headers: { "docker-distribution-api-version": "registry/2.0", "cache-control": "public, max-age=300" } });
  const match = /^\/v2\/([a-z0-9][\w./-]*)\/(manifests|blobs)\/([^/]+)$/.exec(path);
  if (!match || path.includes(".."))
    return registryError(404, "NAME_UNKNOWN", "Unknown repository or route");
  const [, repository, kind, reference] = match as unknown as [string, string, string, string];
  const manifest = await deps.reader.manifest();
  if (!manifest)
    return registryError(503, "UNAVAILABLE", "No catalog has been published yet");

  let digest = /^sha256:[0-9a-f]{64}$/.test(reference) ? reference.slice(7) : undefined;
  if (!digest && kind === "manifests")
    digest = manifest.registry[repository]?.[reference]?.slice(7);
  if (!digest)
    return registryError(404, kind === "manifests" ? "MANIFEST_UNKNOWN" : "BLOB_UNKNOWN", "Unknown reference");
  const key = `oci/blobs/sha256/${digest}`;
  if ((await deps.reader.digests())[digest] === undefined)
    return registryError(404, kind === "manifests" ? "MANIFEST_UNKNOWN" : "BLOB_UNKNOWN", "Not mirrored");

  if (kind === "blobs")
    return new Response(null, { status: 307, headers: { "location": downloadUrl(manifest.site.download, key), "docker-content-digest": `sha256:${digest}`, "cache-control": "public, max-age=3600" } });

  const oci = await deps.reader.namespace("oci");
  const shard = oci ? await deps.reader.shard(oci) : null;
  const object = shard ? findObject(shard, `blobs/sha256/${digest}`) : undefined;
  if (!object)
    return registryError(404, "MANIFEST_UNKNOWN", "Not mirrored");
  const text = await deps.store(oci!.store).getText(key);
  if (text === null)
    return registryError(404, "MANIFEST_UNKNOWN", "Not mirrored");
  return new Response(request.method === "HEAD" ? null : text, {
    headers: {
      "content-type": object.contentType,
      "content-length": String(object.size),
      "docker-content-digest": `sha256:${digest}`,
      "docker-distribution-api-version": "registry/2.0",
      "etag": `"sha256:${digest}"`,
      "cache-control": reference.startsWith("sha256:") ? "public, max-age=31536000, immutable" : "public, max-age=60",
    },
  });
}
