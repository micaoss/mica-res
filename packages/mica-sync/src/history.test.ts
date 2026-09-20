import { expect, test } from 'bun:test'
import { classifyGaps, missingSnapshots, pageWindow, spanOf } from './history.ts'

const held = new Set(['status/runs/mica-build/1.json', 'status/runs/mica-build/2.json'])

test('a concluded run with no snapshot is a gap; one in flight is not', () => {
  const missing = missingSnapshots('mica-build', [
    { id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-09-19T10:00:00Z', updated_at: '2026-09-19T10:00:00Z' },
    { id: 2, status: 'completed', conclusion: 'failure', run_started_at: '2026-09-19T11:00:00Z', updated_at: '2026-09-19T11:00:00Z' },
    { id: 3, status: 'completed', conclusion: 'success', run_started_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-19T12:00:00Z' },
    { id: 4, status: 'in_progress', conclusion: null, run_started_at: '2026-09-19T13:00:00Z', updated_at: '2026-09-19T13:00:00Z' },
  ], held)
  expect(missing).toEqual([{ repository: 'mica-build', id: 3, startedAt: '2026-09-19T12:00:00Z', concludedAt: '2026-09-19T12:00:00Z' }])
})

test('the span is read from the snapshots that exist, not from the window asked for', () => {
  expect(spanOf(['status/runs/a/1.json'], new Map([['status/runs/a/1.json', '2026-09-15T01:55:52Z']]))).toEqual({
    from: '2026-09-15T01:55:52Z',
    to: '2026-09-15T01:55:52Z',
    days: 0,
  })
  expect(spanOf([], new Map())).toBeUndefined()
})

test('a run newer than the last collector pass is lag, an older one is a hole', () => {
  const gaps = [
    { repository: 'mica', id: 1, startedAt: '2026-09-20T06:00:00Z', concludedAt: '2026-09-20T06:10:00Z' },
    { repository: 'mica', id: 2, startedAt: '2026-09-19T06:00:00Z', concludedAt: '2026-09-19T06:10:00Z' },
  ]
  const answer = classifyGaps(gaps, '2026-09-20T01:00:00Z')
  expect(answer.lag.map(gap => gap.id)).toEqual([1])
  expect(answer.holes.map(gap => gap.id)).toEqual([2])
})

test('with nothing collected yet every gap is a hole', () => {
  const gaps = [{ repository: 'mica', id: 1, startedAt: '2026-09-20T06:00:00Z', concludedAt: '2026-09-20T06:10:00Z' }]
  expect(classifyGaps(gaps, undefined).holes).toHaveLength(1)
})

test('the margin is the distance from the page floor to the oldest uncollected run', () => {
  const runs = [
    { id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T00:00:00Z' },
    { id: 2, status: 'completed', conclusion: 'success', run_started_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' },
  ]
  const gaps = [{ repository: 'mica', id: 2, startedAt: '2026-09-20T00:00:00Z', concludedAt: '2026-09-20T00:00:00Z' }]
  const window = pageWindow('mica', runs, gaps, 2)
  expect(window.saturated).toBe(true)
  expect(window.marginHours).toBe(72)
})

test('a page that is not full reaches the whole history', () => {
  const runs = [{ id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' }]
  expect(pageWindow('mica', runs, [], 100).saturated).toBe(false)
})

test('a run that began before a pass and finished after it is lag, not a hole', () => {
  const gaps = [{ repository: 'mica-boards', id: 1, startedAt: '2026-09-20T06:41:39Z', concludedAt: '2026-09-20T06:58:00Z' }]
  const answer = classifyGaps(gaps, '2026-09-20T06:51:25Z')
  expect(answer.holes).toHaveLength(0)
  expect(answer.lag).toHaveLength(1)
})
