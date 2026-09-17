// Which build-env image releases are still NAMED by a published release.
//
// The rule is objective rather than a judgement: walk every published release,
// take the commit it was cut from, read that commit's `locks/mica-build-env.lock`,
// and collect the image references. A build-env release named by any of them is
// what makes that release reproducible, so it must be mirrored; one named by
// none and mirrored is what a retention policy may prune.
//
// A consumer's release lock carries no `image` rows of its own (only its
// products), which is why the commit hop is necessary; mica-build-env's own
// release lock does carry them.

import { fetchJson, fetchText, githubHeaders, rawUrl } from './fetch.ts'
import { parseLock } from './locks.ts'
import type { Lock } from './locks.ts'

export interface PinnedImageRelease {
  release: string
  lock: Lock
  pinnedBy: string[]
}

export function releaseCommit(lock: Lock): string | undefined {
  return lock.rows.find(row => row.kind === 'release')?.fields[3]
}

// The release is in the tag of an index row: `...:<image>.<release>@sha256:...`.
export function buildEnvRelease(lock: Lock): string | undefined {
  for (const row of lock.rows) {
    if (row.kind !== 'image' || row.fields[1] !== 'mica-build-env')
      continue
    const match = /:[a-z0-9-]+\.([0-9]{8}-[0-9]{4})@sha256:/.exec(row.fields[4]!)
    if (match)
      return match[1]
  }
  return undefined
}

interface Release {
  tag_name: string
  assets: { name: string, browser_download_url: string }[]
}

async function lockOfRelease(repository: string, release: Release): Promise<Lock | undefined> {
  const asset = release.assets.find(item => item.name === `${repository}.lock`)
  if (asset === undefined)
    return undefined
  return parseLock(await fetchText(asset.browser_download_url, githubHeaders()))
}

export async function pinnedImageReleases(repositories: string[]): Promise<PinnedImageRelease[]> {
  const found = new Map<string, PinnedImageRelease>()
  for (const repository of repositories) {
    const releases = await fetchJson<Release[]>(`https://api.github.com/repos/micaoss/${repository}/releases?per_page=100`, githubHeaders())
    for (const release of releases) {
      const lock = await lockOfRelease(repository, release)
      if (lock === undefined)
        continue

      // mica-build-env's own lock carries the image rows; a consumer's does
      // not, so its commit's in-tree build-env lock is the source.
      let source = buildEnvRelease(lock) === undefined ? undefined : lock
      if (source === undefined) {
        const commit = releaseCommit(lock)
        if (commit === undefined)
          continue
        try {
          source = parseLock(await fetchText(rawUrl(repository, 'locks/mica-build-env.lock', commit)))
        }
        catch {
          continue
        }
      }

      const named = buildEnvRelease(source)
      if (named === undefined)
        continue
      const held = found.get(named)
      const pin = `${repository} ${release.tag_name}`
      if (held === undefined)
        found.set(named, { release: named, lock: source, pinnedBy: [pin] })
      else if (!held.pinnedBy.includes(pin))
        held.pinnedBy.push(pin)
    }
  }
  return [...found.values()].sort((a, b) => a.release.localeCompare(b.release))
}
