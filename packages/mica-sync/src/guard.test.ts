import { expect, test } from 'bun:test'
import { coverageOf } from './coverage.ts'
import { classify, guard, parseCandidate, verdict } from './guard.ts'
import type { ResourceObject } from './objects.ts'

const EMPTY = coverageOf([])

function blob(release: string): ResourceObject {
  return {
    kind: 'oci-blob',
    sha256: 'a'.repeat(64),
    path: 'blob/aa/a',
    origin: 'https://ghcr.io/v2/micaoss/mica-build-env/blobs/sha256:a',
    readable: [],
    pins: [{ repository: 'mica-build', lock: 'locks/mica-build-env.lock', release, row: 'image mica-build-env base amd64 ref' }],
  }
}

test('every published tag family is placed', () => {
  expect(classify('pool.amd64.20260915-1135')?.artefact).toBe('pool')
  expect(classify('pool.cx3576.arm64.20260916-0558')?.artefact).toBe('pool')
  expect(classify('rootfs.20260915-1102')?.artefact).toBe('rootfs')
  expect(classify('kernel.uefi-x64.20260916-0744')?.artefact).toBe('board-component')
  expect(classify('uboot.cx3576.20260916-0558')?.artefact).toBe('board-component')
  expect(classify('bsp.amd64.20260916-0735')?.artefact).toBe('build-env-image')
  expect(classify('update.cx3576-dev.20260916-1653')?.artefact).toBe('product-oci')
})

test('a tag family nobody recognises is refused, never allowed', () => {
  const answer = verdict(parseCandidate('ghcr.io/micaoss/mica-core:something-else'), EMPTY, new Set())
  expect(answer.allowed).toBe(false)
  expect(answer.reason).toStartWith('tag-unknown')
})

test('a pool is refused while no package or pool row exists, and the refusal names what ends it', () => {
  const answer = verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), EMPTY, new Set())
  expect(answer.allowed).toBe(false)
  expect(answer.retiresWhen).toContain('poolsCovered()')
})

test('a build-env release the mirror holds is allowed, one it does not is refused', () => {
  const coverage = coverageOf([blob('20260916-0735')])
  const releases = new Set(['20260916-0735'])
  expect(verdict(parseCandidate('micaoss/mica-build-env:base.20260916-0735'), coverage, releases).allowed).toBe(true)
  expect(verdict(parseCandidate('micaoss/mica-build-env:base.20260101-0000'), coverage, releases).allowed).toBe(false)
})

test('guard answers one verdict per candidate', () => {
  const candidates = ['micaoss/mica-core:pool.amd64.20260915-1135', 'micaoss/mica-system-base:rootfs.20260915-1102'].map(parseCandidate)
  expect(guard(candidates, EMPTY, new Set()).filter(one => one.allowed)).toHaveLength(0)
})

test('the pool refusal retires itself when a pool row appears', () => {
  const pooled: ResourceObject = {
    kind: 'deb',
    sha256: 'b'.repeat(64),
    path: 'blob/bb/b',
    origin: 'https://ghcr.io/v2/micaoss/mica-core/blobs/sha256:b',
    readable: [],
    pins: [{ repository: 'mica-core', lock: 'locks/mica-core.lock', release: '20260915-1135', row: 'package micad amd64' }],
  }
  const answer = verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), coverageOf([pooled]), new Set())
  expect(answer.allowed).toBe(true)
  expect(answer.reason).toContain('no longer the only copy')
})
