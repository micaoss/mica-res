import { expect, test } from 'bun:test'
import { checkMirrors, mirrorEntries } from './mirrors.ts'

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

test('a 404 is the lag and a wrong digest is a defect', async () => {
  const entries = [
    { file: 'late.img.gz', mirror: 'https://dl.test/late', sha256: 'a'.repeat(64), size: 1 },
    { file: 'wrong.img.gz', mirror: 'https://dl.test/wrong', sha256: 'b'.repeat(64), size: 2 },
    { file: 'good.img.gz', mirror: 'https://dl.test/good', sha256: Bun.SHA256.hash(new TextEncoder().encode('ok'), 'hex'), size: 2 },
  ]
  const stub = (async (input: string | URL | Request) => {
    const url = input.toString()
    if (url.endsWith('/late'))
      return new Response(null, { status: 404 })
    return new Response(new TextEncoder().encode(url.endsWith('/good') ? 'ok' : 'nope'))
  }) as unknown as typeof fetch
  const answer = await checkMirrors(entries, stub)
  expect(answer.pending).toHaveLength(1)
  expect(answer.wrong).toHaveLength(1)
  expect(answer.verified).toBe(1)
})
