// The site is a rendering of the index, never a second source of truth.

import type { IndexDocument } from './index-doc.ts'
import { summarise } from './index-doc.ts'
import type { Kind } from './objects.ts'

const TITLES: Record<Kind, string> = {
  'deb': 'Debian archives',
  'source': 'source archives',
  'oci-blob': 'build-env image blobs',
  'product-image': 'product images',
  'update-archive': 'update archives',
  'git-pack': 'vendor git packs',
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function page(title: string, body: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(title)}</title>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function renderSite(document: IndexDocument): { key: string, body: string }[] {
  const rows = summarise(document.objects)
  const total = rows.reduce((sum, row) => sum + row.bytes, 0)
  const summary = [
    '<h1>Mica OS resources</h1>',
    `<p>Index <code>${escape(document.version)}</code>, ${document.objects.length} objects, ${mib(total)}.</p>`,
    '<p>Every object is stored once under its sha256 and is already pinned by that hash in the repository that consumes it. This host is a source, not a trust anchor: verify against your own lock.</p>',
    '<table><thead><tr><th>kind</th><th>objects</th><th>bytes</th></tr></thead><tbody>',
    ...rows.map(row => `<tr><td>${escape(TITLES[row.kind])}</td><td>${row.count}</td><td>${mib(row.bytes)}</td></tr>`),
    '</tbody></table>',
    '<p><a href="/upstream">Third-party inputs</a> &middot; <a href="/index/current.json">index/current.json</a></p>',
  ].join('\n')

  const upstream = [
    '<h1>Third-party inputs</h1>',
    '<p>Mirrored because a build needs them offline. Each row keeps its upstream origin; the bytes are identical.</p>',
    '<table><thead><tr><th>file</th><th>kind</th><th>bytes</th><th>origin</th></tr></thead><tbody>',
    ...document.objects
      .filter(object => object.kind === 'deb' || object.kind === 'source')
      .map(object => `<tr><td><a href="${escape(object.readable[0]!)}">${escape(object.readable[0]!.split('/').pop()!)}</a></td><td>${escape(object.kind)}</td><td>${object.size ?? ''}</td><td>${escape(object.origin ?? '')}</td></tr>`),
    '</tbody></table>',
    '<p><a href="/">Back</a></p>',
  ].join('\n')

  return [
    { key: 'site/index.html', body: page('Mica OS resources', summary) },
    { key: 'site/upstream.html', body: page('Third-party inputs - Mica OS resources', upstream) },
  ]
}
