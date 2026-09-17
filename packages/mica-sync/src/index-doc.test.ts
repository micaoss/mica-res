import { expect, test } from 'bun:test'
import { buildIndex, readIndex, readPointer, renderIndex, renderPointer, summarise } from './index-doc.ts'

const object = (digest: string) => ({
  kind: 'deb' as const,
  sha256: digest,
  size: 12,
  origin: 'https://snapshot.debian.org/x.deb',
  path: `blob/${digest.slice(0, 2)}/${digest}`,
  readable: [`/d/upstream/deb/x/${digest.slice(0, 4)}.deb`],
  pins: [{ repository: 'mica-system-base', lock: 'locks/upstream.lock', release: 'main', row: 'source x amd64' }],
})

test('renders canonical JSON with a final LF and no insignificant whitespace', () => {
  const text = renderIndex(buildIndex({ version: '20260916-0728', objects: [object('b'.repeat(64))] }))
  expect(text.endsWith('}\n')).toBe(true)
  expect(text).not.toContain('\n  ')
  expect(text.startsWith('{"schema":"mica/resource-index/v1","version":"20260916-0728"')).toBe(true)
  expect(text).toContain('"state":"pending"')
})

test('sorts objects by sha256 regardless of input order', () => {
  const doc = buildIndex({ version: '20260916-0728', objects: [object('c'.repeat(64)), object('a'.repeat(64))] })
  expect(doc.objects.map(o => o.sha256[0])).toEqual(['a', 'c'])
})

test('a rendered index reads back', () => {
  const doc = buildIndex({ version: '20260916-0728', objects: [object('a'.repeat(64))] })
  expect(readIndex(renderIndex(doc))).toEqual(doc)
})

test('refuses a document without a final LF', () => {
  const text = renderIndex(buildIndex({ version: '20260916-0728', objects: [] }))
  expect(() => readIndex(text.trimEnd())).toThrow('encoding')
})

test('refuses an unknown schema', () => {
  const text = renderIndex(buildIndex({ version: '20260916-0728', objects: [] })).replace('resource-index/v1', 'resource-index/v2')
  expect(() => readIndex(text)).toThrow('schema')
})

test('refuses a version that is not a UTC release stamp', () => {
  expect(() => buildIndex({ version: '2026-09-16', objects: [] })).toThrow('version')
})

test('refuses objects out of order', () => {
  const doc = buildIndex({ version: '20260916-0728', objects: [object('a'.repeat(64)), object('b'.repeat(64))] })
  const text = renderIndex({ ...doc, objects: [doc.objects[1]!, doc.objects[0]!] })
  expect(() => readIndex(text)).toThrow('sort-order')
})

test('refuses the same sha256 twice', () => {
  const doc = buildIndex({ version: '20260916-0728', objects: [object('a'.repeat(64))] })
  const text = renderIndex({ ...doc, objects: [doc.objects[0]!, doc.objects[0]!] })
  expect(() => readIndex(text)).toThrow('duplicate-object')
})

test('the pointer names a snapshot and reads back', () => {
  const text = renderPointer({ version: '20260916-0728', sha256: 'd'.repeat(64) })
  expect(text.endsWith('\n')).toBe(true)
  expect(readPointer(text).version).toBe('20260916-0728')
})

test('refuses a pointer without a snapshot digest', () => {
  expect(() => readPointer('{"schema":"mica/resource-index-pointer/v1","version":"20260916-0728","sha256":"short"}\n')).toThrow('field-value')
})

test('summarise reports mirrored and pinned counts per kind, so a vanished kind is visible', () => {
  const rows = summarise([
    { ...object('a'.repeat(64)), kind: 'deb', state: 'mirrored' },
    { ...object('b'.repeat(64)), kind: 'git-pack', state: 'pending' },
  ])
  expect(rows.map(row => [row.kind, row.count, row.mirrored])).toEqual([['deb', 1, 1], ['git-pack', 1, 0]])
})
