import { expect, test } from 'bun:test'
import { mergeObjects, objectFromSourceRow } from './objects.ts'

const pin = { repository: 'mica-system-base', lock: 'locks/upstream.lock', release: 'main' }
const deb = {
  name: 'bash',
  arch: 'amd64',
  version: '5.3.3-1',
  sha256: 'a'.repeat(64),
  url: 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/b/bash/bash_5.3.3-1_amd64.deb',
}
const tarball = {
  name: 'source.busybox',
  arch: 'all',
  version: '1.38.0',
  sha256: 'b'.repeat(64),
  url: 'https://busybox.net/downloads/busybox-1.38.0.tar.bz2',
}

test('a .deb row becomes a deb object under the deb route', () => {
  const object = objectFromSourceRow(deb, pin)
  expect(object.kind).toBe('deb')
  expect(object.path).toBe(`blob/aa/${'a'.repeat(64)}`)
  expect(object.readable).toEqual(['/d/upstream/deb/bash/bash_5.3.3-1_amd64.deb'])
  expect(object.origin).toBe(deb.url)
  expect(object.pins).toEqual([{ ...pin, row: 'source bash amd64' }])
})

test('a tarball row becomes a source object under the source route', () => {
  const object = objectFromSourceRow(tarball, pin)
  expect(object.kind).toBe('source')
  expect(object.readable).toEqual(['/d/upstream/source/source.busybox/busybox-1.38.0.tar.bz2'])
})

test('the same bytes pinned twice give one object with both pins', () => {
  const other = { repository: 'mica-build', lock: 'locks/mica-system-base.lock', release: 'main' }
  const merged = mergeObjects([objectFromSourceRow(deb, pin), objectFromSourceRow(deb, other)])
  expect(merged).toHaveLength(1)
  expect(merged[0]?.pins).toHaveLength(2)
})

test('the same bytes pinned under two names keep both names', () => {
  const renamed = { ...deb, name: 'bash-static' }
  const merged = mergeObjects([objectFromSourceRow(deb, pin), objectFromSourceRow(renamed, pin)])
  expect(merged).toHaveLength(1)
  expect(merged[0]?.readable).toHaveLength(2)
})

test('two different byte strings under one readable name are refused', () => {
  const clash = { ...deb, sha256: 'c'.repeat(64) }
  expect(() => mergeObjects([objectFromSourceRow(deb, pin), objectFromSourceRow(clash, pin)])).toThrow('readable-clash')
})
