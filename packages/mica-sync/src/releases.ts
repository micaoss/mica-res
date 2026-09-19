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

// A scoped release tag is `<scope>.<YYYYMMDD-HHMM>`, the form mica-build
// publishes and its own lock's release row carries (`uefi-x64.20260916-0845`);
// the `<scope>/<stamp>` form in the spec text is not what exists. The index
// scope `mica` is skipped: a `mica.<stamp>` release carries only its lock and
// `mica-index.json`, and copies the indexed products' `asset` rows without
// publishing those bytes again (mica:docs/design/mica-index.md 1).
export function keptReleases(tags: string[], keptPerScope = KEPT_PER_SCOPE): string[] {
  const byScope = new Map<string, string[]>()
  for (const tag of tags) {
    const match = /^([a-z0-9][a-z0-9-]*)\.([0-9]{8}-[0-9]{4})$/.exec(tag)
    if (match === null || match[1] === 'mica')
      continue
    byScope.set(match[1]!, [...(byScope.get(match[1]!) ?? []), tag])
  }
  return [...byScope.values()].flatMap(tags => tags.sort().reverse().slice(0, keptPerScope)).sort()
}

export function assetObjects(tag: string, rows: AssetRow[], sizes: Map<string, number>, repository: string): ResourceObject[] {
  const [scope, stamp] = tag.split('.')
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
      readable: [`mica/${scope}/${stamp}/${row.file}`],
      pins: [{ repository, lock: `${tag}:${repository}.lock`, release: tag, row: `asset ${row.product} ${row.type} ${row.kind}` }],
    }
  })
}

export async function enumerateReleases(repository: string): Promise<ResourceObject[]> {
  const releases = await fetchJson<Release[]>(`https://api.github.com/repos/micaoss/${repository}/releases?per_page=100`, githubHeaders())
  const kept = new Set(keptReleases(releases.map(release => release.tag_name)))
  // Matching none of a repository's releases is a refusal, not an empty
  // result: ignoring a tag looks exactly like there being no tag, which is how
  // this reader once kept mirroring superseded releases while reporting
  // success. If the tag form moves again, the sync fails loudly instead.
  if (releases.length > 0 && kept.size === 0)
    throw new Error(`no-release-matched: ${repository} publishes ${releases.length} releases and none is a scoped <scope>.<YYYYMMDD-HHMM> tag (newest: ${releases.slice(0, 3).map(release => release.tag_name).join(', ')})`)
  const objects: ResourceObject[] = []
  for (const release of releases.filter(release => kept.has(release.tag_name))) {
    const lock = release.assets.find(asset => asset.name === `${repository}.lock`)
    // A release whose publish job is still attaching assets is not a defect
    // and not mirrorable yet: it is skipped loudly and picked up by the next
    // run. Matching no release at all stays a refusal -- that is the invisible
    // case; this one announces itself.
    if (lock === undefined) {
      console.log(`  skipped ${release.tag_name}: no ${repository}.lock attached yet`)
      continue
    }
    const rows = assetRows(parseLock(await fetchText(lock.browser_download_url, githubHeaders())))
    const sizes = new Map(release.assets.map(asset => [asset.name, asset.size]))
    objects.push(...assetObjects(release.tag_name, rows, sizes, repository))
  }
  return objects
}
