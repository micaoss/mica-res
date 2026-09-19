import { expect, test } from 'bun:test'
import { reconcile } from './reconcile.ts'

const sha = (letter: string) => letter.repeat(64)
const pinned = [
  { key: 'upstream/deb/bash/b.deb', sha256: sha('a') },
  { key: 'mica/uefi-x64/20260916-0845/x.img.gz', sha256: sha('b') },
  { key: 'upstream/source/rust/rust.tar.xz', sha256: sha('c') },
]

test('agreement, absence and the column nobody has looked at', () => {
  const answer = reconcile(pinned, [
    { key: 'upstream/deb/bash/b.deb', size: 1, sha256: sha('a') },
    { key: 'mica/uefi-x64/20260916-0845/x.img.gz', size: 2, sha256: sha('b') },
    { key: 'upstream/deb/old/gone.deb', size: 3, sha256: sha('d') },
  ])
  expect(answer.agreed.map(o => o.key)).toEqual(['upstream/deb/bash/b.deb', 'mica/uefi-x64/20260916-0845/x.img.gz'])
  expect(answer.missing.map(o => o.key)).toEqual(['upstream/source/rust/rust.tar.xz'])
  // Held by the catalog, named by no lock: it came from the retired index and
  // nothing pins it today.
  expect(answer.unpinned.map(o => o.key)).toEqual(['upstream/deb/old/gone.deb'])
  expect(answer.conflicts).toEqual([])
})

test('a key the catalog holds with a digest no lock names is a conflict, and the lock wins', () => {
  const answer = reconcile(pinned, [{ key: 'upstream/deb/bash/b.deb', size: 1, sha256: sha('e') }])
  expect(answer.conflicts).toEqual([{ key: 'upstream/deb/bash/b.deb', lock: sha('a'), catalog: sha('e') }])
  // A conflicting key is not counted as agreed, and it is not silently
  // republished either: it is reported.
  expect(answer.agreed).toEqual([])
  expect(answer.missing.map(o => o.key)).not.toContain('upstream/deb/bash/b.deb')
})

test('the same bytes under a different key are not agreement', () => {
  const answer = reconcile(pinned, [{ key: 'upstream/deb/elsewhere/b.deb', size: 1, sha256: sha('a') }])
  expect(answer.agreed).toEqual([])
  expect(answer.unpinned.map(o => o.key)).toEqual(['upstream/deb/elsewhere/b.deb'])
  expect(answer.missing).toHaveLength(3)
})
