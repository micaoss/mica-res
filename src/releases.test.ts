import { expect, test } from 'bun:test'
import { assetRows, parseLock } from './locks.ts'
import { assetObjects, keptReleases } from './releases.ts'

const lock = parseLock([
  '# mica-lock v1',
  'release\tmica-build\tuefi-x64.20260916-0845\t' + 'f'.repeat(40),
  'asset\tuefi-x64-dev\timage\tdisk\tmica-uefi-x64-dev-20260916-0845.img.gz\t' + 'a'.repeat(64),
  'asset\tuefi-x64-dev\tupdate\tkernel\tmica-uefi-x64-dev-20260916-0845.kernel.micaupd\t' + 'b'.repeat(64),
  '',
].join('\n'))

test('keeps the three newest releases of each scope and ignores index releases', () => {
  const kept = keptReleases([
    'uefi-x64.20260916-0845', 'uefi-x64.20260915-2042', 'uefi-x64.20260914-1000', 'uefi-x64.20260913-0900',
    'cx3576.20260916-0847', 'mica.20260916-0858',
  ])
  expect(kept).toEqual(['cx3576.20260916-0847', 'uefi-x64.20260914-1000', 'uefi-x64.20260915-2042', 'uefi-x64.20260916-0845'])
})

test('the retired slash form is not a release tag any more', () => {
  expect(keptReleases(['x64/20260915-2230', 'mica/20260915-2242'])).toEqual([])
})

test('maps asset rows to readable product paths, with the release size', () => {
  const sizes = new Map([['mica-uefi-x64-dev-20260916-0845.img.gz', 82], ['mica-uefi-x64-dev-20260916-0845.kernel.micaupd', 16]])
  const objects = assetObjects('uefi-x64.20260916-0845', assetRows(lock), sizes, 'mica-build')
  expect(objects.map(object => object.kind)).toEqual(['product-image', 'update-archive'])
  expect(objects[0]?.readable).toEqual(['/d/mica/uefi-x64/20260916-0845/mica-uefi-x64-dev-20260916-0845.img.gz'])
  expect(objects[0]?.sha256).toBe('a'.repeat(64))
  expect(objects[1]?.size).toBe(16)
  expect(objects[0]?.pins[0]?.release).toBe('uefi-x64.20260916-0845')
})

test('refuses an asset row the release does not publish', () => {
  expect(() => assetObjects('uefi-x64.20260916-0845', assetRows(lock), new Map(), 'mica-build')).toThrow('asset-not-published')
})

test('refuses an asset row without a sha256', () => {
  expect(() => parseLock('# mica-lock v1\nasset\tx\timage\tdisk\tx.img.gz\tshort\n')).toThrow('field-value')
})
