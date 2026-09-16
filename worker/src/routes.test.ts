import { expect, test } from 'bun:test'
import { cacheControl, route, writeDecision } from './routes.ts'

const digest = 'a'.repeat(64)

test('routes a blob by its digest', () => {
  expect(route(`/blob/aa/${digest}`)).toEqual({ kind: 'blob', key: `blob/aa/${digest}` })
})

test('refuses a blob path whose prefix is not the digest prefix', () => {
  expect(route(`/blob/bb/${digest}`)).toEqual({ kind: 'not-found' })
})

test('refuses a blob path that is not a sha256', () => {
  expect(route('/blob/aa/nothex')).toEqual({ kind: 'not-found' })
})

test('routes the index pointer and its snapshots', () => {
  expect(route('/index/current.json')).toEqual({ kind: 'index', key: 'index/current.json', immutable: false })
  expect(route('/index/20260916-0728.json')).toEqual({ kind: 'index', key: 'index/20260916-0728.json', immutable: true })
})

test('routes a readable download to the index lookup', () => {
  expect(route('/d/upstream/deb/bash/bash_5.3.3-1_amd64.deb')).toEqual({ kind: 'download', readable: '/d/upstream/deb/bash/bash_5.3.3-1_amd64.deb' })
})

test('routes the write endpoint by digest and nothing else', () => {
  expect(route(`/w/blob/${digest}`)).toEqual({ kind: 'write', key: `blob/aa/${digest}`, digest })
  expect(route('/w/blob/nothex')).toEqual({ kind: 'not-found' })
  expect(route('/w/anything')).toEqual({ kind: 'not-found' })
})

test('routes the site', () => {
  expect(route('/')).toEqual({ kind: 'site', key: 'site/index.html' })
  expect(route('/upstream')).toEqual({ kind: 'site', key: 'site/upstream.html' })
})

test('a write is refused when the key is not the body digest', () => {
  expect(writeDecision({ digest, bodyDigest: 'b'.repeat(64), existing: null })).toEqual({ status: 400, reason: 'key-not-digest' })
})

test('a write of identical bytes over an existing object is a no-op', () => {
  expect(writeDecision({ digest, bodyDigest: digest, existing: digest })).toEqual({ status: 200, reason: 'exists-identical' })
})

test('a write of different bytes under an existing key is refused', () => {
  expect(writeDecision({ digest, bodyDigest: digest, existing: 'c'.repeat(64) })).toEqual({ status: 409, reason: 'exists-different' })
})

test('a first write is stored', () => {
  expect(writeDecision({ digest, bodyDigest: digest, existing: null })).toEqual({ status: 200, reason: 'stored' })
})

test('immutable content is cached forever and the pointer is revalidated', () => {
  expect(cacheControl({ kind: 'blob', key: 'x' })).toBe('public, max-age=31536000, immutable')
  expect(cacheControl({ kind: 'index', key: 'index/current.json', immutable: false })).toBe('public, max-age=60, must-revalidate')
  expect(cacheControl({ kind: 'index', key: 'index/20260916-0728.json', immutable: true })).toBe('public, max-age=31536000, immutable')
  expect(cacheControl({ kind: 'site', key: 'site/index.html' })).toBe('public, max-age=300')
})
