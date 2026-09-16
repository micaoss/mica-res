import { expect, test } from 'bun:test'
import { ensureBlob, putNamed } from './upload.ts'

const bytes = new TextEncoder().encode('hello')
const digest = Bun.SHA256.hash(bytes, 'hex')
const object = {
  kind: 'deb' as const,
  sha256: digest,
  origin: 'https://origin.example/hello.deb',
  path: `blob/${digest.slice(0, 2)}/${digest}`,
  readable: ['/d/upstream/deb/hello/hello.deb'],
  pins: [{ repository: 'r', lock: 'l', release: 'main', row: 'source hello all' }],
}
const target = { base: 'https://res.example', token: 'secret' }

function fetcher(routes: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const answer = routes[`${method} ${url}`]
    if (answer === undefined)
      throw new Error(`unexpected ${method} ${url}`)
    return typeof answer === 'function' ? answer() : answer
  }) as typeof fetch
}

test('an object already in the bucket is not downloaded', () => {
  const fetch = fetcher({ [`HEAD ${target.base}/${object.path}`]: new Response(null, { status: 200 }) })
  return expect(ensureBlob(object, target, fetch)).resolves.toBe('present')
})

test('a missing object is downloaded, verified and uploaded', async () => {
  let authorization: string | undefined
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString()
    if (url === `${target.base}/${object.path}` && (init?.method ?? 'GET') === 'HEAD')
      return new Response(null, { status: 404 })
    if (url === object.origin)
      return new Response(bytes)
    if (url === `${target.base}/w/blob/${digest}`) {
      authorization = new Headers(init?.headers as Record<string, string>).get('authorization') ?? undefined
      return new Response('stored\n', { status: 200 })
    }
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch

  expect(await ensureBlob(object, target, stub)).toBe('stored')
  expect(authorization).toBe('Bearer secret')
})

test('bytes that do not match the pinned sha256 are refused before any upload', async () => {
  const fetch = fetcher({
    [`HEAD ${target.base}/${object.path}`]: new Response(null, { status: 404 }),
    [`GET ${object.origin}`]: new Response(new TextEncoder().encode('tampered')),
  })
  await expect(ensureBlob(object, target, fetch)).rejects.toThrow('sha256-mismatch')
})

test('a refusal from the write endpoint is an error, not a skip', async () => {
  const fetch = fetcher({
    [`HEAD ${target.base}/${object.path}`]: new Response(null, { status: 404 }),
    [`GET ${object.origin}`]: new Response(bytes),
    [`PUT ${target.base}/w/blob/${digest}`]: new Response('exists-different\n', { status: 409 }),
  })
  await expect(ensureBlob(object, target, fetch)).rejects.toThrow('409')
})

test('an object with no origin cannot be mirrored', async () => {
  const fetch = fetcher({ [`HEAD ${target.base}/${object.path}`]: new Response(null, { status: 404 }) })
  await expect(ensureBlob({ sha256: object.sha256, path: object.path }, target, fetch)).rejects.toThrow('no-origin')
})

test('a named write posts to its prefix route and reports what the endpoint decided', async () => {
  const fetch = fetcher({ [`PUT ${target.base}/w/index/current.json`]: new Response('replaced\n', { status: 200 }) })
  expect(await putNamed('index/current.json', '{}\n', target, fetch)).toBe('replaced')
})
