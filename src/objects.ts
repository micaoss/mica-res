// One R2 object per distinct byte string. A row of a producer's lock becomes an
// object with the pins that reach it; the same bytes pinned by two producers are
// one object with two pins.

import type { SourceRow, UpstreamRow } from './locks.ts'

export type Kind = 'deb' | 'source' | 'oci-blob' | 'product-image' | 'update-archive' | 'git-pack'

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

export function objectFromSourceRow(row: SourceRow | UpstreamRow, pin: PinSource): ResourceObject {
  const kind: Kind = row.url.endsWith('.deb') ? 'deb' : 'source'
  return {
    kind,
    sha256: row.sha256,
    origin: row.url,
    path: blobPath(row.sha256),
    readable: [`/d/upstream/${kind}/${row.name}/${fileName(row.url)}`],
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
