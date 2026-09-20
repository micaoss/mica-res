// mica-res mirror CLI.
//
//   bun src/cli.ts sync [--sizes] [--out <dir>]   enumerate; write nothing
//   bun src/cli.ts sync --apply [--kinds deb,source] [--limit <n>]
//   bun src/cli.ts collect [--apply] [--out <dir>]
//   bun src/cli.ts verify-pack [--name <tree>]    walk the consumer contract
//   bun src/cli.ts audit                          the published invariant check
//   bun src/cli.ts reconcile                      the catalog against the locks
//   bun src/cli.ts backfill --dir <tree>          republish artifact snapshots
//   bun src/cli.ts mirrors                        the index mirror URLs, by digest
//   bun src/cli.ts history                        is the run history in the
//                                                 bucket, and is it unbroken?
//   bun src/cli.ts prunable                       three lists: named, prunable
//                                                 and mirrored, prunable and not
//   bun src/cli.ts packs [--repair]               every declared chunk under
//                                                 its own manifest's name
//   bun src/cli.ts image-pins                     which build-env releases a
//                                                 published release still names
//   bun src/cli.ts index --check <file>           read an index snapshot
//
// `sync` is a dry run unless `--apply` is given. Publishing goes through the
// resource service's control plane with a `res:publish` API token
// (MICA_RES_TOKEN): bytes are pulled server-side from their origin or put to a
// presigned R2 URL, with R2 enforcing every sha256, and nothing here can delete.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumerate } from './enumerate.ts'
import { buildIndex, readIndex, renderIndex, renderPointer, summarise } from './index-doc.ts'
import type { IndexDocument } from './index-doc.ts'
import { mergeObjects } from './objects.ts'
import type { Kind, ResourceObject } from './objects.ts'
import { resolveSizes } from './sizes.ts'
import { apply as announce, decide, openIssue } from './announce.ts'
import { concluded, listJobs, listRuns, renderCurrent, renderRun, runKey, runSnapshot } from './collect.ts'
import { firstFailingJob, healthOf, redRepositories } from './health.ts'
import type { Health } from './health.ts'
import type { CurrentRun } from './collect.ts'
import { checkBytes, checkListing, walkNamespace } from './audit.ts'
import type { ListedObject, SiteNamespace } from './audit.ts'
import { pinnedImageReleases } from './imagepins.ts'
import { REPOSITORIES } from './producers.ts'
import { ghcrToken, resolveRedirect } from './ghcr.ts'
import { parseSnapshotFile, windowOf } from './backfill.ts'
import { fetchJson, fetchText, githubHeaders } from './fetch.ts'
import { checkMirrors, mirrorEntries } from './mirrors.ts'
import { manifestKey, missingChunks } from './packs.ts'
import { parseLock } from './locks.ts'
import { classifyGaps, missingSnapshots, spanOf } from './history.ts'
import type { ApiRunLite, Gap } from './history.ts'
import { indexCoverage, namesOf, prunableReport, releaseId } from './prunable.ts'
import type { ReleaseNode } from './prunable.ts'
import type { PackManifest } from './packs.ts'
import { carriedOrigin } from './carry.ts'
import { derivedPrefixes, reconcile, summary } from './reconcile.ts'
import { chunkBytes, chunkNames, manifestName, packObjects, producePack, renderManifest, verifyPack } from './gitpack.ts'
import type { GitTree } from './enumerate.ts'
import { canonicalKey, listHeld, objectMeta, publishBatch, publisherFromEnv, registryTags, setTag, splitKey, stageBytes, stagePull } from './publish.ts'
import type { HeldObject, Publisher, PublishItem } from './publish.ts'

const DEFAULT_BASE = 'https://res.micaos.dev'

// Phase 1 mirrors the third-party bytes; the later phases widen this.
const DEFAULT_KINDS: Kind[] = ['deb', 'source']

function stamp(now = new Date()): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

// A tree already mirrored is recognised by its manifest, which names the pack
// and its ordered chunks, so a second run fetches no git history at all. The
// lookup runs in a dry run too, so the index and the site state what the bucket
// holds rather than only what an apply touched.
async function heldTree(tree: GitTree, base: string): Promise<ResourceObject[] | undefined> {
  const held = await fetch(`${base}/${manifestName(tree)}`)
  if (!held.ok)
    return undefined
  const manifest = await held.json() as { pack: { sha256: string, size: number }, chunks: { sha256: string, size: number }[] }
  return packObjects(tree, manifest.pack, manifest.chunks, renderManifest(tree, manifest.pack, manifest.chunks))
}

