import { expect, test } from 'bun:test'
import { fetchAllowing404 } from './fetch.ts'

test('a 404 is an answer and is not retried', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  expect(await fetchAllowing404('https://example.invalid/x', {}, fetcher)).toBeUndefined()
  expect(calls).toBe(1)
})

test('a reset socket is asked again rather than abandoning the walk', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    if (calls === 1)
      throw new Error('The socket connection was closed unexpectedly')
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  expect(await fetchAllowing404('https://example.invalid/x', {}, fetcher)).toBe('ok')
  expect(calls).toBe(2)
})

test('a 403 is a refusal, not a retry', async () => {
  const fetcher = (async () => new Response('', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch
  expect(fetchAllowing404('https://example.invalid/x', {}, fetcher)).rejects.toThrow('403')
})
