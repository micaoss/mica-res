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
  // Per ghcr package, the releases whose bytes the mirror actually holds FROM
  // ghcr. This is the predicate the guard asks, and it is deliberately about
  // the bytes' origin rather than about a row's name: a check that can be
  // satisfied by something other than its reason retires itself confidently,
  // which is worse than a record that merely goes stale.
  releases: Map<string, Set<string>>
  rowKinds: Map<string, number>
  origins: Map<string, number>
}

const GHCR = /^https:\/\/ghcr\.io\/v2\/([^/]+\/[^/]+)\//

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const STAMP = /^(?:.+\.)?([0-9]{8}-[0-9]{4})$/

export function coverageOf(objects: ResourceObject[]): Coverage {
  const registry = new Map<string, number>()
  const releases = new Map<string, Set<string>>()
  const rowKinds = new Map<string, number>()
  const origins = new Map<string, number>()
  for (const object of objects) {
    const match = object.origin === undefined ? null : GHCR.exec(object.origin)
    if (match !== null) {
      bump(registry, match[1]!)
      for (const pin of object.pins) {
        const stamp = STAMP.exec(pin.release)
        if (stamp !== null)
          releases.set(match[1]!, (releases.get(match[1]!) ?? new Set()).add(stamp[1]!))
      }
    }
    if (object.origin !== undefined)
      bump(origins, new URL(object.origin).host)
    for (const pin of object.pins)
      bump(rowKinds, pin.row.split(' ')[0]!)
  }
  return { registry, releases, rowKinds, origins }
}

// Does the mirror hold ghcr bytes of this package at this release? The whole
// question, asked directly: not "is there a row of some kind", not "does the
// mirror hold something for this repository", and not "some release of the
// same image".
export function ghcrCovered(coverage: Coverage, ghcrPackage: string, release: string): boolean {
  return coverage.releases.get(ghcrPackage)?.has(release) === true
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

// The repositories whose Debian packages live in OCI pools. mica-build-env is
// not one of them: it publishes images, and its blobs being mirrored says
// nothing about a pool.
const POOL_PUBLISHERS = ['mica-core', 'mica-system-base', 'mica-podman', 'mica-boards']

// Are the pools covered at all? Asked of the BYTES, so nothing but pool bytes
// can answer yes: a lock object's origin is a GitHub release asset, a `deb`
// object's is `snapshot.debian.org`, and neither is ghcr bytes of a pool
// publisher. The row kinds are reported for reading; they are not the
// predicate, because a row name is a description and the reason is a byte.
export function poolsCovered(coverage: Coverage): boolean {
  return POOL_PUBLISHERS.some(repository => (coverage.registry.get(`micaoss/${repository}`) ?? 0) > 0)
}

// The index is a SNAPSHOT, and a snapshot can be behind the bucket. Reading a
// coverage row off a stale index once said "0 lock objects" minutes after 18
// were published and verified, which is the one way this command can lie. So
// it compares itself against the service's own catalog and says so.
export function staleness(indexObjects: number, catalogObjects: number, version: string): string | undefined {
  if (indexObjects >= catalogObjects)
    return undefined
  return `STALE: the catalog holds ${catalogObjects} objects and index ${version} names ${indexObjects}`
    + ' -- every count below is the index\'s, not the bucket\'s'
}
