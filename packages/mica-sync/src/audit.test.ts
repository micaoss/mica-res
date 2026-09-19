import { expect, test } from 'bun:test'
import { checkBytes, checkListing, walkNamespace } from './audit.ts'

const digest = (letter: string) => letter.repeat(64)

function routes(map: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input.toString()}`
    const route = map[key]
    if (route === undefined)
      throw new Error(`unexpected ${key}`)
    return route()
  }) as typeof fetch
}

test('walks every directory and page of a namespace listing', async () => {
  const fetcher = routes({
    'GET https://res.test/mica/': () => Response.json({ directories: [{ path: 'a/' }], objects: [{ path: 'top', size: 1, sha256: digest('a') }], next: 'top' }),
    'GET https://res.test/mica/?after=top': () => Response.json({ directories: [], objects: [{ path: 'z', size: 2, sha256: digest('b') }], next: null }),
    'GET https://res.test/mica/a/': () => Response.json({ directories: [], objects: [{ path: 'a/x y', size: 3, sha256: digest('c') }], next: null }),
  })
  const objects = await walkNamespace('https://res.test', 'mica', fetcher)
  expect(objects.map(o => o.key)).toEqual(['mica/top', 'mica/z', 'mica/a/x y'])
})

test('refuses a count that disagrees with the listings, a bad digest and a duplicate', () => {
  const problems = checkListing({ name: 'mica', visibility: 'public', listable: true, objects: 3 }, [
    { key: 'mica/a', size: 1, sha256: digest('a') },
    { key: 'mica/a', size: 1, sha256: 'nope' },
  ])
  expect(problems).toHaveLength(3)
})

test('a length that agrees settles it; one that does not is settled by the bytes', async () => {
  // `a` agrees on the header alone. `b` disagrees, so the bytes decide, and
  // they hash to something else. `c` does not serve at all.
  const fetcher = routes({
    'HEAD https://dl.test/mica/a': () => new Response(null, { headers: { 'content-length': '1' } }),
    'HEAD https://dl.test/mica/b': () => new Response(null, { headers: { 'content-length': '9' } }),
    'GET https://dl.test/mica/b': () => new Response(new TextEncoder().encode('xy')),
    'HEAD https://dl.test/mica/c': () => new Response(null, { status: 404 }),
  })
  const problems = await checkBytes('https://dl.test', [
    { key: 'mica/a', size: 1, sha256: digest('a') },
    { key: 'mica/b', size: 2, sha256: digest('b') },
    { key: 'mica/c', size: 3, sha256: digest('c') },
  ], fetcher)
  expect(problems).toHaveLength(2)
  expect(problems.find(p => p.startsWith('mica/b'))).toContain('hashing to')
  expect(problems).toContain('mica/c: 404 from the download host')
})

test('a HEAD without a content-length is settled by hashing the bytes, not called missing', async () => {
  const bytes = new TextEncoder().encode('{"schema":"x"}')
  const object = { key: 'status/current.json', size: bytes.length, sha256: Bun.SHA256.hash(bytes, 'hex') }
  const stub = (async (_input: string | URL | Request, init?: RequestInit) => {
    // The download host answers HEAD without a content-length, as it does for
    // a compressible object, and serves the bytes on GET.
    return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(bytes)
  }) as unknown as typeof fetch
  expect(await checkBytes('https://dl.example.test', [object], stub)).toEqual([])
})

test('bytes that hash to something else are still a problem', async () => {
  const object = { key: 'status/current.json', size: 3, sha256: 'a'.repeat(64) }
  const stub = (async (_input: string | URL | Request, init?: RequestInit) =>
    init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(new TextEncoder().encode('xyz'))) as unknown as typeof fetch
  const problems = await checkBytes('https://dl.example.test', [object], stub)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('hashing to')
})
