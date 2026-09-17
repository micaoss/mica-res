import { expect, test } from 'bun:test'
import { buildEnvRelease, releaseCommit } from './imagepins.ts'
import { parseLock } from './locks.ts'

const withImages = parseLock([
  '# mica-lock v1',
  'release\tmica-build-env\t20260915-0138\t' + 'a'.repeat(40),
  'image\tmica-build-env\tbase\tamd64\tghcr.io/micaoss/mica-build-env@sha256:' + 'b'.repeat(64),
  'image\tmica-build-env\tbase\tindex\tghcr.io/micaoss/mica-build-env:base.20260915-0138@sha256:' + 'c'.repeat(64),
  'image\tupstream\talpine:3.24.1\tamd64\tdocker.io/library/alpine:3.24.1@sha256:' + 'd'.repeat(64),
  '',
].join('\n'))

const withoutImages = parseLock([
  '# mica-lock v1',
  'release\tmica-core\t20260915-1135\t' + 'e'.repeat(40),
  'package\tmicad\tamd64\t0.1.0-1\t' + 'f'.repeat(64),
  '',
].join('\n'))

test('reads the build-env release from the tag of an index row', () => {
  expect(buildEnvRelease(withImages)).toBe('20260915-0138')
})

test('a lock with no build-env image row names no release', () => {
  expect(buildEnvRelease(withoutImages)).toBeUndefined()
})

test('reads the commit a release was cut from', () => {
  expect(releaseCommit(withoutImages)).toBe('e'.repeat(40))
  expect(releaseCommit(withImages)).toBe('a'.repeat(40))
})

test('ignores an upstream image row when looking for the build-env release', () => {
  const onlyUpstream = parseLock([
    '# mica-lock v1',
    'release\tmica-podman\t20260916-0846\t' + 'a'.repeat(40),
    'image\tupstream\tdebian:trixie-slim\tamd64\tdocker.io/library/debian:trixie-slim@sha256:' + 'b'.repeat(64),
    '',
  ].join('\n'))
  expect(buildEnvRelease(onlyUpstream)).toBeUndefined()
})
