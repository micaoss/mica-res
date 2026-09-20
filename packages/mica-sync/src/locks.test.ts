import { expect, test } from 'bun:test'
import { dataRows, parseLock, sourceRows, upstreamRows } from './locks.ts'

const header = '# mica-lock v1\n'
const debRow = 'source\tbash\tamd64\t5.3.3-1\t' + 'a'.repeat(64) + '\thttps://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/b/bash/bash_5.3.3-1_amd64.deb\n'

test('parses a source row', () => {
  const rows = sourceRows(parseLock(header + debRow))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual({
    name: 'bash',
    arch: 'amd64',
    version: '5.3.3-1',
    sha256: 'a'.repeat(64),
    url: 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/b/bash/bash_5.3.3-1_amd64.deb',
  })
})

test('skips comments and keeps other kinds out of sourceRows', () => {
  const lock = header + '# a comment\n' + debRow + 'git\tpodman\thttps://github.com/containers/podman.git\tv5.8.6\t' + 'b'.repeat(40) + '\n'
  expect(parseLock(lock).rows).toHaveLength(2)
  expect(sourceRows(parseLock(lock))).toHaveLength(1)
})

test('reads an upstream row with its package column', () => {
  const lock = header + 'upstream\tbluez\tarm64\t5.82-1.1\t' + 'c'.repeat(64) + '\thttps://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/b/bluez/bluez_5.82-1.1_arm64.deb\tbluez\n'
  const rows = upstreamRows(parseLock(lock))
  expect(rows[0]?.name).toBe('bluez')
  expect(rows[0]?.package).toBe('bluez')
})

test('refuses a lock without the header', () => {
  expect(() => parseLock(debRow)).toThrow('header')
})

test('refuses a row with the wrong column count', () => {
  expect(() => parseLock(header + 'source\tbash\tamd64\n')).toThrow('column-count')
})

test('refuses an unknown kind', () => {
  expect(() => parseLock(header + 'artefact\tbash\n')).toThrow('kind-unknown')
})

test('refuses a row whose sha256 is not lowercase hex', () => {
  const bad = debRow.replace('a'.repeat(64), 'A'.repeat(64))
  expect(() => parseLock(header + bad)).toThrow('field-value')
})

test('a data row is read, column-checked and digest-checked, and mirrors nothing', () => {
  const lock = parseLock(['# mica-lock v1', 'data\tunowned-paths\tunowned-paths.json\t' + 'a'.repeat(64)].join('\n'))
  expect(dataRows(lock)).toEqual([{ name: 'unowned-paths', file: 'unowned-paths.json', sha256: 'a'.repeat(64) }])
  expect(() => parseLock(['# mica-lock v1', 'data\tunowned-paths\tunowned-paths.json'].join('\n'))).toThrow('column-count')
  expect(() => parseLock(['# mica-lock v1', 'data\tunowned-paths\tunowned-paths.json\tNOTADIGEST'].join('\n'))).toThrow('field-value')
})
