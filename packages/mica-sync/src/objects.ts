// One R2 object per distinct byte string. A row of a producer's lock becomes an
// object with the pins that reach it; the same bytes pinned by two producers are
// one object with two pins.

import type { SourceRow, UpstreamRow } from './locks.ts'

export type Kind = 'deb' | 'source' | 'oci-blob' | 'product-image' | 'update-archive' | 'git-pack' | 'lock'

export interface Pin {
  repository: string
  lock: string
  release: string
  row: string
}

export type State = 'mirrored' | 'pending'

export interface ResourceObject {
  kind: Kind
  // Whether the bucket holds these bytes. A pinned object the sync has not
  // uploaded yet is `pending`, so the index and the site never claim it.
  state?: State
  sha256: string
  size?: number
  // The OCI media type, for the objects a registry client asks for by name.
  mediaType?: string
  // The commit a git pack carries. Git verifies every object it imports and
  // the consumer asserts this commit, so the commit -- not the pack's own
  // sha256 -- is what a pack is trusted by.
  commit?: string
  origin?: string
  path: string
  // Every readable download path that resolves to these bytes; one byte
  // string can be pinned under more than one name.
  readable: string[]
  pins: Pin[]
}

export interface PinSource {
  repository: string
  lock: string
  release: string
}

export function blobPath(sha256: string): string {
  return `blob/${sha256.slice(0, 2)}/${sha256}`
}

function fileName(url: string): string {
  return new URL(url).pathname.split('/').pop()!
}

// mica-system-base's existing mirror hook rewrites a Debian URL as
// `<base>/pool/<tail>` (`MICA_BASE_MIRROR=pool:<base>`, src/cache.ts
// mirrorUrl), so every Debian archive also answers under that shape. That is
// what lets a consumer use the mirror with a CI variable and no code change.
function debianPoolAlias(url: string): string | undefined {
  const index = url.indexOf('/pool/')
  return index < 0 ? undefined : `upstream/debian/pool/${url.slice(index + '/pool/'.length)}`
}

export function objectFromSourceRow(row: SourceRow | UpstreamRow, pin: PinSource): ResourceObject {
  const kind: Kind = row.url.endsWith('.deb') ? 'deb' : 'source'
  const alias = kind === 'deb' ? debianPoolAlias(row.url) : undefined
  return {
    kind,
    sha256: row.sha256,
    origin: row.url,
    path: blobPath(row.sha256),
    readable: [
      `upstream/${kind}/${row.name}/${fileName(row.url)}`,
      ...(alias === undefined ? [] : [alias]),
    ],
    pins: [{ ...pin, row: `source ${row.name} ${row.arch}` }],
  }
}

export function mergeObjects(objects: ResourceObject[]): ResourceObject[] {
  const byDigest = new Map<string, ResourceObject>()
  const byReadable = new Map<string, string>()
  for (const object of objects) {
    for (const readable of object.readable) {
      const claimed = byReadable.get(readable)
      if (claimed !== undefined && claimed !== object.sha256)
        throw new Error(`readable-clash: ${readable} is claimed by ${claimed} and ${object.sha256}`)
      byReadable.set(readable, object.sha256)
    }

    const held = byDigest.get(object.sha256)
    if (held === undefined) {
      byDigest.set(object.sha256, { ...object, readable: [...object.readable], pins: [...object.pins] })
      continue
    }
    for (const readable of object.readable) {
      if (!held.readable.includes(readable))
        held.readable.push(readable)
    }
    for (const pin of object.pins) {
      const seen = held.pins.some(p => p.repository === pin.repository && p.lock === pin.lock && p.row === pin.row && p.release === pin.release)
      if (!seen)
        held.pins.push(pin)
    }
  }
  return [...byDigest.values()]
}

// What an enumeration holds, per kind. Reported in the sync's own output; it
// describes a run rather than the mirror, so nothing reads it back.
export function summarise(objects: ResourceObject[]): { kind: Kind, count: number, bytes: number, sizesUnknown: number, mirrored: number, mirroredBytes: number }[] {
  const rows = new Map<Kind, { kind: Kind, count: number, bytes: number, sizesUnknown: number, mirrored: number, mirroredBytes: number }>()
  for (const object of objects) {
    const row = rows.get(object.kind) ?? { kind: object.kind, count: 0, bytes: 0, sizesUnknown: 0, mirrored: 0, mirroredBytes: 0 }
    row.count += 1
    row.bytes += object.size ?? 0
    if (object.size === undefined)
      row.sizesUnknown += 1
    if (object.state === 'mirrored') {
      row.mirrored += 1
      row.mirroredBytes += object.size ?? 0
    }
    rows.set(object.kind, row)
  }
  return [...rows.values()]
}
