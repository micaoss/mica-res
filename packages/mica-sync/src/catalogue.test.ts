import { expect, test } from 'bun:test'
import { objectFromRow, readCatalogue } from './catalogue.ts'
import { coverageOf, poolsCovered } from './coverage.ts'

test('an object carries the fields the index carried, and is always mirrored', () => {
  const object = objectFromRow('oci', {
    path: 'blobs/sha256/' + 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    size: 233,
    meta: {
      kind: 'oci-blob',
      origin: 'https://ghcr.io/v2/micaoss/mica-build-env/blobs/sha256:a',
      pins: JSON.stringify([{ repository: 'mica-build', lock: 'locks/mica-build-env.lock', release: '20260916-0735', row: 'image mica-build-env base amd64 ref' }]),
    },
  })
  expect(object.kind).toBe('oci-blob')
  expect(object.state).toBe('mirrored')
  expect(object.pins).toHaveLength(1)
  expect(coverageOf([object]).releases.get('micaoss/mica-build-env')?.has('20260916-0735')).toBe(true)
  expect(poolsCovered(coverageOf([object]))).toBe(false)
})

test('an object with no kind in its metadata is refused, not bucketed', () => {
  expect(() => objectFromRow('mica', { path: 'x', sha256: 'b'.repeat(64), size: 1, meta: {} }))
    .toThrow('meta-kind')
})

test('a row the reader cannot describe is reported, not thrown, so a repair can still run', async () => {
  const rows = [
    { path: 'git/x/abc.pack.00', sha256: 'a'.repeat(64), size: 1, meta: {} },
    { path: 'deb/bash.deb', sha256: 'b'.repeat(64), size: 2, meta: { kind: 'deb' } },
  ]
  const publisher = { base: 'https://example.invalid', token: 'x', fetcher: (async () => new Response(JSON.stringify({ data: rows }))) as unknown as typeof fetch }
  const answer = await readCatalogue(publisher, ['upstream', 'status'])
  expect(answer.objects).toHaveLength(1)
  expect(answer.unusable).toHaveLength(1)
  expect(answer.unusable[0]!.key).toBe('upstream/git/x/abc.pack.00')
  expect(answer.namespaces).toEqual(['upstream'])
})
