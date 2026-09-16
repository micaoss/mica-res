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
import { blobPath } from './objects.ts'
import type { ResourceObject } from './objects.ts'

export const SCHEMA = 'mica/git-pack/v1'

// Comfortably below the request-body limit the edge enforces.
export const CHUNK_BYTES = 64 * 1024 * 1024

export interface Piece {
  sha256: string
  size: number
}

export function manifestName(tree: GitTree): string {
  return `/d/upstream/git/${tree.name}/${tree.commit}.json`
}

export function chunkNames(tree: GitTree, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/d/upstream/git/${tree.name}/${tree.commit}.pack.${String(index).padStart(2, '0')}`)
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
    path: blobPath(chunk.sha256),
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
    path: blobPath(sha256),
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
