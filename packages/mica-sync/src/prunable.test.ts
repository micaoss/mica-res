import { expect, test } from 'bun:test'
import { namesOf, prunableReport } from './prunable.ts'
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
