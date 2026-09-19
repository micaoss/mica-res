import { expect, test } from 'bun:test'
import { mirrorEntries } from './mirrors.ts'

const index = {
  version: '20260919-2115',
  products: [{
    product: 'cx3576-dev',
    images: [{ kind: 'disk', file: 'a.img.gz', url: 'https://github.com/x/a.img.gz', mirrors: ['https://dl.res.micaos.dev/mica/cx3576/20260919-2103/a.img.gz'], sha256: 'a'.repeat(64), size: 10 }],
    updates: [{ kind: 'full', file: 'a.micaupd', url: 'https://github.com/x/a.micaupd', sha256: 'b'.repeat(64), size: 20 }],
  }],
}

test('every entry carrying a mirror is checked, and one without is not invented', () => {
  const entries = mirrorEntries(index)
  expect(entries).toEqual([{ file: 'a.img.gz', mirror: 'https://dl.res.micaos.dev/mica/cx3576/20260919-2103/a.img.gz', sha256: 'a'.repeat(64), size: 10 }])
})

test('an index with no mirrors yields nothing to check rather than failing', () => {
  expect(mirrorEntries({ version: 'x', products: [{ product: 'p', images: [], updates: [] }] })).toEqual([])
})
