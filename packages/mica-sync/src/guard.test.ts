import { expect, test } from 'bun:test'
import { coverageOf } from './coverage.ts'
import { classify, guard, parseCandidate, verdict } from './guard.ts'
import type { ResourceObject } from './objects.ts'

const EMPTY = coverageOf([])

function blob(release: string): ResourceObject {
  return {
    kind: 'oci-blob',
    sha256: 'a'.repeat(64),
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
  const answer = verdict(parseCandidate('ghcr.io/micaoss/mica-core:something-else'), EMPTY)
  expect(answer.allowed).toBe(false)
  expect(answer.reason).toStartWith('tag-unknown')
})

test('a pool is refused while nothing mirrors it, and the refusal names its own exit condition', () => {
  const answer = verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), EMPTY)
  expect(answer.allowed).toBe(false)
  expect(answer.retiresWhen).toBe('the mirror holds ghcr bytes of micaoss/mica-core at 20260915-1135')
})

test('a build-env release the mirror holds is allowed, one it does not is refused', () => {
  const coverage = coverageOf([blob('20260916-0735')])
  expect(verdict(parseCandidate('micaoss/mica-build-env:base.20260916-0735'), coverage).allowed).toBe(true)
  expect(verdict(parseCandidate('micaoss/mica-build-env:base.20260101-0000'), coverage).allowed).toBe(false)
})

test('guard answers one verdict per candidate', () => {
  const candidates = ['micaoss/mica-core:pool.amd64.20260915-1135', 'micaoss/mica-system-base:rootfs.20260915-1102'].map(parseCandidate)
  expect(guard(candidates, EMPTY).filter(one => one.allowed)).toHaveLength(0)
})

function pooled(repository: string, release: string): ResourceObject {
  return {
    kind: 'deb',
    sha256: 'b'.repeat(64),
    origin: `https://ghcr.io/v2/micaoss/${repository}/blobs/sha256:b`,
    readable: [],
    pins: [{ repository, lock: `locks/${repository}.lock`, release, row: 'package micad amd64' }],
  }
}

test('the pool refusal retires when THIS release\'s pool bytes are mirrored', () => {
  const answer = verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), coverageOf([pooled('mica-core', '20260915-1135')]))
  expect(answer.allowed).toBe(true)
  expect(answer.reason).toContain('holds ghcr bytes of micaoss/mica-core at 20260915-1135')
})

// The hazard the coordinator could only state abstractly: a predicate that
// answers "something for this repository" or "some pool somewhere" retires a
// refusal the user never lifted.
test('another release, another repository, or a mirrored lock retires nothing', () => {
  const otherRelease = coverageOf([pooled('mica-core', '20260919-2226')])
  expect(verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), otherRelease).allowed).toBe(false)

  const otherRepository = coverageOf([pooled('mica-podman', '20260915-1135')])
  expect(verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), otherRepository).allowed).toBe(false)

  const lock: ResourceObject = {
    kind: 'lock',
    sha256: 'd'.repeat(64),
    origin: 'https://github.com/micaoss/mica-core/releases/download/20260915-1135/mica-core.lock',
    readable: ['mica/lock/mica-core/20260915-1135/mica-core.lock'],
    // Even with a row named like a package row -- the near miss itself -- a
    // GitHub release asset is not ghcr bytes of a pool.
    pins: [{ repository: 'mica-build', lock: 'locks/pins/mica-core.pin', release: '20260915-1135', row: 'package micad amd64' }],
  }
  expect(verdict(parseCandidate('micaoss/mica-core:pool.amd64.20260915-1135'), coverageOf([lock])).allowed).toBe(false)
})
