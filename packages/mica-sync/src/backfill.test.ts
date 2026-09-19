import { expect, test } from 'bun:test'
import { parseSnapshotFile, windowOf } from './backfill.ts'

test('a snapshot file names its repository and run from the file name', () => {
  expect(parseSnapshotFile('runs/mica-boards-35073583520.json')).toEqual({ repository: 'mica-boards', id: 35073583520, key: 'status/runs/mica-boards/35073583520.json' })
  expect(parseSnapshotFile('/tmp/x/status-1/runs/mica-build-123.json')).toEqual({ repository: 'mica-build', id: 123, key: 'status/runs/mica-build/123.json' })
})

test('anything that is not a run snapshot is skipped rather than guessed at', () => {
  expect(parseSnapshotFile('runs/current.json')).toBeUndefined()
  expect(parseSnapshotFile('health.json')).toBeUndefined()
  expect(parseSnapshotFile('runs/mica-res-notanumber.json')).toBeUndefined()
})

test('the recovered window is stated from the snapshots themselves, not from the run dates', () => {
  expect(windowOf([
    { startedAt: '2026-09-19T08:00:00Z' },
    { startedAt: '2026-09-18T16:20:00Z' },
    { startedAt: '2026-09-19T20:00:00Z' },
  ])).toEqual({ from: '2026-09-18T16:20:00Z', to: '2026-09-19T20:00:00Z' })
  expect(windowOf([])).toBeUndefined()
})
