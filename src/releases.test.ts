import { expect, test } from 'bun:test'
import { assetRows, parseLock } from './locks.ts'
import { assetObjects, keptReleases } from './releases.ts'

const lock = parseLock([
  '# mica-lock v1',
  'release\tmica-build\tx64.20260915-2230\t' + 'f'.repeat(40),
  'asset\tx64-dev\timage\tdisk\tmica-x64-dev-20260915-2230.img.gz\t' + 'a'.repeat(64),
  'asset\tx64-dev\tupdate\tkernel\tmica-x64-dev-20260915-2230.kernel.micaupd\t' + 'b'.repeat(64),
  '',
].join('\n'))

test('keeps the three newest releases of each scope and ignores index releases', () => {
  const kept = keptReleases([
    'x64/20260915-2230', 'x64/20260915-2042', 'x64/20260914-1000', 'x64/20260913-0900',
    'cx3576/20260915-2230', 'mica/20260915-2231', 'mica.20260915-2231',
  ])
  expect(kept).toEqual(['cx3576/20260915-2230', 'x64/20260914-1000', 'x64/20260915-2042', 'x64/20260915-2230'])
})

test('maps asset rows to readable product paths, with the release size', () => {
  const sizes = new Map([['mica-x64-dev-20260915-2230.img.gz', 82], ['mica-x64-dev-20260915-2230.kernel.micaupd', 16]])
  const objects = assetObjects('x64/20260915-2230', assetRows(lock), sizes, 'mica-build')
  expect(objects.map(object => object.kind)).toEqual(['product-image', 'update-archive'])
  expect(objects[0]?.readable).toEqual(['/d/mica/x64/20260915-2230/mica-x64-dev-20260915-2230.img.gz'])
  expect(objects[0]?.sha256).toBe('a'.repeat(64))
  expect(objects[1]?.size).toBe(16)
  expect(objects[0]?.pins[0]?.release).toBe('x64/20260915-2230')
})

test('refuses an asset row the release does not publish', () => {
  expect(() => assetObjects('x64/20260915-2230', assetRows(lock), new Map(), 'mica-build')).toThrow('asset-not-published')
})

test('refuses an asset row without a sha256', () => {
  expect(() => parseLock('# mica-lock v1\nasset\tx\timage\tdisk\tx.img.gz\tshort\n')).toThrow('field-value')
})
