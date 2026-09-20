import { expect, test } from 'bun:test'
import { namesOf, prunableReport, releaseId } from './prunable.ts'
import { parseLock } from './locks.ts'

const index = parseLock([
  '# mica-lock v1',
  'release\tmica-build\tmica.20260919-2115\t' + 'a'.repeat(40),
  'input\tmica-build.cx3576\t20260919-2103\t' + 'b'.repeat(64),
  'built\tmica-build.cx3576\tmica-boards.cx3576\t20260917-1007\t' + 'c'.repeat(64),
  'built\tmica-build.cx3576\tmica-build-env\t20260916-0735\t' + 'd'.repeat(64),
  '',
].join('\n'))

test('a lock names the releases its input and built rows carry', () => {
  expect(namesOf(index).toSorted()).toEqual([
    'mica-boards.cx3576/20260917-1007',
    'mica-build-env/20260916-0735',
    'mica-build.cx3576/20260919-2103',
  ])
})

test('an image row names the build-env release in its tag', () => {
  const lock = parseLock([
    '# mica-lock v1',
    'release\tmica-core\t20260916-0916\t' + 'a'.repeat(40),
    'image\tmica-build-env\tbase\tindex\tghcr.io/micaoss/mica-build-env:base.20260915-0138@sha256:' + 'e'.repeat(64),
    '',
  ].join('\n'))
  expect(namesOf(lock)).toEqual(['mica-build-env/20260915-0138'])
})

test('the three lists are exactly the partition, and a release never names itself', () => {
  const report = prunableReport(
    [
      { id: 'mica-build.cx3576/20260919-2103', repository: 'mica-build', tag: 'cx3576.20260919-2103', names: [] },
      { id: 'mica-build/mica.20260919-2115', repository: 'mica-build', tag: 'mica.20260919-2115', names: ['mica-build.cx3576/20260919-2103'] },
      { id: 'mica-core/20260915-1135', repository: 'mica-core', tag: '20260915-1135', names: [] },
    ],
    new Set(['mica-build.cx3576/20260919-2103']),
  )
  expect(report.named.map(one => `${one.id} x${one.by.length}`)).toEqual(['mica-build.cx3576/20260919-2103 x1'])
  expect(report.prunableMirrored.map(one => one.id)).toEqual([])
  expect(report.prunableUnmirrored.map(one => one.id).toSorted()).toEqual(['mica-build/mica.20260919-2115', 'mica-core/20260915-1135'])
})

test('both tag separators normalise to the form a lock row spells', () => {
  // The row says `mica-build.cx3576` plus a stamp field; the tag says either
  // `cx3576.20260919-2103` or, before the rename, `cx3576/20260915-2230`.
  expect(releaseId('mica-build', 'cx3576.20260919-2103')).toBe('mica-build.cx3576/20260919-2103')
  expect(releaseId('mica-build', 'cx3576/20260915-2230')).toBe('mica-build.cx3576/20260915-2230')
  expect(releaseId('mica-build', 'mica/20260915-2242')).toBe('mica-build.mica/20260915-2242')
  expect(releaseId('mica-core', '20260915-1135')).toBe('mica-core/20260915-1135')
  expect(releaseId('mica-boards', 'uefi-x64.20260916-0857')).toBe('mica-boards.uefi-x64/20260916-0857')
})

test('a tag that is not a release tag is refused rather than keyed wrongly', () => {
  expect(() => releaseId('mica-build', 'nightly')).toThrow('field-value')
})

test('the slash-form release a slash-form index names joins after normalisation', () => {
  const index = parseLock([
    '# mica-lock v1',
    'release\tmica-build\tmica/20260915-2242\t' + 'a'.repeat(40),
    'input\tmica-build.cx3576\t20260915-2230\t' + 'b'.repeat(64),
    '',
  ].join('\n'))
  const nodes = [
    { id: releaseId('mica-build', 'cx3576/20260915-2230'), repository: 'mica-build', tag: 'cx3576/20260915-2230', names: [] },
    { id: releaseId('mica-build', 'mica/20260915-2242'), repository: 'mica-build', tag: 'mica/20260915-2242', names: namesOf(index) },
  ]
  const report = prunableReport(nodes, new Set())
  expect(report.named.map(one => one.id)).toEqual(['mica-build.cx3576/20260915-2230'])
})

test('a built row and an image reference key the same way as an input row', () => {
  // The three places a release identity is read from must agree, or a join
  // finds nothing for whichever one spells it differently.
  const lock = parseLock([
    '# mica-lock v1',
    'release\tmica-build\tmica.20260920-0046\t' + 'a'.repeat(40),
    'input\tmica-build.cx3576\t20260919-2356\t' + 'b'.repeat(64),
    'built\tmica-build.cx3576\tmica-boards.cx3576\t20260917-1007\t' + 'c'.repeat(64),
    'built\tmica-build.cx3576\tmica-core\t20260919-2226\t' + 'd'.repeat(64),
    'image\tmica-build-env\tbase\tindex\tghcr.io/micaoss/mica-build-env:base.20260916-0735@sha256:' + 'e'.repeat(64),
    '',
  ].join('\n'))
  expect(namesOf(lock).toSorted()).toEqual([
    'mica-boards.cx3576/20260917-1007',
    'mica-build-env/20260916-0735',
    'mica-build.cx3576/20260919-2356',
    'mica-core/20260919-2226',
  ])
  // Each of those is exactly what `releaseId` produces for the release itself.
  expect(namesOf(lock)).toContain(releaseId('mica-boards', 'cx3576.20260917-1007'))
  expect(namesOf(lock)).toContain(releaseId('mica-core', '20260919-2226'))
  expect(namesOf(lock)).toContain(releaseId('mica-build-env', '20260916-0735'))
  expect(namesOf(lock)).toContain(releaseId('mica-build', 'cx3576.20260919-2356'))
})
