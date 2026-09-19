// The reconciliation nobody has run: what the service's catalog holds against
// what the producers' locks name.
//
// The import reconstructs from the retired service's catalog; the locks are
// the pins a consumer verifies against. Where the two disagree the LOCKS WIN,
// so this compares by key AND by digest, and reports rather than merges. The
// column worth reading is `unpinned`: keys the catalog holds that no lock
// names today, which came from the old index and are pinned by nothing.

export interface PinnedObject {
  key: string
  sha256: string
}

export interface CatalogObject {
  key: string
  size: number
  sha256: string
}

export interface Reconciliation {
  agreed: PinnedObject[]
  missing: PinnedObject[]
  unpinned: CatalogObject[]
  conflicts: { key: string, lock: string, catalog: string }[]
}

/**
 * A git pack is not named by a lock row: its key is derived from a commit the
 * lock pins (`upstream/git/<name>/<commit>.json` and `.pack.NN`). Those keys
 * are pinned BY DERIVATION, and counting them as "named by no lock" would make
 * the interesting column mostly noise.
 */
export function derivedPrefixes(trees: { name: string, commit: string }[]): string[] {
  return trees.map(tree => `upstream/git/${tree.name}/${tree.commit}.`)
}

export function reconcile(pinned: PinnedObject[], held: CatalogObject[], derived: string[] = []): Reconciliation {
  const byKey = new Map(held.map(object => [object.key, object]))
  const pinnedKeys = new Set(pinned.map(object => object.key))

  const agreed: PinnedObject[] = []
  const missing: PinnedObject[] = []
  const conflicts: { key: string, lock: string, catalog: string }[] = []
  for (const object of pinned) {
    const there = byKey.get(object.key)
    if (there === undefined) {
      missing.push(object)
      continue
    }
    if (there.sha256 === object.sha256)
      agreed.push(object)
    else
      conflicts.push({ key: object.key, lock: object.sha256, catalog: there.sha256 })
  }

  return {
    agreed,
    missing,
    unpinned: held.filter(object => !pinnedKeys.has(object.key) && !derived.some(prefix => object.key.startsWith(prefix))),
    conflicts,
  }
}

export function summary(answer: Reconciliation, held: number): string {
  return [
    `  in the catalog and in the locks:  ${answer.agreed.length}`,
    `  in the locks and missing:         ${answer.missing.length}`,
    `  in the catalog, named by no lock: ${answer.unpinned.length}`,
    `  same key, different digest:       ${answer.conflicts.length}`,
    // The remainder is accounted for rather than unexplained: a pack's key
    // comes from a commit a lock pins, and the two uefi kernels are the same
    // commit, so they share one pack under two names.
    `  derived from a pinned commit:     ${held - answer.agreed.length - answer.unpinned.length - answer.conflicts.length} (git packs)`,
  ].join('\n')
}
