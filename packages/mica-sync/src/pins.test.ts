import { expect, test } from 'bun:test'
import { coverageOf, poolsCovered } from './coverage.ts'
import { lockObjects, parsePin, sumsDigest, tagOf } from './pins.ts'

const PIN = `# mica-pin v1
REPOSITORY=mica-build-env
RELEASE=20260916-0735
SHA256SUMS=7df0af68761a63c6517b37a739a57ce947da53fbe558aba2646368e53724bf0a
`

const SCOPED = `# mica-pin v1
REPOSITORY=mica-boards
SCOPE=cx3576
RELEASE=20260917-1007
SHA256SUMS=cb87db65aae6049142b84b62f037b1e210dc3f80e9d0b07ebcfde65bc2ece7a6
`

test('a pin is read as the consumer writes it, scope optional', () => {
  expect(parsePin(PIN)).toEqual({
    repository: 'mica-build-env',
    release: '20260916-0735',
    sha256sums: '7df0af68761a63c6517b37a739a57ce947da53fbe558aba2646368e53724bf0a',
  })
  expect(tagOf(parsePin(SCOPED))).toBe('cx3576.20260917-1007')
  expect(tagOf(parsePin(PIN))).toBe('20260916-0735')
})

test('a pin missing a field or carrying a bad value is refused', () => {
  expect(() => parsePin('REPOSITORY=x\n')).toThrow('header')
  expect(() => parsePin('# mica-pin v1\nREPOSITORY=x\n')).toThrow('field-missing')
  expect(() => parsePin(PIN.replace('20260916-0735', 'latest'))).toThrow('field-value')
})

test('the lock digest comes from SHA256SUMS, which the pin names', () => {
  const sums = `${'a'.repeat(64)}  mica-build-env.lock\n`
  const digest = Bun.SHA256.hash(sums, 'hex')
  const pin = { repository: 'mica-build-env', release: '20260916-0735', sha256sums: digest }
  const objects = lockObjects({ repository: 'mica-podman', pin: 'locks/pins/mica-build-env.pin' }, pin, sums)
  expect(objects.map(one => one.readable[0])).toEqual([
    'mica/lock/mica-build-env/20260916-0735/SHA256SUMS',
    'mica/lock/mica-build-env/20260916-0735/mica-build-env.lock',
  ])
  expect(objects[1]!.sha256).toBe('a'.repeat(64))
  expect(objects.every(one => one.kind === 'lock')).toBe(true)
})

test('bytes that disagree with the pin are refused, never mirrored', () => {
  const pin = { repository: 'mica-build-env', release: '20260916-0735', sha256sums: 'b'.repeat(64) }
  expect(() => lockObjects({ repository: 'mica-podman', pin: 'locks/pins/mica-build-env.pin' }, pin, 'anything\n'))
    .toThrow('pin-digest')
})

test('a SHA256SUMS that does not list the lock is refused', () => {
  expect(() => sumsDigest(`${'a'.repeat(64)}  something-else\n`, 'mica-core.lock')).toThrow('sums-entry')
})

// The guard's pool refusals must not retire because locks arrived: a `lock`
// row is not a `package` row, and the user amended the scope for locks only.
test('mirroring locks does not make the pools covered', () => {
  const sums = `${'a'.repeat(64)}  mica-core.lock\n`
  const pin = { repository: 'mica-core', release: '20260915-1135', sha256sums: Bun.SHA256.hash(sums, 'hex') }
  const objects = lockObjects({ repository: 'mica-build', pin: 'locks/pins/mica-core.pin' }, pin, sums)
  expect(poolsCovered(coverageOf(objects))).toBe(false)
})