async function mirrorTree(tree: GitTree, publisher: Publisher): Promise<{ objects: ResourceObject[], produced: boolean }> {
  const held = await heldTree(tree, process.env['MICA_RES_BASE'] ?? DEFAULT_BASE)
  if (held !== undefined)
    return { objects: held, produced: false }

  const pack = await producePack(tree)
  const pieces = chunkBytes(pack)
  const chunks = pieces.map(piece => ({ sha256: Bun.SHA256.hash(piece, 'hex'), size: piece.length }))
  const names = chunkNames(tree, chunks.length)
  const items: PublishItem[] = []
  for (const [index, piece] of pieces.entries())
    items.push({ path: splitKey(names[index]!).path, source: { uploadId: await stageBytes(publisher, 'upstream', piece, 'application/octet-stream') } })

  const whole = { sha256: Bun.SHA256.hash(pack, 'hex'), size: pack.length }
  const manifest = renderManifest(tree, whole, chunks)
  // The manifest last, in its own batch: a consumer that finds the manifest
  // finds every chunk it names.
  await publishBatch(publisher, 'upstream', items)
  const manifestId = await stageBytes(publisher, 'upstream', new TextEncoder().encode(manifest), 'application/json')
  await publishBatch(publisher, 'upstream', [{ path: splitKey(manifestName(tree)).path, source: { uploadId: manifestId }, contentType: 'application/json' }])
  console.log(`  ${tree.name}: ${(pack.length / 1048576).toFixed(1)} MiB in ${chunks.length} chunk(s) at ${names[0]}`)
  return { objects: packObjects(tree, whole, chunks, manifest), produced: true }
}

// Held objects by canonical key, one listing per namespace.
async function heldByKey(publisher: Publisher, namespaces: Iterable<string>): Promise<Map<string, HeldObject>> {
  const held = new Map<string, HeldObject>()
  for (const namespace of new Set(namespaces)) {
    for (const [path, object] of await listHeld(publisher, namespace))
      held.set(`${namespace}/${path}`, object)
  }
  return held
}

// Stage one object's bytes: pulled server-side from an https origin, or, for a
// registry manifest that needs a token to read, read here and put to R2.
// Counted so the report can say how much of a restoration was carried rather
// than re-fetched.
const carried = { fromBucket: 0, fromUpstream: 0 }

async function stage(publisher: Publisher, object: ResourceObject, namespace: string, registryHeaders: Record<string, string>): Promise<string> {
  const contentType = object.mediaType ?? 'application/octet-stream'

  // The v1 mirror's bytes are still in this bucket under `blob/<aa>/<sha256>`.
  // Where one is, it is the same bytes by definition of the key, so the
  // service pulls it from there instead of from upstream; the digest is
  // verified while staging either way.
  const download = process.env['MICA_RES_DOWNLOAD_BASE'] ?? 'https://dl.res.micaos.dev'
  const carry = await carriedOrigin(download, object.sha256)
  if (carry !== undefined) {
    carried.fromBucket += 1
    return stagePull(publisher, namespace, { origin: carry, sha256: object.sha256, contentType })
  }
  carried.fromUpstream += 1

  if (object.origin === undefined)
    throw new Error(`no-origin: ${object.sha256} has no upstream to mirror from`)
  if (object.kind === 'oci-blob' && object.mediaType?.includes('manifest')) {
    const answer = await fetch(object.origin, { headers: registryHeaders })
    if (!answer.ok)
      throw new Error(`origin: ${answer.status} for ${object.origin}`)
    const bytes = new Uint8Array(await answer.arrayBuffer())
    const digest = Bun.SHA256.hash(bytes, 'hex')
    if (digest !== object.sha256)
      throw new Error(`sha256-mismatch: ${object.origin} is ${digest}, the lock pins ${object.sha256}`)
    return stageBytes(publisher, namespace, bytes, contentType)
  }
  const origin = object.kind === 'oci-blob' ? await resolveRedirect(object.origin, registryHeaders) : object.origin
  return stagePull(publisher, namespace, { origin, sha256: object.sha256, contentType })
}

// A snapshot that loses a whole kind the published one had is a defect, not a
// state: three times now a run has produced derived state that disagreed with
// the bucket, and each time the shape was "something that exists stopped being
// enumerated". This is the cheap check that catches the shape rather than the
// three instances.
async function refuseRegression(document: IndexDocument, base: string): Promise<void> {
  const pointer = await fetch(`${base}/index/current.json`)
  if (!pointer.ok)
    return
  const version = (await pointer.json() as { version: string }).version
  const previous = await fetch(`${base}/index/${version}.json`)
  if (!previous.ok)
    return

  const before = summarise(readIndex(await previous.text()).objects)
  const after = new Map(summarise(document.objects).map(row => [row.kind, row.count]))
  for (const row of before) {
    if ((after.get(row.kind) ?? 0) === 0)
      throw new Error(`kind-vanished: index ${version} has ${row.count} ${row.kind} objects and this enumeration has none`)
  }
}

