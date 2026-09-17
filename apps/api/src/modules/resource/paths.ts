/**
 * The normative directory layout: `<namespace>/<path>` is at once the object
 * key in its bucket, the URL path on the download host and the S3
 * `bucket/key` on the S3 host. Everything that names a resource goes through
 * these checks, so a key that one surface accepts every surface accepts.
 */

/** First segments that belong to the service itself, never to a namespace. */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "admin",
  "v2",
  "blob",
  "d",
  "index",
  "w",
  "_site",
  "_catalog",
  "_access",
  "_staging",
  ".well-known",
]);

const RE_NAMESPACE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RE_SEGMENT = /^[A-Z0-9][\w.+~@=-]*$/i;
const RE_LOWER_SEGMENT = /^[a-z0-9][a-z0-9._+~@=-]*$/;
const MAX_SEGMENTS = 16;
const MAX_KEY_BYTES = 1024;

export function isValidNamespaceName(name: string): boolean {
  return RE_NAMESPACE.test(name) && !RESERVED_SEGMENTS.has(name) && !name.includes("--");
}

/**
 * Why `path` (the part below the namespace) is not a valid object path, or
 * `null` when it is.
 */
export function objectPathProblem(namespace: string, path: string): string | null {
  if (!isValidNamespaceName(namespace))
    return `"${namespace}" is not a valid namespace name`;
  if (path === "")
    return "the path is empty";
  const segments = path.split("/");
  if (segments.length > MAX_SEGMENTS)
    return `the path has more than ${MAX_SEGMENTS} segments`;
  for (const [i, segment] of segments.entries()) {
    if (segment === "")
      return "the path has an empty segment";
    if (segment === "." || segment === "..")
      return "the path has a relative segment";
    if (!RE_SEGMENT.test(segment))
      return `the segment "${segment}" has characters outside [A-Za-z0-9._+~@=-]`;
    if (i === 0 && segments.length > 1 && !RE_LOWER_SEGMENT.test(segment))
      return `the first directory "${segment}" must be lowercase`;
  }
  if (new TextEncoder().encode(objectKey(namespace, path)).length > MAX_KEY_BYTES)
    return `the key is longer than ${MAX_KEY_BYTES} bytes`;
  return null;
}

export function objectKey(namespace: string, path: string): string {
  return `${namespace}/${path}`;
}

/** Split a key into its namespace and path; `null` for a key with no path. */
export function splitKey(key: string): { namespace: string; path: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1)
    return null;
  return { namespace: key.slice(0, slash), path: key.slice(slash + 1) };
}

/** A directory prefix below a namespace: empty, or segments ending in `/`. */
export function isValidDirectoryPrefix(prefix: string): boolean {
  if (prefix === "")
    return true;
  if (!prefix.endsWith("/"))
    return false;
  return prefix.slice(0, -1).split("/").every(s => s !== "" && s !== "." && s !== ".." && RE_SEGMENT.test(s));
}

/** Percent-encode a key for a URL path, segment by segment (RFC 3986). */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
