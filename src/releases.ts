// mica-build's published product images and update archives. The GitHub Release
// stays the release: its own lock pins every asset by sha256 (`asset` rows,
// mica:docs/design/release-lock.md 1.2.2) and the release metadata states each
// size. Retention is three scoped releases per scope (user, 2026-09-16).

import { fetchJson, fetchText, githubHeaders } from './fetch.ts'
import { assetRows, parseLock } from './locks.ts'
import type { AssetRow } from './locks.ts'
import { blobPath } from './objects.ts'
import type { ResourceObject } from './objects.ts'

export const KEPT_PER_SCOPE = 3

interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

interface Release {
  tag_name: string
  assets: ReleaseAsset[]
}

// Scoped release tags are `<scope>/<YYYYMMDD-HHMM>`. The index release scope
// `mica` is skipped: a `mica/<stamp>` release carries only its lock and
// `mica-index.json`, and copies the indexed products' `asset` rows without
// publishing those bytes again (mica:docs/design/mica-index.md 1).
export function keptReleases(tags: string[], keptPerScope = KEPT_PER_SCOPE): string[] {
  const byScope = new Map<string, string[]>()
  for (const tag of tags) {
    const [scope, stamp] = tag.split('/')
    if (scope === undefined || scope === 'mica' || stamp === undefined || !/^[0-9]{8}-[0-9]{4}$/.test(stamp))
      continue
    byScope.set(scope, [...(byScope.get(scope) ?? []), tag])
  }
  return [...byScope.values()].flatMap(tags => tags.sort().reverse().slice(0, keptPerScope)).sort()
}

export function assetObjects(tag: string, rows: AssetRow[], sizes: Map<string, number>, repository: string): ResourceObject[] {
  const [scope, stamp] = tag.split('/')
  return rows.map((row) => {
    const size = sizes.get(row.file)
    if (size === undefined)
      throw new Error(`asset-not-published: ${row.file} of ${tag}`)
    return {
      kind: row.type === 'image' ? 'product-image' as const : 'update-archive' as const,
      sha256: row.sha256,
      size,
      origin: `https://github.com/micaoss/${repository}/releases/download/${tag}/${row.file}`,
      path: blobPath(row.sha256),
      readable: [`/d/mica/${scope}/${stamp}/${row.file}`],
      pins: [{ repository, lock: `${tag}:${repository}.lock`, release: tag, row: `asset ${row.product} ${row.type} ${row.kind}` }],
    }
  })
}

export async function enumerateReleases(repository: string): Promise<ResourceObject[]> {
  const releases = await fetchJson<Release[]>(`https://api.github.com/repos/micaoss/${repository}/releases?per_page=100`, githubHeaders())
  const kept = new Set(keptReleases(releases.map(release => release.tag_name)))
  const objects: ResourceObject[] = []
  for (const release of releases.filter(release => kept.has(release.tag_name))) {
    const lock = release.assets.find(asset => asset.name === `${repository}.lock`)
    if (lock === undefined)
      throw new Error(`release-without-lock: ${release.tag_name}`)
    const rows = assetRows(parseLock(await fetchText(lock.browser_download_url, githubHeaders())))
    const sizes = new Map(release.assets.map(asset => [asset.name, asset.size]))
    objects.push(...assetObjects(release.tag_name, rows, sizes, repository))
  }
  return objects
}
