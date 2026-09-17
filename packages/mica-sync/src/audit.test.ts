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

test('compares the length the download host serves with the catalog', async () => {
  const fetcher = routes({
    'HEAD https://dl.test/mica/a': () => new Response(null, { headers: { 'content-length': '1' } }),
    'HEAD https://dl.test/mica/b': () => new Response(null, { headers: { 'content-length': '9' } }),
    'HEAD https://dl.test/mica/c': () => new Response(null, { status: 404 }),
  })
  const problems = await checkBytes('https://dl.test', [
    { key: 'mica/a', size: 1, sha256: digest('a') },
    { key: 'mica/b', size: 2, sha256: digest('b') },
    { key: 'mica/c', size: 3, sha256: digest('c') },
  ], fetcher)
  expect(problems.sort()).toEqual(['mica/b: the download host serves 9 bytes, the catalog says 2', 'mica/c: 404 from the download host'])
})
