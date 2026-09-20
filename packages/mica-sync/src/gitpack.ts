// Phase 3: the vendor trees, mirrored as the packfile of a depth-1 fetch.
//
// What a pack is trusted by is the COMMIT, not the pack's own bytes: a consumer
// imports it with `git index-pack`, which verifies every object's hash, writes
// a one-line `.git/shallow`, and asserts the pinned commit with `rev-parse`.
// The mirror therefore records no origin for a pack -- no URL upstream serves
// these bytes -- and a pack that is not reproducible byte for byte costs
// nothing, because nothing compares two packs.
//
// A pack past the edge's request limit is stored as ordered chunks, each its
// own content-addressed blob, so the write endpoint keeps its one guarantee:
// a key is its content's sha256. The manifest names the chunks in order, and
// a consumer concatenates them into `git index-pack --stdin`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitTree } from './enumerate.ts'
import type { ResourceObject } from './objects.ts'

export const SCHEMA = 'mica/git-pack/v1'

// Comfortably below the request-body limit the edge enforces.
export const CHUNK_BYTES = 64 * 1024 * 1024

export interface Piece {
  sha256: string
  size: number
}

// A name is the object's KEY -- `<namespace>/<path>`, which is at once the
// bucket key and the path on the download host. The retired `/d/` prefix is
// gone; a caller builds a URL as `<base>/<key>`.
export function manifestName(tree: GitTree): string {
  return `upstream/git/${tree.name}/${tree.commit}.json`
}

export function chunkNames(tree: GitTree, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `upstream/git/${tree.name}/${tree.commit}.pack.${String(index).padStart(2, '0')}`)
}

export function renderManifest(tree: GitTree, pack: Piece, chunks: Piece[]): string {
  return `${JSON.stringify({
    schema: SCHEMA,
    repository: tree.repository,
    name: tree.name,
    url: tree.url,
    commit: tree.commit,
    pack,
    chunks,
  })}\n`
}

export function packObjects(tree: GitTree, pack: Piece, chunks: Piece[], manifest: string): ResourceObject[] {
  const names = chunkNames(tree, chunks.length)
  const objects: ResourceObject[] = chunks.map((chunk, index) => ({
    kind: 'git-pack',
    sha256: chunk.sha256,
    size: chunk.size,
    commit: tree.commit,
    readable: [names[index]!],
    pins: [{ repository: tree.repository, lock: 'locks/upstream.lock', release: 'main', row: `git ${tree.name}` }],
  }))
  const bytes = new TextEncoder().encode(manifest)
  const sha256 = Bun.SHA256.hash(bytes, 'hex')
  objects.push({
    kind: 'git-pack',
    sha256,
    size: bytes.length,
    mediaType: 'application/json',
    commit: tree.commit,
    readable: [manifestName(tree)],
    pins: [{ repository: tree.repository, lock: 'locks/upstream.lock', release: 'main', row: `git ${tree.name}` }],
  })
  return objects
}

export function chunkBytes(pack: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < pack.length; offset += size)
    chunks.push(pack.subarray(offset, Math.min(offset + size, pack.length)))
  return chunks
}

async function run(command: string[]): Promise<void> {
  const answer = await Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' }).exited
  if (answer !== 0)
    throw new Error(`git: ${command.join(' ')} exited ${answer}`)
}

