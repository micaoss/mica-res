import { expect, test } from 'bun:test'
import { descriptorObjects, imageRows, manifestObject } from './ghcr.ts'
import { parseLock } from './locks.ts'

const lock = parseLock([
  '# mica-lock v1',
  'release\tmica-build-env\t20260915-0138\t' + 'f'.repeat(40),
  'image\tmica-build-env\tbase\tamd64\tghcr.io/micaoss/mica-build-env@sha256:' + 'a'.repeat(64),
  'image\tupstream\talpine:3.24.1\tamd64\tdocker.io/library/alpine:3.24.1@sha256:' + 'b'.repeat(64),
  '',
].join('\n'))

const pin = { repository: 'mica-build-env', lock: 'locks/mica-build-env.lock', release: '20260915-0138' }

test('reads only the named repository image rows, never the upstream ones', () => {
  const rows = imageRows(lock, 'mica-build-env')
  expect(rows).toHaveLength(1)
  expect(rows[0]?.digest).toBe('a'.repeat(64))
})

test('a manifest becomes one object per config and layer', () => {
  const objects = descriptorObjects({
    config: { digest: `sha256:${'c'.repeat(64)}`, size: 1 },
    layers: [{ digest: `sha256:${'d'.repeat(64)}`, size: 2 }],
  }, pin, imageRows(lock, 'mica-build-env')[0]!)
  expect(objects.map(object => object.kind)).toEqual(['oci-blob', 'oci-blob'])
  expect(objects[1]?.size).toBe(2)
  expect(objects[0]?.path).toBe(`blob/cc/${'c'.repeat(64)}`)
})

test('an index becomes one object per platform manifest', () => {
  const objects = descriptorObjects({ manifests: [{ digest: `sha256:${'e'.repeat(64)}`, size: 3 }] }, pin, imageRows(lock, 'mica-build-env')[0]!)
  expect(objects).toHaveLength(1)
  expect(objects[0]?.sha256).toBe('e'.repeat(64))
})

test('a manifest object carries its media type and its registry tag name', () => {
  const tagged = { name: 'base', platform: 'index', reference: 'ghcr.io/micaoss/mica-build-env:base.20260916-0735@sha256:' + 'f'.repeat(64), digest: 'f'.repeat(64) }
  const object = manifestObject(tagged, 'mica-build-env', 1234, 'application/vnd.oci.image.index.v1+json', pin)
  expect(object.mediaType).toBe('application/vnd.oci.image.index.v1+json')
  expect(object.readable).toContain('/v2/micaoss/mica-build-env/manifests/base.20260916-0735')
  expect(object.size).toBe(1234)
})

test('a manifest referenced without a tag gets no registry name', () => {
  const untagged = { name: 'base', platform: 'amd64', reference: 'ghcr.io/micaoss/mica-build-env@sha256:' + 'e'.repeat(64), digest: 'e'.repeat(64) }
  expect(manifestObject(untagged, 'mica-build-env', 10, 'application/vnd.oci.image.manifest.v1+json', pin).readable).toHaveLength(1)
})

test('a descriptor keeps the media type the manifest declared', () => {
  const objects = descriptorObjects({ layers: [{ digest: `sha256:${'d'.repeat(64)}`, size: 2, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }] }, pin, imageRows(lock, 'mica-build-env')[0]!)
  expect(objects[0]?.mediaType).toBe('application/vnd.oci.image.layer.v1.tar+gzip')
})
