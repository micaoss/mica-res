// The CONTRACT check for git packs.
//
// A consumer is told: fetch `upstream/git/<name>/<commit>.json`, then the
// chunks in order under that same name. So the thing to verify is not that the
// objects exist somewhere -- it is that EVERY CHUNK A MANIFEST DECLARES
// RESOLVES UNDER THAT MANIFEST'S OWN NAME.
//
// Neither the audit nor the reconciliation could see the gap this exists for:
// two packs of one commit shared their first chunk, the shared object was
// stored under one tree's name only, and the other tree's `pack.00` was a NAME
// the catalogue never carried. An object-set comparison cancels it out on both
// sides; only walking the contract finds it.

export interface PackManifest {
  commit: string
  chunks: { sha256: string, size: number }[]
}

export interface ChunkKey {
  key: string
  sha256: string
}

export function manifestKey(name: string, commit: string): string {
  return `upstream/git/${name}/${commit}.json`
}

export function chunkKeys(name: string, manifest: PackManifest): ChunkKey[] {
  return manifest.chunks.map((chunk, index) => ({
    key: `upstream/git/${name}/${manifest.commit}.pack.${String(index).padStart(2, '0')}`,
    sha256: chunk.sha256,
  }))
}

/** The declared chunks that do not resolve under their own name. */
export async function missingChunks(download: string, name: string, manifest: PackManifest, fetcher: typeof fetch = fetch): Promise<ChunkKey[]> {
  const missing: ChunkKey[] = []
  for (const chunk of chunkKeys(name, manifest)) {
    const answer = await fetcher(`${download}/${chunk.key}`, { method: 'HEAD' })
    if (answer.status === 404) {
      missing.push(chunk)
      continue
    }
    // Anything else unexpected is an error, not an absence: a 5xx read as
    // "missing" would have this check repairing objects that are already there.
    if (!answer.ok)
      throw new Error(`${answer.status} for ${chunk.key}`)
  }
  return missing
}