async function sync(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/sync'
  const apply = argv.includes('--apply')
  const kinds = (argv.includes('--kinds') ? argv[argv.indexOf('--kinds') + 1]!.split(',') : DEFAULT_KINDS) as Kind[]
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity
  const { objects, gitTrees } = await enumerate()
  if (argv.includes('--sizes') || apply)
    await resolveSizes(objects)

  const publisher = apply ? publisherFromEnv() : (process.env['MICA_RES_TOKEN'] ? publisherFromEnv() : undefined)
  if (apply) {
    const wanted = objects.filter(object => kinds.includes(object.kind)).slice(0, limit)
    console.log(`apply: ${wanted.length} objects of kind ${kinds.join(', ')} to ${publisher!.base}`)
    const keyed = wanted.flatMap((object) => {
      const key = canonicalKey(object)
      if (key === undefined)
        console.log(`  skipped ${object.sha256}: no readable name to publish it under`)
      return key === undefined ? [] : [{ object, key }]
    })
    const held = await heldByKey(publisher!, keyed.map(({ key }) => splitKey(key).namespace))
    // The build-env blobs live in a registry that wants a token. It is a public
    // anonymous token and it never leaves this process: a manifest is read here
    // with it, and a blob's redirect is resolved with it so the server pulls
    // the resolved URL.
    const registryHeaders = wanted.some(object => object.kind === 'oci-blob')
      ? { authorization: `Bearer ${await ghcrToken('mica-build-env')}`, accept: 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json,*/*' }
      : {}

    const batches = new Map<string, PublishItem[]>()
    const flush = async (namespace: string) => {
      const items = batches.get(namespace) ?? []
      batches.delete(namespace)
      if (items.length > 0)
        await publishBatch(publisher!, namespace, items)
    }
    let staged = 0
    let present = 0
    for (const { object, key } of keyed) {
      const { namespace, path } = splitKey(key)
      if (held.get(key)?.sha256 === object.sha256) {
        present += 1
        continue
      }
      const uploadId = await stage(publisher!, object, namespace, registryHeaders)
      batches.set(namespace, [...(batches.get(namespace) ?? []), { path, source: { uploadId }, ...(object.mediaType === undefined ? {} : { contentType: object.mediaType }), meta: objectMeta(object) }])
      staged += 1
      // Publish as we go, well inside the staging lifetime.
      if (batches.get(namespace)!.length >= 50)
        await flush(namespace)
      if ((staged + present) % 25 === 0)
        console.log(`  ${staged + present}/${keyed.length} (${staged} staged, ${present} already published)`)
    }
    for (const namespace of [...batches.keys()])
      await flush(namespace)
    for (const { object } of keyed) {
      for (const tag of registryTags(object))
        await setTag(publisher!, tag)
    }
    console.log(`apply: ${staged} published, ${present} already published, 0 deleted`)
    console.log(`  bytes: ${carried.fromBucket} carried from the bucket's existing keys, ${carried.fromUpstream} fetched from upstream`)
  }

  // Enumeration always covers every kind. `--kinds` gates what is UPLOADED and
  // nothing else: letting it narrow the enumeration is how a run that uploaded
  // product images published an index with no git packs in it, while the bucket
  // held all 44 of them.
  const packing = apply && kinds.includes('git-pack')
  let produced = 0
  for (const tree of gitTrees) {
    if (packing) {
      const answer = await mirrorTree(tree, publisher!)
      objects.push(...answer.objects)
      if (answer.produced)
        produced += 1
      continue
    }
    objects.push(...(await heldTree(tree, process.env['MICA_RES_BASE'] ?? DEFAULT_BASE) ?? []))
  }
  if (packing)
    console.log(`apply: ${produced} trees packed and written, ${gitTrees.length - produced} already held, 0 deleted`)

  // What the service holds, read back from it, whatever this run published.
  // Without a token the state stays `pending`: a dry run claims nothing.
  if (publisher !== undefined) {
    const keys = objects.map(object => canonicalKey(object))
    const held = await heldByKey(publisher, keys.flatMap(key => (key === undefined ? [] : [splitKey(key).namespace])))
    for (const [index, object] of objects.entries())
      object.state = keys[index] !== undefined && held.get(keys[index]!)?.sha256 === object.sha256 ? 'mirrored' : 'pending'
  }

  // The two uefi kernels are the same commit, so their packs can be the same
  // bytes under two names: merging unions the names onto one object rather
  // than listing a digest twice. The count below is the DOCUMENT's, not the
  // pre-merge array's -- reporting the array's was a figure that disagreed
  // with the published index by the number of merged duplicates, which the
  // audit caught.
  const merged = mergeObjects(objects)
  if (merged.length !== objects.length)
    console.log(`merged ${objects.length - merged.length} duplicate entr${objects.length - merged.length === 1 ? 'y' : 'ies'} onto objects already named`)
  const document = buildIndex({ version: stamp(), objects: merged })
  const snapshot = renderIndex(document)
  readIndex(snapshot)
  await refuseRegression(document, process.env['MICA_RES_BASE'] ?? DEFAULT_BASE)

  await mkdir(out, { recursive: true })
  await Bun.write(`${out}/index-${document.version}.json`, snapshot)
  await Bun.write(`${out}/current.json`, renderPointer({ version: document.version, sha256: Bun.SHA256.hash(snapshot, 'hex') }))

  console.log(`${apply ? 'applied' : 'dry run'}: ${document.objects.length} objects pinned, snapshot written to ${out}`)
  for (const row of summarise(document.objects))
    console.log(`  ${row.kind.padEnd(14)} ${String(row.mirrored).padStart(4)}/${String(row.count).padEnd(4)} mirrored  ${mib(row.mirroredBytes).padStart(10)} of ${mib(row.bytes).padStart(10)}${row.sizesUnknown > 0 ? `  (${row.sizesUnknown} without a stated size)` : ''}`)
  console.log(`  ${'git-tree'.padEnd(14)} ${String(gitTrees.length).padStart(4)} trees    (phase 3, not packed yet)`)
}

// Snapshots every run that has concluded and is not already held. A run in
// flight is listed in the pointer but never written immutably, so the snapshot
// of a run is written exactly once, when it is final.
async function collect(argv: string[]): Promise<void> {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : 'tmp/status'
  const apply = argv.includes('--apply')
  const publisher = apply ? publisherFromEnv() : undefined
  const held = publisher === undefined ? new Map<string, HeldObject>() : await listHeld(publisher, 'status')

  await mkdir(`${out}/runs`, { recursive: true })
  const repositories: { repository: string, runs: CurrentRun[] }[] = []
  const healths: Health[] = []
  const items: PublishItem[] = []
  let written = 0
  let already = 0
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

      const path = runKey(repository, run.id).slice('status/'.length)
      if (held.has(path)) {
        already += 1
        continue
      }
      const text = renderRun(runSnapshot(repository, run, await listJobs(repository, run.id)))
      await Bun.write(`${out}/runs/${repository}-${run.id}.json`, text)
      if (publisher !== undefined)
        items.push({ path, source: { uploadId: await stageBytes(publisher, 'status', new TextEncoder().encode(text), 'application/json') }, contentType: 'application/json' })
      written += 1
    }
    repositories.push({ repository, runs: summaries })
    healths.push(healthOf(repository, runs.map(run => ({
      id: run.id,
      workflow: run.path.replace('.github/workflows/', ''),
      event: run.event,
      branch: run.head_branch,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.run_started_at,
      completedAt: concluded(run) ? run.updated_at : null,
    })), Date.now()))
    console.log(`  ${repository.padEnd(18)} ${String(runs.length).padStart(3)} runs`)
  }

  // Is anything broken right now, and for how long? A red run is an event; a
  // red default branch for two days is a state, and a repository that failed
  // and then went quiet is the shape that hides it.
  const now = Date.now()
  const red = redRepositories(healths, Number(process.env['MICA_RES_RED_HOURS'] ?? '6'))
  // One extra call per announced repository, and only when one is announced:
  // what broke first is what a reader needs before opening anything.
  for (const one of red) {
    if (one.redRunId !== undefined)
      one.firstFailingJob = firstFailingJob(await listJobs(one.repository, one.redRunId))
  }
  for (const one of healths.toSorted((a, b) => a.repository.localeCompare(b.repository))) {
    const age = one.redHours === undefined ? '' : ` for ${one.redHours.toFixed(1)}h`
    const since = one.state.startsWith('red') ? `, ${one.runsSince === 0 ? 'nothing has run since' : `${one.runsSince} run(s) since`}` : ''
    console.log(`  ${one.repository.padEnd(18)} ${one.state}${age}${since}`)
  }
  const health = `${JSON.stringify({ schema: 'mica/status-health/v1', generatedAt: new Date(now).toISOString(), repositories: healths })}\n`
  await Bun.write(`${out}/health.json`, health)
  if (publisher !== undefined)
    items.push({ path: 'health.json', source: { uploadId: await stageBytes(publisher, 'status', new TextEncoder().encode(health), 'application/json') }, contentType: 'application/json' })

  // It reaches a person without anyone remembering to look: one GitHub issue,
  // updated while anything is red, closed when everything is green.
  if (process.env['MICA_RES_ANNOUNCE'] === '1')
    console.log(`announce: ${await announce(decide(red, await openIssue(), now))}`)
  else if (red.length > 0)
    console.log(`announce: skipped (MICA_RES_ANNOUNCE is not 1); ${red.length} repository/ies would be announced`)

  const current = renderCurrent({ generatedAt: new Date().toISOString(), repositories })
  await Bun.write(`${out}/current.json`, current)
  if (publisher !== undefined) {
    items.push({ path: 'current.json', source: { uploadId: await stageBytes(publisher, 'status', new TextEncoder().encode(current), 'application/json') }, contentType: 'application/json' })
    await publishBatch(publisher, 'status', items)
  }

  console.log(`collect: ${written} snapshots ${publisher === undefined ? 'rendered' : 'published'}, ${already} already held, ${inFlight} in flight, 0 deleted`)
}

// Walks the contract a consumer implements, against the live mirror.
async function verify(argv: string[]): Promise<void> {
  const base = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const wanted = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : undefined
  const listing = async (prefix: string) => {
    const answer = await fetch(`${base}/upstream/${prefix}`, { headers: { accept: 'application/json' } })
    if (!answer.ok)
      throw new Error(`listing: ${answer.status} for ${base}/upstream/${prefix}`)
    return answer.json() as Promise<{ directories: { path: string }[], objects: { path: string, size: number }[] }>
  }

  const trees: { name: string, commit: string, size: number }[] = []
  for (const directory of (await listing('git/')).directories) {
    for (const object of (await listing(directory.path)).objects) {
      const match = /^git\/([^/]+)\/([0-9a-f]{40})\.json$/.exec(object.path)
      if (match !== null)
        trees.push({ name: match[1]!, commit: match[2]!, size: object.size })
    }
  }
  const chosen = wanted === undefined
    ? trees.sort((a, b) => a.size - b.size)[0]
    : trees.find(tree => tree.name === wanted)
  if (chosen === undefined) {
    console.log(`verify-pack: no git pack to verify${wanted === undefined ? '' : ` for ${wanted}`}`)
    return
  }

  const work = await mkdtemp(join(tmpdir(), 'mica-res-verify-'))
  try {
    const answer = await verifyPack(base, chosen, work)
    console.log(`verify-pack: ${chosen.name} at ${chosen.commit} imported from ${answer.chunks} chunk(s), ${(answer.pack / 1048576).toFixed(1)} MiB, checked out and fsck clean`)
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

// The objective half of a retention policy: an image release is prunable only
// if no published lock names it and it is mirrored.
async function imagePins(): Promise<void> {
  for (const pinned of await pinnedImageReleases(REPOSITORIES))
    console.log(`${pinned.release}  named by ${pinned.pinnedBy.length}: ${pinned.pinnedBy.join('; ')}`)
}

// Reads what the edge publishes and what the download host serves, neither of
// which this process produced, and refuses on any disagreement. It imports
// the audit module and nothing that enumerates or publishes.
// What the service's catalog holds against what the producers' locks name.
// Read-only and token-free: the listings are public. Where the two disagree
// the locks win, so a conflicting key is reported, never republished over.
// Republishes run snapshots from a downloaded artifact tree: the only copy of
// the history the collector rendered while it had no token.
async function backfill(argv: string[]): Promise<void> {
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1]! : 'tmp/artifacts'
  const publisher = publisherFromEnv()
  const held = await listHeld(publisher, 'status')

  const files = [...new Bun.Glob('**/runs/*.json').scanSync({ cwd: dir, absolute: true })]
  const seen = new Set<string>()
  const items: PublishItem[] = []
  const snapshots: { startedAt: string }[] = []
  let already = 0
  for (const file of files) {
    const parsed = parseSnapshotFile(file)
    if (parsed === undefined || seen.has(parsed.key))
      continue
    seen.add(parsed.key)

    const text = await Bun.file(file).text()
    const snapshot = JSON.parse(text) as { startedAt?: string }
    if (snapshot.startedAt !== undefined)
      snapshots.push({ startedAt: snapshot.startedAt })

    const path = parsed.key.slice('status/'.length)
    if (held.has(path)) {
      already += 1
      continue
    }
    items.push({ path, source: { uploadId: await stageBytes(publisher, 'status', new TextEncoder().encode(text), 'application/json') }, contentType: 'application/json' })
    if (items.length >= 50) {
      await publishBatch(publisher, 'status', items.splice(0))
      console.log(`  published ${seen.size - already} so far`)
    }
  }
  if (items.length > 0)
    await publishBatch(publisher, 'status', items)

  const covered = windowOf(snapshots)
  console.log(`backfill: ${seen.size} snapshots in ${files.length} file(s), ${seen.size - already} published, ${already} already held`)
  console.log(`  window recovered: ${covered === undefined ? 'none' : `${covered.from} .. ${covered.to}`}`)
}

// Walks the consumer contract for every git pack: the manifest a tree names,
// and every chunk that manifest declares, under that manifest's own name. With
// --repair it republishes a missing name from the bytes the service already
// holds; the digest is verified by the service while staging, so a repair
// cannot invent content.
// Fetches every mirror URL the newest version index names and compares the
// bytes' digest with the one the index states beside it -- the check a device
// would do.
// How much run history the bucket holds, over what span, and whether the
// series has a gap. Read-only and token-free: the status listings are public.
async function history(): Promise<void> {
  const home = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const held = await walkNamespace(home, 'status')
  const keys = new Set(held.map(object => object.key))
  const runKeys = held.filter(object => /^status\/runs\//.test(object.key))

  const gaps: Gap[] = []
  const stamps = new Map<string, string>()
  let concluded = 0
  for (const repository of REPOSITORIES) {
    const runs = await fetchJson<{ workflow_runs: ApiRunLite[] }>(
      `https://api.github.com/repos/micaoss/${repository}/actions/runs?per_page=100`, githubHeaders())
    for (const run of runs.workflow_runs)
      stamps.set(`status/runs/${repository}/${run.id}.json`, run.run_started_at)
    concluded += runs.workflow_runs.filter(run => run.status === 'completed' && run.conclusion !== null).length
    gaps.push(...missingSnapshots(repository, runs.workflow_runs, keys))
  }

  const span = spanOf(runKeys.map(object => object.key), stamps)
  const bytes = held.reduce((total, object) => total + object.size, 0)
  console.log(`history: ${runKeys.length} run snapshots in the bucket (${(bytes / 1048576).toFixed(1)} MiB in ${held.length} objects)`)
  console.log(`  span of the snapshots GitHub still lists: ${span === undefined ? 'none' : `${span.from} .. ${span.to} (${span.days} days)`}`)
  const { lag, holes } = classifyGaps(gaps, span?.to)
  console.log(`  concluded runs GitHub lists now: ${concluded}; without a snapshot: ${gaps.length}`)
  console.log(`  of those, started after the last collector pass (lag, not loss): ${lag.length}`)
  console.log(`  HOLES (older than the last pass and never collected): ${holes.length}`)
  for (const gap of holes.slice(0, 20))
    console.log(`  HOLE ${gap.repository} ${gap.id} started ${gap.startedAt}`)
  for (const name of ['status/current.json', 'status/health.json'])
    console.log(`  ${name}: ${keys.has(name) ? 'present' : 'MISSING'}`)
}

// The prunable set across the workspace, as three lists and no opinion.
async function prunable(): Promise<void> {
  const home = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const nodes: ReleaseNode[] = []
  const missingLock: string[] = []

  for (const repository of REPOSITORIES.filter(one => one !== 'mica' && one !== 'mica-res')) {
    const releases = await fetchJson<{ tag_name: string, assets: { name: string, browser_download_url: string }[] }[]>(
      `https://api.github.com/repos/micaoss/${repository}/releases?per_page=100`, githubHeaders())
    for (const release of releases) {
      const asset = release.assets.find(one => one.name === `${repository}.lock`)
      if (asset === undefined) {
        missingLock.push(`${repository} ${release.tag_name}`)
        continue
      }
      const lock = parseLock(await fetchText(asset.browser_download_url, githubHeaders()))
      const row = lock.rows.find((candidate: { kind: string }) => candidate.kind === 'release')!
      // Both sides of the join go through `releaseId`, so a tag written with
      // either separator keys the same as the identity a lock row spells.
      const tag = row.fields[2]!
      nodes.push({ id: releaseId(repository, tag), repository, tag, names: namesOf(lock) })
    }
  }

  // Mirrored: a mica-build scoped release is mirrored when its product
  // directory holds objects; a build-env release when its registry tag
  // resolves. Producer releases (boards, core, Base, podman) publish their
  // packages to their own ghcr pools, which this mirror does not hold by
  // decision, so they are never "mirrored" and their bytes live upstream.
  const mirrored = new Set<string>()
  const held = await walkNamespace(home, 'mica')
  for (const node of nodes) {
    // Read back from the normalised identity rather than from the tag, so a
    // slash-form release is looked up in the mirror under the same scope and
    // stamp as a dot-form one.
    const [left, stamp] = node.id.split('/') as [string, string]
    const scope = left.includes('.') ? left.slice(left.indexOf('.') + 1) : undefined
    if (node.repository === 'mica-build' && scope !== undefined && scope !== 'mica') {
      if (held.some(object => object.key.startsWith(`mica/${scope}/${stamp}/`)))
        mirrored.add(node.id)
    }
    else if (node.repository === 'mica-build-env') {
      const answer = await fetch(`${home}/v2/micaoss/mica-build-env/manifests/base.${stamp}`, { headers: { accept: 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' } })
      if (answer.ok)
        mirrored.add(node.id)
    }
  }

  const report = prunableReport(nodes, mirrored)
  const covered = indexCoverage(nodes)

  console.log(`prunable: ${nodes.length} published releases carrying a lock${missingLock.length > 0 ? `, ${missingLock.length} without one (${missingLock.join(', ')})` : ''}`)
  console.log(`\n1. NAMED BY A PUBLISHED LOCK -- not prunable (${report.named.length})`)
  for (const one of report.named)
    console.log(`  ${one.id.padEnd(38)} named by ${String(one.by.length).padStart(2)}: ${one.by.slice(0, 4).join(', ')}${one.by.length > 4 ? ', ...' : ''}`)
  console.log(`\n2. NAMED BY NOTHING, AND MIRRORED -- prunable under the rule (${report.prunableMirrored.length})`)
  for (const one of report.prunableMirrored)
    console.log(`  ${one.id.padEnd(38)} ${one.repository} ${one.tag}${(covered.get(one.id) ?? []).length > 0 ? `  [named by ${(covered.get(one.id) ?? []).length} index(es)]` : ''}`)
  console.log(`\n3. NAMED BY NOTHING, AND NOT MIRRORED (${report.prunableUnmirrored.length})`)
  for (const one of report.prunableUnmirrored)
    console.log(`  ${one.id.padEnd(38)} ${one.repository} ${one.tag}`)

  console.log('\nINDEX COVERAGE -- how many indexes lose full verifiability if the release is deleted')
  for (const [id, indexes] of [...covered.entries()].toSorted((a, b) => b[1].length - a[1].length))
    console.log(`  ${id.padEnd(38)} ${String(indexes.length).padStart(2)} index(es): ${indexes.slice(0, 5).join(', ')}${indexes.length > 5 ? ', ...' : ''}`)
}

async function mirrors(): Promise<void> {
  const releases = await fetchJson<{ tag_name: string, assets: { name: string, browser_download_url: string }[] }[]>(
    'https://api.github.com/repos/micaoss/mica-build/releases?per_page=100', githubHeaders())
  const index = releases.find(release => /^mica\.[0-9]{8}-[0-9]{4}$/.test(release.tag_name))
  if (index === undefined)
    throw new Error('no-index-release: mica-build publishes no mica.<stamp> release')
  const asset = index.assets.find(one => one.name === 'mica-index.json')
  if (asset === undefined) {
    console.log(`mirrors: ${index.tag_name} has no mica-index.json attached yet`)
    return
  }

  const document = JSON.parse(await fetchText(asset.browser_download_url, githubHeaders())) as Parameters<typeof mirrorEntries>[0]
  const entries = mirrorEntries(document)
  if (entries.length === 0) {
    console.log(`mirrors: ${index.tag_name} names no mirror URL`)
    return
  }
  const answer = await checkMirrors(entries)
  console.log(`mirrors: ${index.tag_name} names ${entries.length} mirror URL(s): ${answer.verified} verified, ${answer.pending.length} not mirrored yet, ${answer.wrong.length} wrong`)
  for (const line of [...answer.pending, ...answer.wrong])
    console.log(`  ${line}`)
  if (answer.wrong.length > 0)
    throw new Error(`mirrors refused: ${answer.wrong.length} mirror URL(s) do not serve the bytes the index names`)
}

async function packs(argv: string[]): Promise<void> {
  const home = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const download = process.env['MICA_RES_DOWNLOAD_BASE'] ?? 'https://dl.res.micaos.dev'
  const repair = argv.includes('--repair')
  const publisher = repair ? publisherFromEnv() : undefined

  const { gitTrees } = await enumerate()
  let checked = 0
  let repaired = 0
  const problems: string[] = []
  for (const tree of gitTrees) {
    const key = manifestKey(tree.name, tree.commit)
    const answer = await fetch(`${download}/${key}`)
    if (!answer.ok) {
      problems.push(`${key}: ${answer.status} from the download host`)
      continue
    }
    const manifest = await answer.json() as PackManifest
    const missing = await missingChunks(download, tree.name, manifest)
    checked += manifest.chunks.length
    for (const chunk of missing) {
      problems.push(`${chunk.key}: declared by the manifest and does not resolve under its own name`)
      if (publisher === undefined)
        continue
      // The bytes are already in the service under their digest; the repair is
      // a name, not an upload.
      const origin = await resolveRedirect(`${home}/blob/${chunk.sha256.slice(0, 2)}/${chunk.sha256}`, {})
      const uploadId = await stagePull(publisher, 'upstream', { origin, sha256: chunk.sha256, contentType: 'application/octet-stream' })
      await publishBatch(publisher, 'upstream', [{ path: chunk.key.slice('upstream/'.length), source: { uploadId }, contentType: 'application/octet-stream' }])
      repaired += 1
      console.log(`  repaired ${chunk.key} from ${chunk.sha256}`)
    }
  }

  console.log(`packs: ${gitTrees.length} manifests, ${checked} declared chunks, ${problems.length} problem(s)${repair ? `, ${repaired} repaired` : ''}`)
  for (const problem of problems)
    console.log(`  ${problem}`)
  if (problems.length > repaired)
    throw new Error(`packs refused: ${problems.length - repaired} chunk(s) do not resolve under the name the contract tells a consumer to use`)
}

async function reconcileCommand(): Promise<void> {
  const home = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const site = await (await fetch(`${home}/.well-known/res.json`)).json() as { namespaces: SiteNamespace[], snapshot: { version: string } }

  // `status` is the collector's own output and `brand` the repository's
  // assets: neither is named by any producer lock, so counting them as
  // "held and named by no lock" would drown the one column worth reading.
  const ours = new Set(['status', 'brand', 'docs'])
  const held: ListedObject[] = []
  for (const namespace of site.namespaces.filter(n => n.visibility === 'public' && n.listable && !ours.has(n.name)))
    held.push(...await walkNamespace(home, namespace.name))

  const { objects, gitTrees } = await enumerate()
  const pinned = mergeObjects(objects).flatMap((object) => {
    const key = canonicalKey(object)
    return key === undefined ? [] : [{ key, sha256: object.sha256 }]
  })

  const answer = reconcile(pinned, held, derivedPrefixes(gitTrees))
  console.log(`reconcile: catalog ${site.snapshot.version} holds ${held.length}, the locks name ${pinned.length} (${gitTrees.length} git trees are packed on demand and not counted)`)
  console.log(summary(answer, held.length))
  for (const conflict of answer.conflicts)
    console.log(`  CONFLICT ${conflict.key}: the lock names ${conflict.lock}, the catalog holds ${conflict.catalog}`)
  for (const object of answer.unpinned.slice(0, 20))
    console.log(`  unpinned ${object.key} ${object.sha256}`)
  if (answer.unpinned.length > 20)
    console.log(`  ... and ${answer.unpinned.length - 20} more unpinned`)
  if (answer.conflicts.length > 0)
    throw new Error(`reconcile refused: ${answer.conflicts.length} key(s) hold a digest no lock names; the locks win and this needs a decision`)
}

async function audit(): Promise<void> {
  const home = process.env['MICA_RES_BASE'] ?? DEFAULT_BASE
  const answer = await fetch(`${home}/.well-known/res.json`)
  if (!answer.ok)
    throw new Error(`site: ${answer.status} for ${home}/.well-known/res.json`)
  const site = await answer.json() as { site: { download: string }, namespaces: SiteNamespace[], snapshot: { version: string } }

  const problems: string[] = []
  const all: ListedObject[] = []
  for (const namespace of site.namespaces.filter(n => n.visibility === 'public' && n.listable)) {
    const objects = await walkNamespace(home, namespace.name)
    problems.push(...checkListing(namespace, objects))
    all.push(...objects)
    console.log(`  ${namespace.name.padEnd(10)} ${String(objects.length).padStart(5)} objects`)
  }
  problems.push(...await checkBytes(site.site.download, all))
  console.log(`audit: catalog ${site.snapshot.version} lists ${all.length} public objects, ${problems.length} problem(s)`)
  if (problems.length > 0)
    throw new Error(`audit refused:\n  ${problems.join('\n  ')}`)
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
  case 'history':
    await history()
    break
  case 'prunable':
    await prunable()
    break
  case 'mirrors':
    await mirrors()
    break
  case 'packs':
    await packs(argv)
    break
  case 'backfill':
    await backfill(argv)
    break
  case 'reconcile':
    await reconcileCommand()
    break
  case 'audit':
    await audit()
    break
  case 'image-pins':
    await imagePins()
    break
  case 'verify-pack':
    await verify(argv)
    break
  case 'collect':
    await collect(argv)
    break
  case 'index':
    await index(argv)
    break
  default:
    console.error('usage: bun src/cli.ts sync [--sizes] [--apply] [--kinds <k,k>] [--limit <n>] [--out <dir>] | collect [--apply] [--out <dir>] | verify-pack [--name <tree>] | audit | image-pins | index --check <file>')
    process.exit(2)
}
