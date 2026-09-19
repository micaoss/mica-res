import { expect, test } from 'bun:test'
import { firstFailingJob, healthOf, issueBody, redRepositories } from './health.ts'

const run = (over: Partial<Parameters<typeof healthOf>[1][number]>) => ({
  id: 1,
  workflow: 'ci.yml',
  event: 'push',
  branch: 'main',
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-09-19T10:00:00Z',
  completedAt: '2026-09-19T10:05:00Z',
  ...over,
})

const now = Date.parse('2026-09-19T20:00:00Z')

test('a repository whose newest default-branch run passed is green', () => {
  const health = healthOf('mica-boards', [run({ id: 2, startedAt: '2026-09-19T19:00:00Z' })], now)
  expect(health.state).toBe('green')
})

test('red reports WHEN it went red, not just that it is red', () => {
  const health = healthOf('mica-build', [
    run({ id: 3, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z', completedAt: '2026-09-17T10:40:00Z' }),
    run({ id: 2, conclusion: 'success', startedAt: '2026-09-17T09:00:00Z' }),
  ], now)
  // Nothing ran after the failure, so this is the quiet case -- which is the
  // one that hid mica-build being red for two days.
  expect(health.state).toBe('red-and-quiet')
  expect(health.redSince).toBe('2026-09-17T10:27:00Z')
  expect(Math.round(health.redHours!)).toBe(58)
})

test('the oldest consecutive failure is the moment it went red, not the newest', () => {
  const health = healthOf('mica-build', [
    run({ id: 5, conclusion: 'failure', startedAt: '2026-09-19T08:00:00Z' }),
    run({ id: 4, conclusion: 'failure', startedAt: '2026-09-18T08:00:00Z' }),
    run({ id: 3, conclusion: 'success', startedAt: '2026-09-17T08:00:00Z' }),
  ], now)
  expect(health.redSince).toBe('2026-09-18T08:00:00Z')
})

test('red and nothing since is its own state, because it looks healthy in a latest-run view', () => {
  const health = healthOf('mica-build', [
    run({ id: 3, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' }),
  ], now)
  expect(health.state).toBe('red-and-quiet')
  expect(health.runsSince).toBe(0)
})

test('a run in flight after the failure counts as something having run', () => {
  const health = healthOf('mica-build', [
    run({ id: 4, status: 'in_progress', conclusion: null, startedAt: '2026-09-19T19:50:00Z' }),
    run({ id: 3, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' }),
  ], now)
  expect(health.state).toBe('red')
  expect(health.runsSince).toBe(1)
})

test('only the default branch decides, so a failing pull request is not a red main', () => {
  const health = healthOf('mica-core', [
    run({ id: 4, conclusion: 'failure', branch: 'topic', event: 'pull_request', startedAt: '2026-09-19T19:00:00Z' }),
    run({ id: 3, conclusion: 'success', startedAt: '2026-09-19T18:00:00Z' }),
  ], now)
  expect(health.state).toBe('green')
})

test('a cancelled run carries no verdict, so it neither fails nor clears a branch', () => {
  // Only cancelled runs: nothing has ever said pass or fail.
  expect(healthOf('mica-res', [run({ id: 4, conclusion: 'cancelled', startedAt: '2026-09-19T19:00:00Z' })], now).state).toBe('green')
  // A cancellation after a failure must not read as recovery.
  const health = healthOf('mica-build', [
    run({ id: 6, conclusion: 'cancelled', startedAt: '2026-09-19T19:50:00Z' }),
    run({ id: 5, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' }),
    run({ id: 4, conclusion: 'success', startedAt: '2026-09-16T17:38:00Z' }),
  ], now)
  expect(health.state).toBe('red')
  expect(health.redSince).toBe('2026-09-17T10:27:00Z')
  expect(health.runsSince).toBe(1)
})

test('only a repository red past the threshold is worth interrupting someone for', () => {
  const fresh = healthOf('a', [run({ id: 2, conclusion: 'failure', startedAt: '2026-09-19T19:30:00Z' })], now)
  const old = healthOf('b', [run({ id: 2, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' })], now)
  // Both are quiet; only the old one is announced, so a failure minutes old is
  // not an interruption.
  expect(fresh.state).toBe('red-and-quiet')
  expect(redRepositories([fresh, old], 6).map(h => h.repository)).toEqual(['b'])
})

test('the issue body names the state, the age and what has run since', () => {
  const body = issueBody([healthOf('mica-build', [run({ id: 3, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' })], now)], now)
  expect(body).toContain('mica-build')
  expect(body).toContain('2026-09-17T10:27:00Z')
  expect(body).toContain('nothing has run since')
})

test('the run that started the streak is named, so its jobs can be read', () => {
  const health = healthOf('mica-build', [
    run({ id: 6, conclusion: 'failure', startedAt: '2026-09-19T08:00:00Z' }),
    run({ id: 5, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' }),
    run({ id: 4, conclusion: 'success', startedAt: '2026-09-16T17:38:00Z' }),
  ], now)
  expect(health.redRunId).toBe(5)
})

test('the first failing job is the first in the run order, not the first alphabetically', () => {
  expect(firstFailingJob([
    { name: 'lint', conclusion: 'success' },
    { name: 'suites', conclusion: 'failure' },
    { name: 'boards', conclusion: 'failure' },
  ])).toBe('suites')
  expect(firstFailingJob([{ name: 'lint', conclusion: 'success' }])).toBeUndefined()
  expect(firstFailingJob([{ name: 'a', conclusion: 'cancelled' }, { name: 'b', conclusion: 'timed_out' }])).toBe('b')
})

test('the issue body carries the diagnosis when it has one and says so when it does not', () => {
  const red = healthOf('mica-build', [run({ id: 3, conclusion: 'failure', startedAt: '2026-09-17T10:27:00Z' })], now)
  expect(issueBody([{ ...red, firstFailingJob: 'lint' }], now)).toContain('`lint`')
  expect(issueBody([red], now)).toContain('unknown')
})
