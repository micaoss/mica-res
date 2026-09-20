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
  // Approximately when the run reached its verdict. The collector writes a
  // snapshot only once a run is final, so this -- not the start -- decides
  // whether a pass could have seen it.
  updated_at: string
}

export interface Gap {
  repository: string
  id: number
  startedAt: string
  concludedAt: string
}

export function missingSnapshots(repository: string, runs: ApiRunLite[], held: Set<string>): Gap[] {
  return runs
    .filter(run => run.status === 'completed' && run.conclusion !== null)
    .filter(run => !held.has(`status/runs/${repository}/${run.id}.json`))
    .map(run => ({ repository, id: run.id, startedAt: run.run_started_at, concludedAt: run.updated_at }))
}

export function spanOf(keys: string[], startedAt: Map<string, string>): { from: string, to: string, days: number } | undefined {
  const stamps = keys.flatMap(key => (startedAt.has(key) ? [startedAt.get(key)!] : [])).toSorted()
  if (stamps.length === 0)
    return undefined
  const from = stamps[0]!
  const to = stamps.at(-1)!
  return { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) }
}

// A concluded run without a snapshot is not automatically lost history: the
// collector runs on a schedule and snapshots a run only once it is final, so
// everything that REACHED ITS VERDICT after the last pass is still waiting to
// be collected. Only a run that concluded BEFORE the last pass is a hole -- a
// pass that ran and missed it, or never ran at all.
//
// The start time is the wrong frontier and said so within the hour: three
// mica-boards runs that began before a pass and finished after it were
// reported as holes while they were ordinary lag. A long build crosses a pass
// boundary as a matter of course.
export function classifyGaps(gaps: Gap[], lastPass: string | undefined): { lag: Gap[], holes: Gap[] } {
  if (lastPass === undefined)
    return { lag: [], holes: gaps }
  const edge = Date.parse(lastPass)
  return {
    lag: gaps.filter(gap => Date.parse(gap.concludedAt) > edge),
    holes: gaps.filter(gap => Date.parse(gap.concludedAt) <= edge),
  }
}

// The window that actually bounds recovery is NOT GitHub's run retention: the
// collector reads ONE page of 100 runs per repository (`listRuns`, no
// pagination) and `backfill` reads the collector's own artifacts, not the API.
// So a run that has fallen past position 100 before any pass saw it is
// unreachable by both paths. The early warning is therefore the distance
// between the oldest run page one still reaches and the oldest run nothing has
// collected: while the floor is older than the gap, every gap is still
// recoverable. A page that is not full reaches the whole history and cannot
// lose anything.
export interface Window {
  repository: string
  saturated: boolean
  floor: string | undefined
  oldestGap: string | undefined
  marginHours: number | undefined
}

export function pageWindow(repository: string, runs: ApiRunLite[], gaps: Gap[], perPage = 100): Window {
  const stamps = runs.map(run => run.run_started_at).toSorted()
  const floor = stamps[0]
  const oldestGap = gaps.map(gap => gap.startedAt).toSorted()[0]
  const saturated = runs.length >= perPage
  const marginHours = floor === undefined || oldestGap === undefined
    ? undefined
    : (Date.parse(oldestGap) - Date.parse(floor)) / 3_600_000
  return { repository, saturated, floor, oldestGap, marginHours }
}
