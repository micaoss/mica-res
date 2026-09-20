import { expect, test } from 'bun:test'
import { missingSnapshots, spanOf } from './history.ts'

const held = new Set(['status/runs/mica-build/1.json', 'status/runs/mica-build/2.json'])

test('a concluded run with no snapshot is a gap; one in flight is not', () => {
  const missing = missingSnapshots('mica-build', [
    { id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-09-19T10:00:00Z' },
    { id: 2, status: 'completed', conclusion: 'failure', run_started_at: '2026-09-19T11:00:00Z' },
    { id: 3, status: 'completed', conclusion: 'success', run_started_at: '2026-09-19T12:00:00Z' },
    { id: 4, status: 'in_progress', conclusion: null, run_started_at: '2026-09-19T13:00:00Z' },
  ], held)
  expect(missing).toEqual([{ repository: 'mica-build', id: 3, startedAt: '2026-09-19T12:00:00Z' }])
})

test('the span is read from the snapshots that exist, not from the window asked for', () => {
  expect(spanOf(['status/runs/a/1.json'], new Map([['status/runs/a/1.json', '2026-09-15T01:55:52Z']]))).toEqual({
    from: '2026-09-15T01:55:52Z',
    to: '2026-09-15T01:55:52Z',
    days: 0,
  })
  expect(spanOf([], new Map())).toBeUndefined()
})
