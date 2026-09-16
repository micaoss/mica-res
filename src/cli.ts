// mica-res CLI.
//
//   bun src/cli.ts sync [--sizes] [--out <dir>]   enumerate; write nothing
//   bun src/cli.ts index --check <file>           read an index snapshot
//
// `sync` is a dry run: phase 0 uploads nothing. The uploader arrives with
// phase 1, and writes only through the Worker's content-addressed endpoint.

import { mkdir } from 'node:fs/promises'
import { enumerate } from './enumerate.ts'
import { buildIndex, readIndex, renderIndex, renderPointer, summarise } from './index-doc.ts'
import { renderSite } from './site.ts'
import { resolveSizes } from './sizes.ts'

function stamp(now = new Date()): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

async function sync(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/sync'
  const { objects, gitTrees } = await enumerate()
  if (argv.includes('--sizes'))
    await resolveSizes(objects)

  const document = buildIndex({ version: stamp(), objects })
  const snapshot = renderIndex(document)
  readIndex(snapshot)

  await mkdir(out, { recursive: true })
  await Bun.write(`${out}/index-${document.version}.json`, snapshot)
  await Bun.write(`${out}/current.json`, renderPointer({ version: document.version, sha256: Bun.SHA256.hash(snapshot, 'hex') }))
  for (const page of renderSite(document))
    await Bun.write(`${out}/${page.key.replace('site/', '')}`, page.body)

  console.log(`dry run: ${objects.length} objects, nothing uploaded, snapshot written to ${out}`)
  for (const row of summarise(objects))
    console.log(`  ${row.kind.padEnd(14)} ${String(row.count).padStart(4)} objects  ${mib(row.bytes).padStart(10)}${row.sizesUnknown > 0 ? `  (${row.sizesUnknown} without a stated size)` : ''}`)
  console.log(`  ${'git-tree'.padEnd(14)} ${String(gitTrees.length).padStart(4)} trees    (phase 3, not packed yet)`)
}

async function index(argv: string[]): Promise<void> {
  const file = argv[argv.indexOf('--check') + 1]
  if (file === undefined)
    throw new Error('usage: index --check <file>')
  const document = readIndex(await Bun.file(file).text())
  console.log(`${file}: ${document.schema} ${document.version}, ${document.objects.length} objects`)
}

const [command, ...argv] = process.argv.slice(2)
switch (command) {
  case 'sync':
    await sync(argv)
    break
  case 'index':
    await index(argv)
    break
  default:
    console.error('usage: bun src/cli.ts sync [--sizes] [--out <dir>] | index --check <file>')
    process.exit(2)
}
