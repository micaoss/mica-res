import { expect, test } from 'bun:test'
import { buildIndex } from './index-doc.ts'
import { renderSite } from './site.ts'

const document = buildIndex({
  version: '20260916-0728',
  objects: [{
    kind: 'deb',
    sha256: 'a'.repeat(64),
    size: 1048576,
    origin: 'https://snapshot.debian.org/archive/debian/x/pool/main/b/bash/bash_5.3.3-1_amd64.deb',
    path: `blob/aa/${'a'.repeat(64)}`,
    readable: ['/d/upstream/deb/bash/bash_5.3.3-1_amd64.deb'],
    pins: [{ repository: 'mica-system-base', lock: 'locks/upstream.lock', release: 'main', row: 'source bash amd64' }],
  }],
})

test('renders the two pages from the index', () => {
  const pages = renderSite(document)
  expect(pages.map(page => page.key)).toEqual(['site/index.html', 'site/upstream.html'])
  expect(pages[0]?.body).toContain('1 objects, 1.0 MiB')
  expect(pages[1]?.body).toContain('/d/upstream/deb/bash/bash_5.3.3-1_amd64.deb')
})

test('escapes what it renders', () => {
  const pages = renderSite(buildIndex({
    version: '20260916-0728',
    objects: [{ ...document.objects[0]!, origin: 'https://x/<script>' }],
  }))
  expect(pages[1]?.body).not.toContain('<script>')
})
