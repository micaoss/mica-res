// The loop the `mirrors` member was accepted to close.
//
// `mica-index.json` names, for every image and update archive, a URL, its
// sha256 and its size -- and now a mirror URL derived from a committed prefix.
// So the check is exactly the one a device would do: fetch the MIRROR URL and
// compare the bytes' digest with the one the index names beside it. A mirror
// is a source and never a trust anchor, which is only true if somebody
// actually verifies it.

export interface MirrorEntry {
  file: string
  mirror: string
  sha256: string
  size: number
}

interface Asset {
  file: string
  mirrors?: string[]
  sha256: string
  size: number
}

interface Index {
  version: string
  products: { product: string, images?: Asset[], updates?: Asset[] }[]
}

export function mirrorEntries(index: Index): MirrorEntry[] {
  return index.products.flatMap(product =>
    [...(product.images ?? []), ...(product.updates ?? [])].flatMap(asset =>
      (asset.mirrors ?? []).map(mirror => ({ file: asset.file, mirror, sha256: asset.sha256, size: asset.size }))))
}

export interface MirrorResult {
  /** Bytes served that hash to something other than the index's digest. */
  wrong: string[]
  /** Named by the index and not mirrored yet: the one-cycle lag, not a defect. */
  pending: string[]
  /** Answered and verified. */
  verified: number
}

/**
 * A 404 means "not mirrored yet" -- an index is cut the moment a release is,
 * and the sync catches up on its next run, so the lag is the steady state. A
 * 200 whose bytes hash to something else is a defect at any time. Same split
 * as everywhere: report what means later, refuse what means wrong.
 */
export async function checkMirrors(entries: MirrorEntry[], fetcher: typeof fetch = fetch): Promise<MirrorResult> {
  const wrong: string[] = []
  const pending: string[] = []
  let verified = 0
  for (const entry of entries) {
    const answer = await fetcher(entry.mirror, { redirect: 'follow' })
    if (answer.status === 404) {
      pending.push(`${entry.file}: not mirrored yet`)
      continue
    }
    if (!answer.ok) {
      wrong.push(`${entry.file}: ${answer.status} from ${entry.mirror}`)
      continue
    }
    const bytes = new Uint8Array(await answer.arrayBuffer())
    const digest = Bun.SHA256.hash(bytes, 'hex')
    if (digest === entry.sha256)
      verified += 1
    else
      wrong.push(`${entry.file}: the mirror serves ${bytes.length} bytes hashing to ${digest}, the index names ${entry.size} and ${entry.sha256}`)
  }
  return { wrong, pending, verified }
}
