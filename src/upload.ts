// The upload side of the sync. Every byte is fetched from its origin, verified
// against the sha256 the consumer's own lock pins, and then written through the
// Worker's content-addressed endpoint -- which hashes it again and refuses a
// key that is not the body's digest. Verified before, verified on write, and
// nothing here can delete anything.

import type { ResourceObject } from './objects.ts'

export interface Target {
  base: string
  token: string
}

export type Outcome = 'present' | 'stored' | 'exists-identical'

function hex(bytes: Uint8Array): string {
  return Bun.SHA256.hash(bytes, 'hex')
}

export async function ensureBlob(object: Pick<ResourceObject, 'sha256' | 'path'> & { origin?: string }, target: Target, fetcher: typeof fetch = fetch): Promise<Outcome> {
  const head = await fetcher(`${target.base}/${object.path}`, { method: 'HEAD' })
  if (head.ok)
    return 'present'
  if (head.status !== 404)
    throw new Error(`mirror-head: ${head.status} for ${object.path}`)

  if (object.origin === undefined)
    throw new Error(`no-origin: ${object.sha256} has no upstream to mirror from`)

  const download = await fetcher(object.origin, { redirect: 'follow' })
  if (!download.ok)
    throw new Error(`origin: ${download.status} for ${object.origin}`)
  const bytes = new Uint8Array(await download.arrayBuffer())

  // Before: the bytes are what the lock pinned, or nothing is uploaded.
  const digest = hex(bytes)
  if (digest !== object.sha256)
    throw new Error(`sha256-mismatch: ${object.origin} is ${digest}, the lock pins ${object.sha256}`)

  const put = await fetcher(`${target.base}/w/blob/${object.sha256}`, {
    method: 'PUT',
    headers: { 'authorization': `Bearer ${target.token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  const reason = (await put.text()).trim()
  if (!put.ok)
    throw new Error(`write: ${put.status} ${reason} for ${object.sha256}`)
  return reason === 'exists-identical' ? 'exists-identical' : 'stored'
}

export async function putNamed(key: string, text: string, target: Target, fetcher: typeof fetch = fetch): Promise<string> {
  const put = await fetcher(`${target.base}/w/${key}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${target.token}` },
    body: text,
  })
  const reason = (await put.text()).trim()
  if (!put.ok)
    throw new Error(`write-named: ${put.status} ${reason} for ${key}`)
  return reason
}
