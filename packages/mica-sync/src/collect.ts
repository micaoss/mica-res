// The collector: it snapshots Actions run and job metadata into the bucket
// before anything prunes it. Runs are public data, so this reads anonymously
// when it has to and with the workflow token when it has one.
//
// It applies NO stage mapping. A snapshot is the API's own words -- job names
// and step names verbatim -- so a correction to the map never requires
// collecting anything again.

import { fetchJson, githubHeaders } from './fetch.ts'

export const RUN_SCHEMA = 'mica/status-run/v1'
export const CURRENT_SCHEMA = 'mica/status-current/v1'

export interface ApiRun {
  id: number
  name: string | null
  path: string
  event: string
  status: string
  conclusion: string | null
  head_sha: string
  head_branch: string | null
  run_started_at: string
  updated_at: string
}

export interface ApiStep {
  number: number
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
}

export interface ApiJob {
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  steps?: ApiStep[]
}

export interface RunSnapshot {
  schema: string
  repository: string
  id: number
  workflow: string
  workflowName: string | null
  event: string
  status: string
  conclusion: string | null
  commit: string
  branch: string | null
  startedAt: string
  updatedAt: string
  jobs: {
    name: string
    status: string
    conclusion: string | null
    startedAt: string | null
    completedAt: string | null
    steps: { number: number, name: string, conclusion: string | null, startedAt: string | null, completedAt: string | null }[]
  }[]
}

export interface CurrentRun {
  id: number
  workflow: string
  event: string
  status: string
  conclusion: string | null
  head_sha: string
  startedAt: string
  completedAt: string | null
}

export interface CurrentDocument {
  generatedAt: string
  repositories: { repository: string, runs: CurrentRun[] }[]
}

export function concluded(run: Pick<ApiRun, 'status' | 'conclusion'>): boolean {
  return run.status === 'completed' && run.conclusion !== null
}

export function runSnapshot(repository: string, run: ApiRun, jobs: ApiJob[]): RunSnapshot {
  return {
    schema: RUN_SCHEMA,
    repository,
    id: run.id,
    workflow: run.path.replace('.github/workflows/', ''),
    workflowName: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    commit: run.head_sha,
    branch: run.head_branch,
    startedAt: run.run_started_at,
    updatedAt: run.updated_at,
    jobs: jobs.map(job => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      steps: (job.steps ?? []).map(step => ({
        number: step.number,
        name: step.name,
        conclusion: step.conclusion,
        startedAt: step.started_at,
        completedAt: step.completed_at,
      })),
    })),
  }
}

export function renderRun(snapshot: RunSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`
}

export function renderCurrent(document: CurrentDocument): string {
  return `${JSON.stringify({ schema: CURRENT_SCHEMA, ...document })}\n`
}

export function runKey(repository: string, id: number): string {
  return `status/runs/${repository}/${id}.json`
}

export async function listRuns(repository: string, perPage = 100): Promise<ApiRun[]> {
  const answer = await fetchJson<{ workflow_runs: ApiRun[] }>(
    `https://api.github.com/repos/micaoss/${repository}/actions/runs?per_page=${perPage}`,
    githubHeaders(),
  )
  return answer.workflow_runs
}

export async function listJobs(repository: string, id: number): Promise<ApiJob[]> {
  const answer = await fetchJson<{ jobs: ApiJob[] }>(
    `https://api.github.com/repos/micaoss/${repository}/actions/runs/${id}/jobs?per_page=100`,
    githubHeaders(),
  )
  return answer.jobs
}
