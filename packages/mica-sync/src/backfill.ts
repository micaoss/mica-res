// Recovering the run history the collector rendered but could not publish.
//
// Between the cutover (2026-09-18 16:10) and the arrival of a publish token,
// every `collect` run wrote its snapshots to a workflow artifact and nothing
// else. Those artifacts are the ONLY copy and they expire after 90 days, so
// this republishes them from a downloaded artifact tree. It is the one part of
// this incident where something could be lost rather than merely absent.

export interface SnapshotFile {
  repository: string
  id: number
  key: string
}

/** `runs/<repository>-<id>.json` anywhere in the tree, or undefined. */
export function parseSnapshotFile(path: string): SnapshotFile | undefined {
  const match = /(?:^|\/)runs\/([a-z][a-z0-9-]*)-([0-9]+)\.json$/.exec(path)
  if (match === null)
    return undefined
  return { repository: match[1]!, id: Number(match[2]), key: `status/runs/${match[1]}/${match[2]}.json` }
}

/** The window the recovered snapshots actually cover. */
export function windowOf(snapshots: { startedAt: string }[]): { from: string, to: string } | undefined {
  if (snapshots.length === 0)
    return undefined
  const sorted = snapshots.map(one => one.startedAt).toSorted()
  return { from: sorted[0]!, to: sorted.at(-1)! }
}
