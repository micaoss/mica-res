// mica-res CLI.
//
//   bun src/cli.ts sync [--sizes] [--out <dir>]   enumerate; write nothing
//   bun src/cli.ts sync --apply [--kinds deb,source] [--limit <n>]
//   bun src/cli.ts site [--index <file>] [--out <dir>]
//   bun src/cli.ts index --check <file>           read an index snapshot
//
// `sync` is a dry run unless `--apply` is given. Uploads go only through the
// Worker's content-addressed endpoint, which hashes every body and refuses a
// key that is not its digest; the index, the pointer and the site pages go
// through the named write routes. Nothing here deletes anything.

import { mkdir } from 'node:fs/promises'
import { enumerate } from './enumerate.ts'
import { buildIndex, readIndex, renderIndex, renderPointer, summarise } from './index-doc.ts'
import type { Kind } from './objects.ts'
import { renderSite } from './site.ts'
import { resolveSizes } from './sizes.ts'
import { ensureBlob, putNamed } from './upload.ts'
import type { Target } from './upload.ts'

const DEFAULT_BASE = 'https://res.micaos.dev'

// Phase 1 mirrors the third-party bytes; the later phases widen this.
const DEFAULT_KINDS: Kind[] = ['deb', 'source']

function target(): Target {
  const token = process.env['MICA_RES_WRITE_TOKEN']
  if (token === undefined || token === '')
    throw new Error('MICA_RES_WRITE_TOKEN is not set; --apply writes through the Worker and needs its bearer')
  return { base: process.env['MICA_RES_BASE'] ?? DEFAULT_BASE, token }
}

function stamp(now = new Date()): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

async function sync(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/sync'
  const apply = argv.includes('--apply')
  const kinds = (argv.includes('--kinds') ? argv[argv.indexOf('--kinds') + 1]!.split(',') : DEFAULT_KINDS) as Kind[]
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity
  const { objects, gitTrees } = await enumerate()
  if (argv.includes('--sizes') || apply)
    await resolveSizes(objects)

  if (apply) {
    const to = target()
    const wanted = objects.filter(object => kinds.includes(object.kind)).slice(0, limit)
    console.log(`apply: ${wanted.length} objects of kind ${kinds.join(', ')} to ${to.base}`)
    let stored = 0
    let present = 0
    for (const object of wanted) {
      const outcome = await ensureBlob(object, to)
      object.state = 'mirrored'
      if (outcome === 'present')
        present += 1
      else
        stored += 1
      if ((stored + present) % 25 === 0)
        console.log(`  ${stored + present}/${wanted.length} (${stored} written, ${present} already held)`)
    }
    console.log(`apply: ${stored} written, ${present} already held, 0 deleted`)
  }

  const document = buildIndex({ version: stamp(), objects })
  const snapshot = renderIndex(document)
  readIndex(snapshot)

  await mkdir(out, { recursive: true })
  await Bun.write(`${out}/index-${document.version}.json`, snapshot)
  await Bun.write(`${out}/current.json`, renderPointer({ version: document.version, sha256: Bun.SHA256.hash(snapshot, 'hex') }))
  for (const page of renderSite(document))
    await Bun.write(`${out}/${page.key.replace('site/', '')}`, page.body)

  if (apply) {
    const to = target()
    const pointer = renderPointer({ version: document.version, sha256: Bun.SHA256.hash(snapshot, 'hex') })
    console.log(`index/${document.version}.json: ${await putNamed(`index/${document.version}.json`, snapshot, to)}`)
    console.log(`index/current.json: ${await putNamed('index/current.json', pointer, to)}`)
    for (const page of renderSite(document))
      console.log(`${page.key}: ${await putNamed(page.key, page.body, to)}`)
  }

  console.log(`${apply ? 'applied' : 'dry run'}: ${objects.length} objects pinned, snapshot written to ${out}`)
  for (const row of summarise(objects))
    console.log(`  ${row.kind.padEnd(14)} ${String(row.mirrored).padStart(4)}/${String(row.count).padEnd(4)} mirrored  ${mib(row.mirroredBytes).padStart(10)} of ${mib(row.bytes).padStart(10)}${row.sizesUnknown > 0 ? `  (${row.sizesUnknown} without a stated size)` : ''}`)
  console.log(`  ${'git-tree'.padEnd(14)} ${String(gitTrees.length).padStart(4)} trees    (phase 3, not packed yet)`)
}

// The pages are a rendering of an index snapshot. With no snapshot -- before
// the first upload -- they render an empty bucket rather than a promise.
async function site(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/site'
  const file = argv.includes('--index') ? argv[argv.indexOf('--index') + 1]! : undefined
  const document = file === undefined
    ? buildIndex({ version: stamp(), objects: [] })
    : readIndex(await Bun.file(file).text())

  await mkdir(out, { recursive: true })
  for (const page of renderSite(document))
    await Bun.write(`${out}/${page.key.replace('site/', '')}`, page.body)
  console.log(`site: ${document.objects.length} objects rendered into ${out}`)
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
  case 'site':
    await site(argv)
    break
  case 'index':
    await index(argv)
    break
  default:
    console.error('usage: bun src/cli.ts sync [--sizes] [--out <dir>] | site [--index <file>] [--out <dir>] | index --check <file>')
    process.exit(2)
}
