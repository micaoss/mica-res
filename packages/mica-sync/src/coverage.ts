// What the mirror actually covers, read off the published index rather than
// remembered from the phases that built it.
//
// The question this answers is not "how many objects" but "which artefact is
// protected by which instrument": a retention decision about a ghcr package is
// safe only where the mirror holds that package's bytes, and the index is the
// only place that says which packages those are. An artefact no row names is
// covered by nothing, and saying so is the point.

import type { ResourceObject } from './objects.ts'

export interface Coverage {
  registry: Map<string, number>
  rowKinds: Map<string, number>
  origins: Map<string, number>
}

const GHCR = /^https:\/\/ghcr\.io\/v2\/([^/]+\/[^/]+)\//

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export function coverageOf(objects: ResourceObject[]): Coverage {
  const registry = new Map<string, number>()
  const rowKinds = new Map<string, number>()
  const origins = new Map<string, number>()
  for (const object of objects) {
    const match = object.origin === undefined ? null : GHCR.exec(object.origin)
    if (match !== null)
      bump(registry, match[1]!)
    if (object.origin !== undefined)
      bump(origins, new URL(object.origin).host)
    for (const pin of object.pins)
      bump(rowKinds, pin.row.split(' ')[0]!)
  }
  return { registry, rowKinds, origins }
}

// The locks the mirror holds, counted separately from everything else because
// of what they are NOT: a mirrored lock makes the release-to-digest BINDING
// survivable, and the chain from the mirror ends at the lock, whose `package`
// rows point into pools nothing mirrors. This row neighbours the pool row; it
// never replaces it.
export function lockCoverage(objects: ResourceObject[]): { objects: number, releases: Set<string> } {
  const held = objects.filter(object => object.kind === 'lock')
  const releases = new Set<string>()
  for (const object of held) {
    for (const pin of object.pins)
      releases.add(`${pin.row.split(' ')[1]!}/${pin.release}`)
  }
  return { objects: held.length, releases }
}

// A `package` row is a Debian package published into an OCI pool. The mirror
// has never enumerated one -- no phase covered the pools -- so if the index
// carries no such row, pool bytes are held by ghcr alone.
export function poolsCovered(coverage: Coverage): boolean {
  return (coverage.rowKinds.get('package') ?? 0) > 0 || (coverage.rowKinds.get('pool') ?? 0) > 0
}

// The releases whose build-env blobs the mirror actually holds. A tag is safe
// to lose only where the bytes of THAT release are held, not where some
// release of the same image is.
export function imageReleases(objects: ResourceObject[]): Set<string> {
  const releases = new Set<string>()
  for (const object of objects) {
    for (const pin of object.pins) {
      if (pin.row.startsWith('image ') && /^[0-9]{8}-[0-9]{4}$/.test(pin.release))
        releases.add(pin.release)
    }
  }
  return releases
}
