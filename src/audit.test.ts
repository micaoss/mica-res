import { expect, test } from 'bun:test'
import { classifyKey, compare, parsePublished } from './audit.ts'

// This check deliberately shares no code with the enumerator, so it parses the
// published document itself rather than reusing the writer's reader.
const digest = (letter: string) => letter.repeat(64)
const published = JSON.stringify({
  schema: 'mica/resource-index/v1',
  version: '20260916-1738',
  objects: [
    { kind: 'deb', state: 'mirrored', sha256: digest('a'), size: 10, path: `blob/aa/${digest('a')}`, readable: ['/d/x'], pins: [] },
    { kind: 'git-pack', state: 'mirrored', sha256: digest('b'), size: 20, path: `blob/bb/${digest('b')}`, readable: ['/d/y'], pins: [] },
  ],
})

test('parses the published document without the writer help, and checks each path against its digest', () => {
  const objects = parsePublished(published)
  expect(objects.map(object => object.sha256)).toEqual([digest('a'), digest('b')])
})

test('refuses a document whose path is not the digest path', () => {
  const broken = published.replace(`blob/bb/${digest('b')}`, `blob/cc/${digest('b')}`)
  expect(() => parsePublished(broken)).toThrow('path')
})

test('refuses a document that lists one digest twice', () => {
  const twice = JSON.parse(published) as { objects: unknown[] }
  twice.objects = [twice.objects[0], twice.objects[0]]
  expect(() => parsePublished(JSON.stringify(twice))).toThrow('duplicate')
})

test('classifies a bucket key by the prefix the design allows', () => {
  expect(classifyKey(`blob/aa/${digest('a')}`)).toBe('blob')
  expect(classifyKey('index/current.json')).toBe('index')
  expect(classifyKey('index/20260916-1738.json')).toBe('index')
  expect(classifyKey('site/index.html')).toBe('site')
  expect(classifyKey('status/runs/mica-res/1.json')).toBe('status')
  expect(classifyKey('somewhere/else')).toBe('unexpected')
})

test('a named object missing from the bucket is a refusal; an unreferenced blob is an orphan', () => {
  const answer = compare(parsePublished(published), [
    { key: `blob/aa/${digest('a')}`, size: 10 },
    { key: `blob/cc/${digest('c')}`, size: 30 },
    { key: 'index/current.json', size: 1 },
  ])
  expect(answer.missing.map(object => object.sha256)).toEqual([digest('b')])
  expect(answer.orphans.map(orphan => orphan.key)).toEqual([`blob/cc/${digest('c')}`])
  expect(answer.unexpected).toEqual([])
  expect(answer.sizeMismatches).toEqual([])
})

test('a size that disagrees with the index is a refusal, not an orphan', () => {
  const answer = compare(parsePublished(published), [
    { key: `blob/aa/${digest('a')}`, size: 99 },
    { key: `blob/bb/${digest('b')}`, size: 20 },
  ])
  expect(answer.sizeMismatches).toEqual([{ sha256: digest('a'), index: 10, bucket: 99 }])
})

test('a key outside the design prefixes is a refusal', () => {
  const answer = compare(parsePublished(published), [
    { key: `blob/aa/${digest('a')}`, size: 10 },
    { key: `blob/bb/${digest('b')}`, size: 20 },
    { key: 'scratch/tmp', size: 1 },
  ])
  expect(answer.unexpected).toEqual(['scratch/tmp'])
})
