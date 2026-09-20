import { expect, test } from 'bun:test'
import { coverageOf, lockCoverage, poolsCovered } from './coverage.ts'
import type { ResourceObject } from './objects.ts'

function object(origin: string, row: string): ResourceObject {
  return {
    kind: 'oci-blob',
    sha256: 'a'.repeat(64),
    origin,
    readable: [],
    pins: [{ repository: 'mica-build', lock: 'locks/upstream.lock', release: 'main', row }],
  }
}

test('the registry count names the ghcr packages the mirror holds bytes of', () => {
  const coverage = coverageOf([
    object('https://ghcr.io/v2/micaoss/mica-build-env/blobs/sha256:a', 'image mica-build-env base amd64 ref'),
    object('https://snapshot.debian.org/archive/debian/x/y.deb', 'source libc-bin amd64'),
  ])
  expect([...coverage.registry]).toEqual([['micaoss/mica-build-env', 1]])
  expect(coverage.origins.get('snapshot.debian.org')).toBe(1)
})

test('pools are covered only when a package or pool row names them', () => {
  const coverage = coverageOf([object('https://ghcr.io/v2/micaoss/mica-build-env/blobs/sha256:a', 'image x y z ref')])
  expect(poolsCovered(coverage)).toBe(false)
  expect(poolsCovered(coverageOf([object('https://ghcr.io/v2/micaoss/mica-core/blobs/sha256:a', 'package micad amd64')]))).toBe(true)
})

test('locks are counted per release, and counting them says nothing about the pools', () => {
  const lock: ResourceObject = {
    kind: 'lock',
    sha256: 'c'.repeat(64),
    origin: 'https://github.com/micaoss/mica-core/releases/download/20260915-1135/mica-core.lock',
    readable: ['mica/lock/mica-core/20260915-1135/mica-core.lock'],
    pins: [{ repository: 'mica-build', lock: 'locks/pins/mica-core.pin', release: '20260915-1135', row: 'lock mica-core 20260915-1135 mica-core.lock' }],
  }
  const answer = lockCoverage([lock])
  expect(answer.objects).toBe(1)
  expect([...answer.releases]).toEqual(['mica-core/20260915-1135'])
  expect(poolsCovered(coverageOf([lock]))).toBe(false)
})
