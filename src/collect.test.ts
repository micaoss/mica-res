import { expect, test } from 'bun:test'
import { concluded, renderCurrent, renderRun, runSnapshot } from './collect.ts'

const run = {
  id: 35071472865,
  name: 'ci',
  path: '.github/workflows/ci.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  run_started_at: '2026-09-16T07:44:25Z',
  updated_at: '2026-09-16T07:45:29Z',
}

const jobs = [{
  name: 'build / kernel (uefi-x64, ubuntu-24.04)',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-09-16T07:44:44Z',
  completed_at: '2026-09-16T07:45:09Z',
  steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-09-16T07:44:44Z', completed_at: '2026-09-16T07:44:45Z' }],
}]

test('a snapshot keeps the run and its jobs verbatim, with the workflow file', () => {
  const snapshot = runSnapshot('mica-boards', run, jobs)
  expect(snapshot.schema).toBe('mica/status-run/v1')
  expect(snapshot.repository).toBe('mica-boards')
  expect(snapshot.workflow).toBe('ci.yml')
  expect(snapshot.jobs[0]?.name).toBe('build / kernel (uefi-x64, ubuntu-24.04)')
  expect(snapshot.jobs[0]?.steps[0]?.name).toBe('Set up job')
})

test('the snapshot is canonical JSON with a final LF', () => {
  const text = renderRun(runSnapshot('mica-boards', run, jobs))
  expect(text.endsWith('}\n')).toBe(true)
  expect(text.startsWith('{"schema":"mica/status-run/v1","repository":"mica-boards"')).toBe(true)
})

test('no stage mapping is applied at collection time', () => {
  const text = renderRun(runSnapshot('mica-boards', run, jobs))
  expect(text).not.toContain('kernel"')
  expect(text).toContain('build / kernel (uefi-x64, ubuntu-24.04)')
})

test('only a completed run is snapshotted immutably', () => {
  expect(concluded(run)).toBe(true)
  expect(concluded({ ...run, status: 'in_progress', conclusion: null })).toBe(false)
})

test('the current document lists every run it saw, in flight included', () => {
  const text = renderCurrent({
    generatedAt: '2026-09-16T08:20:00Z',
    repositories: [{
      repository: 'mica-boards',
      runs: [
        { id: 2, workflow: 'ci.yml', event: 'push', status: 'in_progress', conclusion: null, head_sha: 'b'.repeat(40), startedAt: '2026-09-16T08:19:00Z', completedAt: null },
        { id: 1, workflow: 'ci.yml', event: 'push', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), startedAt: '2026-09-16T07:44:25Z', completedAt: '2026-09-16T07:45:29Z' },
      ],
    }],
  })
  expect(text.startsWith('{"schema":"mica/status-current/v1"')).toBe(true)
  expect(text.endsWith('}\n')).toBe(true)
  expect(JSON.parse(text).repositories[0].runs).toHaveLength(2)
})
