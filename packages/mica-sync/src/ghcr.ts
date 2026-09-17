// The build-env images: enumerated from the `image` rows a consumer already
// pins by digest, then read anonymously from ghcr for their layer digests and
// sizes. Nothing is republished; these are the same blobs under our own host.

import { fetchJson } from './fetch.ts'
import type { Lock } from './locks.ts'
import { blobPath } from './objects.ts'
import type { PinSource, ResourceObject } from './objects.ts'

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

export interface ImageRow {
  name: string
  platform: string
  reference: string
  digest: string
}

interface Descriptor {
  digest: string
  size: number
  mediaType?: string
}

interface Manifest {
  manifests?: Descriptor[]
  config?: Descriptor
  layers?: Descriptor[]
}

export function imageRows(lock: Lock, repository: string): ImageRow[] {
  return lock.rows
    .filter(row => row.kind === 'image' && row.fields[1] === repository)
    .map(({ fields }) => {
      const reference = fields[4]!
      const digest = reference.split('@sha256:')[1]
      if (digest === undefined)
        throw new Error(`reference-digest: ${reference}`)
      return { name: fields[2]!, platform: fields[3]!, reference, digest }
    })
}

export async function ghcrToken(repository: string): Promise<string> {
  const { token } = await fetchJson<{ token: string }>(`https://ghcr.io/token?scope=repository:micaoss/${repository}:pull&service=ghcr.io`)
  return token
}

export function blobOrigin(repository: string, sha256: string): string {
  return `https://ghcr.io/v2/micaoss/${repository}/blobs/sha256:${sha256}`
}

export function manifestOrigin(repository: string, sha256: string): string {
  return `https://ghcr.io/v2/micaoss/${repository}/manifests/sha256:${sha256}`
}

export function descriptorObjects(manifest: Manifest, pin: PinSource, row: ImageRow, repository = pin.repository): ResourceObject[] {
  const descriptors = [...(manifest.manifests ?? []), ...(manifest.config === undefined ? [] : [manifest.config]), ...(manifest.layers ?? [])]
  return descriptors.map(({ digest, size, mediaType }) => {
    const sha256 = digest.replace('sha256:', '')
    return {
      kind: 'oci-blob' as const,
      sha256,
      size,
      ...(mediaType === undefined ? {} : { mediaType }),
      // A manifest of an index is read from the manifests endpoint; a config or
      // a layer from the blobs endpoint.
      origin: mediaType !== undefined && mediaType.includes('manifest') ? manifestOrigin(repository, sha256) : blobOrigin(repository, sha256),
      path: blobPath(sha256),
      readable: [`/d/build-env/${pin.release}/${row.name}.${row.platform}/${sha256}`],
      pins: [{ ...pin, row: `image ${row.name} ${row.platform}` }],
    }
  })
}

// The manifest a lock row names is itself an object a puller asks for. Its tag,
// where the row carries one, becomes a registry readable name so that a tag
// resolves through the index like any other name.
export function manifestObject(row: ImageRow, repository: string, bytes: number, mediaType: string, pin: PinSource): ResourceObject {
  const tag = /:([^:@]+)@sha256:/.exec(row.reference)?.[1]
  return {
    kind: 'oci-blob',
    sha256: row.digest,
    size: bytes,
    mediaType,
    origin: manifestOrigin(repository, row.digest),
    path: blobPath(row.digest),
    readable: [
      `/d/build-env/${pin.release}/${row.name}.${row.platform}/${row.digest}`,
      ...(tag === undefined ? [] : [`/v2/micaoss/${repository}/manifests/${tag}`]),
    ],
    pins: [{ ...pin, row: `image ${row.name} ${row.platform}` }],
  }
}

export async function enumerateImages(lock: Lock, pin: PinSource, repository: string): Promise<ResourceObject[]> {
  const token = await ghcrToken(repository)
  const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES }
  const objects: ResourceObject[] = []
  for (const row of imageRows(lock, repository)) {
    const url = `https://ghcr.io/v2/micaoss/${repository}/manifests/sha256:${row.digest}`
    const answer = await fetch(url, { headers })
    if (!answer.ok)
      throw new Error(`${answer.status} ${answer.statusText} for ${url}`)
    const text = await answer.text()
    const mediaType = answer.headers.get('content-type') ?? 'application/vnd.oci.image.manifest.v1+json'
    objects.push(manifestObject(row, repository, new TextEncoder().encode(text).length, mediaType, pin))
    objects.push(...descriptorObjects(JSON.parse(text) as Manifest, pin, row, repository))
  }
  return objects
}

// A registry serves a blob by redirecting to a signed URL, and the Worker has
// no registry credential by design. So the client resolves the redirect with
// its own token and hands the Worker the resolved URL: the Worker stays a dumb
// fetcher, and the digest is still what R2 enforces.
export async function resolveRedirect(url: string, headers: Record<string, string>, fetcher: typeof fetch = fetch): Promise<string> {
  const answer = await fetcher(url, { method: 'GET', redirect: 'manual', headers })
  const location = answer.headers.get('location')
  if (answer.status >= 300 && answer.status <= 399 && location !== null)
    return new URL(location, url).toString()
  if (!answer.ok)
    throw new Error(`origin: ${answer.status} for ${url}`)
  return url
}