// A depth-1 fetch, then the objects of exactly that commit. `git init` plus
// `fetch --depth=1 <commit>` rather than a clone of a name, for the same reason
// mica-boards does it that way: a branch is a name upstream can move.
export async function producePack(tree: GitTree): Promise<Uint8Array> {
  const work = await mkdtemp(join(tmpdir(), 'mica-res-pack-'))
  const repository = join(work, 'src')
  try {
    await run(['git', 'init', '-q', repository])
    await run(['git', '-C', repository, 'remote', 'add', 'origin', tree.url])
    await run(['git', '-C', repository, 'fetch', '-q', '--depth=1', 'origin', tree.commit])

    const head = Bun.spawn(['git', '-C', repository, 'rev-parse', 'FETCH_HEAD'], { stdout: 'pipe', stderr: 'pipe' })
    const got = (await new Response(head.stdout).text()).trim()
    if (got !== tree.commit)
      throw new Error(`commit-mismatch: ${tree.url} answered ${got}, the lock pins ${tree.commit}`)

    const pack = Bun.spawn(['git', '-C', repository, 'pack-objects', '--revs', '--stdout'], {
      stdin: new Blob([`${tree.commit}\n`]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const bytes = new Uint8Array(await new Response(pack.stdout).arrayBuffer())
    if (await pack.exited !== 0)
      throw new Error(`git: pack-objects exited non-zero for ${tree.name}`)
    return bytes
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

export interface Manifest {
  schema: string
  repository: string
  name: string
  url: string
  commit: string
  pack: Piece
  chunks: Piece[]
}

export function readManifest(text: string): Manifest {
  const manifest = JSON.parse(text) as Manifest
  if (manifest.schema !== SCHEMA)
    throw new Error(`schema: ${manifest.schema} is not ${SCHEMA}`)
  if (!/^[0-9a-f]{40}$/.test(manifest.commit))
    throw new Error(`field-value: ${manifest.commit} is not a commit`)
  if (manifest.chunks.length === 0)
    throw new Error('field-value: a manifest names no chunk')
  return manifest
}

// The consumer contract, run as a gate here so that what mica-boards is asked
// to implement is a path this repository has already walked: fetch the
// manifest, fetch its chunks in order, concatenate them into
// `git index-pack --stdin`, write the one-line shallow file, and check out the
// pinned commit. Git verifies every object it imports, so a wrong byte fails
// the import rather than producing a wrong tree.
export async function verifyPack(base: string, tree: { name: string, commit: string }, work: string): Promise<{ pack: number, chunks: number }> {
  const manifest = readManifest(await (await fetch(`${base}/${manifestName(tree as GitTree)}`)).text())
  const names = chunkNames(tree as GitTree, manifest.chunks.length)
  const packFile = join(work, 'joined.pack')
  const writer = Bun.file(packFile).writer()
  for (const [index, name] of names.entries()) {
    const answer = await fetch(`${base}/${name}`)
    if (!answer.ok)
      throw new Error(`chunk: ${answer.status} for ${name}`)
    const bytes = new Uint8Array(await answer.arrayBuffer())
    const expected = manifest.chunks[index]!
    const digest = Bun.SHA256.hash(bytes, 'hex')
    if (digest !== expected.sha256)
      throw new Error(`chunk-sha256: ${name} is ${digest}, the manifest says ${expected.sha256}`)
    writer.write(bytes)
  }
  await writer.end()

  const whole = Bun.SHA256.hash(await Bun.file(packFile).bytes(), 'hex')
  if (whole !== manifest.pack.sha256)
    throw new Error(`pack-sha256: the joined chunks are ${whole}, the manifest says ${manifest.pack.sha256}`)

  const repository = join(work, 'import')
  await run(['git', 'init', '-q', repository])
  const importer = Bun.spawn(['git', '-C', repository, 'index-pack', '--stdin'], { stdin: Bun.file(packFile), stdout: 'ignore', stderr: 'pipe' })
  if (await importer.exited !== 0)
    throw new Error(`index-pack refused the pack of ${tree.name}`)
  await Bun.write(join(repository, '.git/shallow'), `${tree.commit}\n`)
  await run(['git', '-C', repository, 'checkout', '-q', '--detach', tree.commit])

  const head = Bun.spawn(['git', '-C', repository, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  const got = (await new Response(head.stdout).text()).trim()
  if (got !== tree.commit)
    throw new Error(`commit-mismatch: the imported tree is at ${got}, the lock pins ${tree.commit}`)
  await run(['git', '-C', repository, 'fsck', '--no-dangling'])
  return { pack: manifest.pack.size, chunks: manifest.chunks.length }
}
