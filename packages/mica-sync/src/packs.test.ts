import { expect, test } from 'bun:test'
import { chunkKeys, missingChunks } from './packs.ts'

const commit = 'f'.repeat(40)
const manifest = { commit, chunks: [{ sha256: 'a'.repeat(64), size: 1 }, { sha256: 'b'.repeat(64), size: 2 }] }

test('the keys a consumer is told to fetch come from the manifest, in order', () => {
  expect(chunkKeys('uefi-x64-kernel', manifest)).toEqual([
    { key: `upstream/git/uefi-x64-kernel/${commit}.pack.00`, sha256: 'a'.repeat(64) },
    { key: `upstream/git/uefi-x64-kernel/${commit}.pack.01`, sha256: 'b'.repeat(64) },
  ])
})

test('a chunk that does not resolve under its OWN name is missing, whatever a sibling serves', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = input.toString()
    // pack.00 is absent here and present under another tree's name; that is
    // exactly the case a by-object check cannot see.
    return url.endsWith('.pack.00') ? new Response(null, { status: 404 }) : new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  const missing = await missingChunks('https://dl.test', 'uefi-x64-kernel', manifest, stub)
  expect(missing.map(one => one.key)).toEqual([`upstream/git/uefi-x64-kernel/${commit}.pack.00`])
})

test('a host that errs is not read as a missing chunk', async () => {
  const stub = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
  await expect(missingChunks('https://dl.test', 'x', manifest, stub)).rejects.toThrow('503')
})
