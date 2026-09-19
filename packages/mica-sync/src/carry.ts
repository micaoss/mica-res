// Carrying the v1 bytes forward instead of fetching them again.
//
// The old mirror wrote every object as `blob/<aa>/<sha256>` in the same public
// bucket the new service serves, so those keys still answer on the download
// host. That is an accident of the old layout, not a route to build on -- but
// it is an https origin holding bytes whose hash is known, which is exactly
// what the control plane's server-side pull takes.
//
// It is safe for one reason only: the key is the content's sha256. If an
// object at that key hashes to what a lock names, it IS what the lock names,
// wherever it came from. The service verifies the digest while staging, so a
// mismatch is refused there rather than trusted here.

export function legacyBlobUrl(downloadBase: string, sha256: string): string {
  return `${downloadBase}/blob/${sha256.slice(0, 2)}/${sha256}`
}

/** The carried origin for a digest, or undefined to fetch it from upstream. */
export async function carriedOrigin(downloadBase: string, sha256: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const url = legacyBlobUrl(downloadBase, sha256)
  const head = await fetcher(url, { method: 'HEAD' })
  // Anything but a clean 200 means fetch it from upstream: a 5xx must never
  // read as "the bucket has it".
  return head.status === 200 ? url : undefined
}
