import { expect, test } from 'bun:test'
import { decide, MARKER } from './announce.ts'
import type { Health } from './health.ts'

const now = Date.parse('2026-09-19T20:00:00Z')
const red: Health[] = [{ repository: 'mica-build', state: 'red-and-quiet', redSince: '2026-09-17T10:27:00Z', redHours: 57.55, runsSince: 0 }]

test('opens one issue when something is red', () => {
  const action = decide(red, undefined, now)
  expect(action.kind).toBe('create')
  expect(action.kind === 'create' && action.title.startsWith(MARKER)).toBe(true)
})

test('updates the open issue when the set or the ages changed', () => {
  const stale = { number: 7, title: `${MARKER}: mica-build`, body: 'older body' }
  expect(decide(red, stale, now)).toMatchObject({ kind: 'update', number: 7 })
})

test('says nothing when the issue already says exactly this', () => {
  const action = decide(red, undefined, now)
  const current = { number: 7, title: action.kind === 'create' ? action.title : '', body: action.kind === 'create' ? action.body : '' }
  expect(decide(red, current, now).kind).toBe('none')
})

test('closes the issue when everything is green, and does nothing when there is none', () => {
  expect(decide([], { number: 7, title: `${MARKER}: x`, body: '' }, now)).toEqual({ kind: 'close', number: 7 })
  expect(decide([], undefined, now)).toEqual({ kind: 'none' })
})
