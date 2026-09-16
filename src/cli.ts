// mica-res CLI.
//
//   bun src/cli.ts sync [--sizes] [--out <dir>]   enumerate; write nothing
//   bun src/cli.ts sync --apply [--kinds deb,source] [--limit <n>]
//   bun src/cli.ts site [--index <file>] [--out <dir>]
//   bun src/cli.ts collect [--apply] [--out <dir>]
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
import { concluded, listJobs, listRuns, renderCurrent, renderRun, runKey, runSnapshot } from './collect.ts'
import type { CurrentRun } from './collect.ts'
import { REPOSITORIES } from './producers.ts'
import { ghcrToken } from './ghcr.ts'
import { ensureBlob, pullBlob, putNamed, resolveRedirect, resolveState } from './upload.ts'
import type { Target } from './upload.ts'

const DEFAULT_BASE = 'https://res.micaos.dev'

// Phase 1 mirrors the third-party bytes; the later phases widen this.
const DEFAULT_KINDS: Kind[] = ['deb', 'source']

// Cloudflare refuses a request body past its plan's limit at the edge, before
// the Worker runs: a 129.3 MB archive came back 413 Payload Too Large. Objects
// above this stay `pending` and are reported, until the write endpoint offers a
// multipart route.
const MAX_SINGLE_SHOT = 95 * 1024 * 1024

function target(variable = 'MICA_RES_WRITE_TOKEN'): Target {
  const token = process.env[variable]
  if (token === undefined || token === '')
    throw new Error(`${variable} is not set; --apply writes through the Worker and needs its bearer`)
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
    // The build-env blobs live in a registry that wants a token. It is a public
    // anonymous token, and it never leaves this process: for an object small
    // enough to upload in one request the client reads it with the token, and
    // for a larger one the client resolves the registry's redirect and hands
    // the Worker the resolved URL.
    const registryHeaders = wanted.some(object => object.kind === 'oci-blob')
      ? { authorization: `Bearer ${await ghcrToken('mica-build-env')}`, accept: 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json,*/*' }
      : {}

    let pulled = 0
    for (const object of wanted) {
      const big = object.size !== undefined && object.size > MAX_SINGLE_SHOT
      const headers = object.kind === 'oci-blob' ? registryHeaders : {}
      let outcome: Awaited<ReturnType<typeof ensureBlob>>
      if (!big) {
        outcome = await ensureBlob(object, to, fetch, headers)
      }
      else {
        // Only a large object needs the redirect resolved, since only those go
        // through the Worker's pull route.
        const origin = object.kind === 'oci-blob' && object.origin !== undefined
          ? await resolveRedirect(object.origin, headers)
          : object.origin
        outcome = await pullBlob(origin === undefined ? object : { ...object, origin }, to)
      }
      if (big && outcome !== 'exists-identical')
        pulled += 1
      if (outcome === 'stored')
        stored += 1
      else
        present += 1
      if ((stored + present) % 25 === 0)
        console.log(`  ${stored + present}/${wanted.length} (${stored} written, ${present} already held)`)
    }
    console.log(`apply: ${stored} written (${pulled} of them streamed by the Worker from their origin), ${present} already held, 0 deleted`)
  }

  // What the bucket holds, read back from it, whatever this run uploaded.
  await resolveState(objects, process.env['MICA_RES_BASE'] ?? DEFAULT_BASE)

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

// Snapshots every run that has concluded and is not already held. A run in
// flight is listed in the pointer but never written immutably, so the snapshot
// of a run is written exactly once, when it is final.
async function collect(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/status'
  const apply = argv.includes('--apply')
  const to = apply ? target('MICA_RES_STATUS_TOKEN') : undefined

  await mkdir(`${out}/runs`, { recursive: true })
  const repositories: { repository: string, runs: CurrentRun[] }[] = []
  let written = 0
  let held = 0
  let inFlight = 0

  for (const repository of REPOSITORIES) {
    const runs = await listRuns(repository)
    const summaries: CurrentRun[] = []
    for (const run of runs) {
      summaries.push({
        id: run.id,
        workflow: run.path.replace('.github/workflows/', ''),
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        head_sha: run.head_sha,
        startedAt: run.run_started_at,
        completedAt: concluded(run) ? run.updated_at : null,
      })
      if (!concluded(run)) {
        inFlight += 1
        continue
      }

      const key = runKey(repository, run.id)
      if (to !== undefined) {
        const head = await fetch(`${to.base}/${key}`, { method: 'HEAD' })
        if (head.ok) {
          held += 1
          continue
        }
      }
      const text = renderRun(runSnapshot(repository, run, await listJobs(repository, run.id)))
      await Bun.write(`${out}/runs/${repository}-${run.id}.json`, text)
      if (to !== undefined)
        await putNamed(key, text, to)
      written += 1
    }
    repositories.push({ repository, runs: summaries })
    console.log(`  ${repository.padEnd(18)} ${String(runs.length).padStart(3)} runs`)
  }

  const current = renderCurrent({ generatedAt: new Date().toISOString(), repositories })
  await Bun.write(`${out}/current.json`, current)
  if (to !== undefined)
    console.log(`status/current.json: ${await putNamed('status/current.json', current, to)}`)

  console.log(`collect: ${written} snapshots ${to === undefined ? 'rendered' : 'written'}, ${held} already held, ${inFlight} in flight, 0 deleted`)
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
  case 'collect':
    await collect(argv)
    break
  case 'site':
    await site(argv)
    break
  case 'index':
    await index(argv)
    break
  default:
    console.error('usage: bun src/cli.ts sync [--sizes] [--apply] [--kinds <k,k>] [--limit <n>] [--out <dir>] | collect [--apply] [--out <dir>] | site [--index <file>] [--out <dir>] | index --check <file>')
    process.exit(2)
}
