// Which releases are prunable, as a query rather than an argument.
//
// The rule, already recorded: a release is prunable only if NO PUBLISHED LOCK
// NAMES IT and IT IS MIRRORED. Both halves are computable -- the first from the
// locks the releases themselves carry, the second from the mirror's listings --
// so this produces three lists and no opinion.
//
// The constraint that sits above the rule (mica:docs/design/release-lock.md
// 2.1): a release an index references is not deleted, because a full rebuild
// reconstructs an index from the releases it names. So the count that matters
// is not "is it named" but "how many indexes would lose full verifiability".

import type { Lock } from './locks.ts'

export interface ReleaseNode {
  /** `<repository>[.<scope>]/<release>`, the identity a lock row names. */
  id: string
  repository: string
  tag: string
  names: string[]
}

export interface PrunableReport {
  named: { id: string, by: string[] }[]
  prunableMirrored: ReleaseNode[]
  prunableUnmirrored: ReleaseNode[]
}

/**
 * THE ONE NORMALISED FORM, and every identity on both sides of the join is
 * built through this function.
 *
 * A lock row spells a scoped input as `mica-build.cx3576` with the stamp in a
 * separate field; a release tag spells the same thing as `cx3576.20260915-2230`
 * or, before 2026-09-16, `cx3576/20260915-2230`. Keying the release by its tag
 * verbatim produced `mica-build/cx3576/20260915-2230` against the row's
 * `mica-build.cx3576/20260915-2230`, and THE JOIN SILENTLY FOUND NOTHING --
 * two releases a published index names were reported as named by nobody.
 *
 * The chosen form is the row's: `<repository>.<scope>/<stamp>`, with
 * `<repository>/<stamp>` when a release has no scope. A tag is split on either
 * separator, so both tag forms normalise to it.
 */
export function releaseId(repository: string, tag: string): string {
  const match = /^(?:(.+)[./])?([0-9]{8}-[0-9]{4})$/.exec(tag)
  if (match === null)
    throw new Error(`field-value: ${repository} ${tag} is not a release tag`)
  const scope = match[1]
  return scope === undefined ? `${repository}/${match[2]}` : `${repository}.${scope}/${match[2]}`
}

/** Every release identity a lock names: its inputs, its builts, its images. */
export function namesOf(lock: Lock): string[] {
  const names = new Set<string>()
  for (const row of lock.rows) {
    if (row.kind === 'input') {
      names.add(`${row.fields[1]}/${row.fields[2]}`)
      continue
    }
    if (row.kind === 'built') {
      names.add(`${row.fields[2]}/${row.fields[3]}`)
      continue
    }
    if (row.kind !== 'image' || row.fields[1] === 'upstream')
      continue
    // A repository image reference carries its release in the tag of the index
    // row: `...:<image>.<release>@sha256:...`.
    const match = /:[a-z0-9-]+\.([0-9]{8}-[0-9]{4})@sha256:/.exec(row.fields[4] ?? '')
    if (match)
      names.add(`${row.fields[1]}/${match[1]}`)
  }
  return [...names]
}

export function prunableReport(nodes: ReleaseNode[], mirrored: Set<string>): PrunableReport {
  const by = new Map<string, string[]>()
  for (const node of nodes) {
    for (const named of node.names) {
      // A lock naming its own release is not evidence that anything else needs
      // it; self-reference would protect every release from itself.
      if (named === node.id)
        continue
      by.set(named, [...(by.get(named) ?? []), node.tag])
    }
  }

  const named: { id: string, by: string[] }[] = []
  const prunableMirrored: ReleaseNode[] = []
  const prunableUnmirrored: ReleaseNode[] = []
  for (const node of nodes.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const naming = by.get(node.id)
    if (naming !== undefined && naming.length > 0)
      named.push({ id: node.id, by: naming })
    else if (mirrored.has(node.id))
      prunableMirrored.push(node)
    else
      prunableUnmirrored.push(node)
  }
  return { named, prunableMirrored, prunableUnmirrored }
}

/**
 * For each release, the indexes that name it.
 *
 * An index is recognised by its NORMALISED identity, `<repository>.mica/<stamp>`,
 * not by a tag pattern: matching `mica\.<stamp>` on the tag would miss the
 * slash-form `mica/20260915-2242` -- the same silent miss as the join itself,
 * one function further along.
 */
export function indexCoverage(nodes: ReleaseNode[]): Map<string, string[]> {
  const indexes = nodes.filter(node => node.id.startsWith('mica-build.mica/'))
  const covered = new Map<string, string[]>()
  for (const index of indexes) {
    for (const named of index.names)
      covered.set(named, [...(covered.get(named) ?? []), index.tag])
  }
  return covered
}
