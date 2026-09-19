import { expect, test } from 'bun:test'
import { canonicalKey, listHeld, publishBatch, registryTags, stageBytes } from './publish.ts'

const sha = 'a'.repeat(64)

function recorder(routes: Record<string, (init: RequestInit | undefined) => Response>) {
  const calls: { method: string, url: string, body?: string, headers?: Record<string, string> }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString()
    const method = init?.method ?? 'GET'
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}), ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}) })
    const route = Object.entries(routes).find(([key]) => `${method} ${url}`.startsWith(key))
    if (route === undefined)
      throw new Error(`unexpected ${method} ${url}`)
    return route[1](init)
  }) as typeof fetch
  return { calls, fetcher }
}

test('the canonical key prefers the Debian pool name and addresses OCI blobs by digest', () => {
  expect(canonicalKey({ kind: 'deb', sha256: sha, readable: ['upstream/deb/bash/b.deb', 'upstream/debian/pool/main/b/bash/b.deb'] })).toBe('upstream/debian/pool/main/b/bash/b.deb')
  expect(canonicalKey({ kind: 'product-image', sha256: sha, readable: ['mica/uefi-x64/20260917-0000/x.img.gz'] })).toBe('mica/uefi-x64/20260917-0000/x.img.gz')
  expect(canonicalKey({ kind: 'oci-blob', sha256: sha, readable: ['/v2/micaoss/mica-build-env/manifests/base.1'] })).toBe(`oci/blobs/sha256/${sha}`)
  expect(canonicalKey({ kind: 'source', sha256: sha, readable: [] })).toBeUndefined()
})

test('registry tags come from manifest names that are not digests', () => {
  expect(registryTags({ sha256: sha, readable: ['/v2/micaoss/env/manifests/base.1', `/v2/micaoss/env/manifests/sha256:${sha}`, 'x'] }))
    .toEqual([{ repository: 'micaoss/env', tag: 'base.1', digest: `sha256:${sha}` }])
})

test('bytes go to the presigned URL with the signed headers, never to the API', async () => {
  const { calls, fetcher } = recorder({
    'POST https://res.test/admin/api/res/namespaces/upstream/uploads': () => Response.json({ data: { id: 'up1', url: 'https://r2.test/staging/up1?sig', headers: { 'x-amz-checksum-sha256': 'abc' } } }),
    'PUT https://r2.test/staging/up1': () => new Response(null, { status: 200 }),
  })
  const id = await stageBytes({ base: 'https://res.test/admin/api', token: 'pat_x', fetcher }, 'upstream', new TextEncoder().encode('pack'), 'application/octet-stream')
  expect(id).toBe('up1')
  expect(JSON.parse(calls[0]!.body!)).toEqual({ sha256: Bun.SHA256.hash('pack', 'hex'), size: 4, contentType: 'application/octet-stream' })
  expect(calls[0]!.headers!.authorization).toBe('Bearer pat_x')
  expect(calls[1]!.headers).toEqual({ 'x-amz-checksum-sha256': 'abc' })
})

test('lists held objects across pages and publishes in batches of 200', async () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ path: `p${String(from + i).padStart(5, '0')}`, sha256: sha, size: 1 }))
  const { calls, fetcher } = recorder({
    'GET https://res.test/api/res/namespaces/mica/objects?limit=5000&after=': () => Response.json({ data: page(1, 5000) }),
    'GET https://res.test/api/res/namespaces/mica/objects?limit=5000': () => Response.json({ data: page(5000, 0) }),
    'POST https://res.test/api/res/namespaces/mica/batch': init => Response.json({ data: { objects: (JSON.parse(init!.body as string) as { objects: unknown[] }).objects.map(() => ({ outcome: 'created' })) } }),
  })
  const publisher = { base: 'https://res.test/api', token: 't', fetcher }
  expect((await listHeld(publisher, 'mica')).size).toBe(5001)
  const items = Array.from({ length: 450 }, (_, i) => ({ path: `x/${i}`, source: { sha256: sha } }))
  expect(await publishBatch(publisher, 'mica', items)).toEqual({ changed: 450 })
  expect(calls.filter(c => c.method === 'POST').map(c => (JSON.parse(c.body!) as { objects: unknown[] }).objects.length)).toEqual([200, 200, 50])
})
