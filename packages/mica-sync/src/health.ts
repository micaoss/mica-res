// Is anything broken right now, and for how long?
//
// A red run is an event; a red default branch for two days is a state, and
// only the second is worth interrupting someone for. The shape that hid
// mica-build being red from 2026-09-17 10:27 until it was found by hand on
// 2026-09-19 is the third column here: a repository that failed and then went
// QUIET looks identical to a healthy one in any view that shows only the
// latest run per workflow.
//
// This reads the runs the collector already snapshots. It adds no live call.

export interface HealthRun {
  id: number
  workflow: string
  event: string
  branch: string | null
  status: string
  conclusion: string | null
  startedAt: string
  completedAt: string | null
}

export type HealthState = 'green' | 'red' | 'red-and-quiet' | 'unknown'

export interface Health {
  repository: string
  state: HealthState
  /** When the oldest consecutive failure started: the moment it went red. */
  redSince?: string
  redHours?: number
  /** Runs started after that moment, in flight included. */
  runsSince: number
  lastRunAt?: string
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
// A cancelled or skipped run carries no verdict: it is neither a failure nor
// evidence that the branch recovered. Taking it as a verdict would read a
// repository that has been failing since Thursday as green because somebody
// cancelled a run this evening -- which is exactly what happened to
// mica-build while this was being written.
const VERDICT = new Set([...FAILED, 'success'])

function onDefaultBranch(run: HealthRun): boolean {
  return run.branch === 'main' && run.event !== 'pull_request'
}

export function healthOf(repository: string, runs: HealthRun[], now: number): Health {
  const ordered = runs
    .filter(onDefaultBranch)
    .toSorted((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  if (ordered.length === 0)
    return { repository, state: 'unknown', runsSince: 0 }

  const lastRunAt = ordered[0]!.startedAt
  const concluded = ordered.filter(run => run.status === 'completed' && run.conclusion !== null && VERDICT.has(run.conclusion))
  const newest = concluded[0]
  if (newest === undefined || !FAILED.has(newest.conclusion!))
    return { repository, state: 'green', runsSince: 0, lastRunAt }

  // The moment it went red is the OLDEST failure of the current streak, not
  // the newest: a repository failing every night since Thursday has been red
  // since Thursday.
  let redSince = newest.startedAt
  for (const run of concluded.slice(1)) {
    if (!FAILED.has(run.conclusion!))
      break
    redSince = run.startedAt
  }

  const runsSince = ordered.filter(run => Date.parse(run.startedAt) > Date.parse(newest.startedAt)).length
  return {
    repository,
    state: runsSince === 0 ? 'red-and-quiet' : 'red',
    redSince,
    redHours: (now - Date.parse(redSince)) / 3_600_000,
    runsSince,
    lastRunAt,
  }
}

/**
 * Worth interrupting someone for: red for at least the threshold. A run that
 * failed ten minutes ago is an event someone is probably already fixing; the
 * quiet flag is not a second trigger, it is what the body says to look at
 * first.
 */
export function redRepositories(health: Health[], thresholdHours: number): Health[] {
  return health
    .filter(one => one.state.startsWith('red') && (one.redHours ?? 0) >= thresholdHours)
    .toSorted((a, b) => (b.redHours ?? 0) - (a.redHours ?? 0))
}

function age(hours: number): string {
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`
}

export function issueBody(red: Health[], now: number): string {
  return [
    'The default branch of these repositories is failing. Times are UTC and',
    'come from the run snapshots the mica-res collector takes every thirty',
    'minutes; nothing here is a live query.',
    '',
    '| repository | red since | for | since then |',
    '| --- | --- | --- | --- |',
    ...red.map(one => `| \`${one.repository}\` | ${one.redSince} | ${age(one.redHours ?? 0)} | ${one.runsSince === 0 ? '**nothing has run since**' : `${one.runsSince} run(s)`} |`),
    '',
    'A repository that failed and then went quiet is the case worth looking at',
    'first: it looks healthy in any view that shows only the latest run per',
    'workflow, which is how a two-day-red `main` went unnoticed this week.',
    '',
    `Updated ${new Date(now).toISOString()} by \`mica-res\` \`collect.yml\`. This issue closes itself when every default branch is green again.`,
  ].join('\n')
}
