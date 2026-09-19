import { expect, test } from 'bun:test'
import { carriedOrigin, legacyBlobUrl } from './carry.ts'

const sha = 'a'.repeat(64)

test('the legacy key of a digest is where the v1 mirror left its bytes', () => {
  expect(legacyBlobUrl('https://dl.res.micaos.dev', sha)).toBe(`https://dl.res.micaos.dev/blob/aa/${sha}`)
})

test('an object whose bytes are already in the bucket is carried, not fetched again', async () => {
  const seen: string[] = []
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${input.toString()}`)
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  expect(await carriedOrigin('https://dl.res.micaos.dev', sha, stub)).toBe(`https://dl.res.micaos.dev/blob/aa/${sha}`)
  expect(seen).toEqual([`HEAD https://dl.res.micaos.dev/blob/aa/${sha}`])
})

test('an object the bucket does not hold is fetched from upstream as before', async () => {
  const stub = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
  expect(await carriedOrigin('https://dl.res.micaos.dev', sha, stub)).toBeUndefined()
})

test('a download host that errs is treated as not holding it, never as holding it', async () => {
  const stub = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch
  expect(await carriedOrigin('https://dl.res.micaos.dev', sha, stub)).toBeUndefined()
})
