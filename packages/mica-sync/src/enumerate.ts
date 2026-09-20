// The set of objects the bucket should hold, derived from the producers' locks
// and releases exactly as a consumer reads them.

import { fetchAllowing404, fetchText, githubHeaders, rawUrl } from './fetch.ts'
import { enumerateImages } from './ghcr.ts'
import { gitRows, parseLock, sourceRows, upstreamRows } from './locks.ts'
import type { Lock } from './locks.ts'
import { mergeObjects, objectFromSourceRow } from './objects.ts'
import type { ResourceObject } from './objects.ts'
import { pinnedImageReleases } from './imagepins.ts'
import { lockObjects, parsePin, tagOf } from './pins.ts'
import { GIT_SOURCES, IMAGE_SOURCE, LOCK_SOURCES, PIN_HOLDERS, PRODUCT_SOURCE, REPOSITORIES } from './producers.ts'
import { enumerateReleases } from './releases.ts'

export interface GitTree {
  repository: string
  name: string
  url: string
  commit: string
}

export interface Enumeration {
  objects: ResourceObject[]
  gitTrees: GitTree[]
}

async function readLock(repository: string, path: string): Promise<Lock> {
  return parseLock(await fetchText(rawUrl(repository, path)))
}

function releaseOf(lock: Lock): string {
  const row = lock.rows.find(row => row.kind === 'release')
  if (row === undefined)
    throw new Error('release-row: the lock has no release row')
  return row.fields[2]!
}

// The locks and `SHA256SUMS` of every release a consumer's pin names. The pin
// states the digest of `SHA256SUMS`, that file states the digest of the lock,
// and both objects are keyed by those digests -- so a byte that disagrees with
// the pin is refused at enumeration and again at publish.
export async function enumerateLocks(): Promise<ResourceObject[]> {
  const objects: ResourceObject[] = []
  const sums = new Map<string, string>()
  for (const holder of PIN_HOLDERS) {
    // A repository that keeps no pins is not a defect: mica-build-env pins
    // nothing, it only publishes.
    const listing = await fetchAllowing404(`https://api.github.com/repos/micaoss/${holder}/contents/locks/pins`, githubHeaders())
    if (listing === undefined)
      continue
    for (const entry of JSON.parse(listing) as { name: string, path: string }[]) {
      if (!entry.name.endsWith('.pin'))
        continue
      const pin = parsePin(await fetchText(rawUrl(holder, entry.path)))
      const tag = tagOf(pin)
      const key = `${pin.repository}/${tag}`
      if (!sums.has(key)) {
        // A pin can name a release whose assets are still being attached, or
        // one cut and not yet published. Skipped loudly, picked up next run --
        // the same rule the product assets follow.
        const answer = await fetchAllowing404(`https://github.com/micaoss/${pin.repository}/releases/download/${tag}/SHA256SUMS`, githubHeaders())
        if (answer === undefined) {
          console.log(`  skipped ${key}: the release has no SHA256SUMS attached yet`)
          continue
        }
        sums.set(key, answer)
      }
      objects.push(...lockObjects({ repository: holder, pin: entry.path }, pin, sums.get(key)!))
    }
  }
  return objects
}

export async function enumerate(): Promise<Enumeration> {
  const objects: ResourceObject[] = []

  for (const source of LOCK_SOURCES) {
    const lock = await readLock(source.repository, source.lock)
    const pin = { repository: source.repository, lock: source.lock, release: 'main' }
    for (const row of [...sourceRows(lock), ...upstreamRows(lock)]) {
      if (source.exclude?.test(row.name))
        continue
      objects.push(objectFromSourceRow(row, pin))
    }
  }

  // The build-env images every current build pins...
  const imageLock = await readLock(IMAGE_SOURCE.repository, IMAGE_SOURCE.lock)
  const current = releaseOf(imageLock)
  objects.push(...await enumerateImages(imageLock, {
    repository: IMAGE_SOURCE.images,
    lock: `${IMAGE_SOURCE.repository}:${IMAGE_SOURCE.lock}`,
    release: current,
  }, IMAGE_SOURCE.images))

  // ...and every build-env release a PUBLISHED release still names, because
  // those locks are immutable and ghcr is the only other copy. This is the set
  // a retention policy may not prune.
  for (const pinned of await pinnedImageReleases(REPOSITORIES)) {
    if (pinned.release === current)
      continue
    objects.push(...await enumerateImages(pinned.lock, {
      repository: IMAGE_SOURCE.images,
      lock: `published:${pinned.pinnedBy.join(', ')}`,
      release: pinned.release,
    }, IMAGE_SOURCE.images))
  }

  objects.push(...await enumerateReleases(PRODUCT_SOURCE.repository))

  objects.push(...await enumerateLocks())

  const gitTrees: GitTree[] = []
  for (const source of GIT_SOURCES) {
    const lock = await readLock(source.repository, source.lock)
    for (const row of gitRows(lock))
      gitTrees.push({ repository: source.repository, name: row.name, url: row.url, commit: row.commit })
  }

  return { objects: mergeObjects(objects), gitTrees }
}
