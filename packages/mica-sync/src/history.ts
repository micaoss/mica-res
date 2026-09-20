// Is the run history in the bucket, and is it unbroken?
//
// A count answers neither question. The series is unbroken when EVERY
// concluded run GitHub still lists has a snapshot under its own key -- a gap
// matters more than a total, because the point of the history is to be able to
// say what something looked like before it changed.

export interface ApiRunLite {
  id: number
  status: string
  conclusion: string | null
  run_started_at: string
}

export interface Gap {
  repository: string
  id: number
  startedAt: string
}

export function missingSnapshots(repository: string, runs: ApiRunLite[], held: Set<string>): Gap[] {
  return runs
    .filter(run => run.status === 'completed' && run.conclusion !== null)
    .filter(run => !held.has(`status/runs/${repository}/${run.id}.json`))
    .map(run => ({ repository, id: run.id, startedAt: run.run_started_at }))
}

export function spanOf(keys: string[], startedAt: Map<string, string>): { from: string, to: string, days: number } | undefined {
  const stamps = keys.flatMap(key => (startedAt.has(key) ? [startedAt.get(key)!] : [])).toSorted()
  if (stamps.length === 0)
    return undefined
  const from = stamps[0]!
  const to = stamps.at(-1)!
  return { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) }
}
