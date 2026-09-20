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

/** For each release, the indexes that name it -- directly or through a scope. */
export function indexCoverage(nodes: ReleaseNode[]): Map<string, string[]> {
  const indexes = nodes.filter(node => /^mica\.[0-9]{8}-[0-9]{4}$/.test(node.tag))
  const covered = new Map<string, string[]>()
  for (const index of indexes) {
    for (const named of index.names)
      covered.set(named, [...(covered.get(named) ?? []), index.tag])
  }
  return covered
}
