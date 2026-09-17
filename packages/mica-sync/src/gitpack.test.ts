import { expect, test } from 'bun:test'
import { chunkNames, manifestName, packObjects, renderManifest } from './gitpack.ts'

const tree = { repository: 'mica-boards', name: 'cx3576-kernel', url: 'https://github.com/armbian/linux-rockchip.git', commit: 'c'.repeat(40) }

test('a tree names its manifest and its chunks by commit', () => {
  expect(manifestName(tree)).toBe(`/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.json`)
  expect(chunkNames(tree, 3)).toEqual([
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.pack.00`,
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.pack.01`,
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.pack.02`,
  ])
})

test('the manifest is canonical JSON naming the pack and its ordered chunks', () => {
  const text = renderManifest(tree, { sha256: 'a'.repeat(64), size: 10 }, [{ sha256: 'b'.repeat(64), size: 6 }, { sha256: 'd'.repeat(64), size: 4 }])
  expect(text.endsWith('}\n')).toBe(true)
  expect(text.startsWith('{"schema":"mica/git-pack/v1","repository":"mica-boards","name":"cx3576-kernel"')).toBe(true)
  const manifest = JSON.parse(text)
  expect(manifest.commit).toBe('c'.repeat(40))
  expect(manifest.chunks.map((chunk: { sha256: string }) => chunk.sha256)).toEqual(['b'.repeat(64), 'd'.repeat(64)])
})

test('the objects of a tree are the chunks plus the manifest, every one content-addressed', () => {
  const pack = { sha256: 'a'.repeat(64), size: 10 }
  const chunks = [{ sha256: 'b'.repeat(64), size: 6 }, { sha256: 'd'.repeat(64), size: 4 }]
  const objects = packObjects(tree, pack, chunks, renderManifest(tree, pack, chunks))
  expect(objects).toHaveLength(3)
  expect(objects.every(object => object.kind === 'git-pack')).toBe(true)
  expect(objects.every(object => object.commit === 'c'.repeat(40))).toBe(true)
  expect(objects.map(object => object.readable[0])).toEqual([
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.pack.00`,
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.pack.01`,
    `/d/upstream/git/cx3576-kernel/${'c'.repeat(40)}.json`,
  ])
  expect(objects[0]?.path).toBe(`blob/bb/${'b'.repeat(64)}`)
  // A pack is verified by git at the consumer, so the mirror records no origin
  // for it: there is no URL that serves these bytes upstream.
  expect(objects.every(object => object.origin === undefined)).toBe(true)
})
