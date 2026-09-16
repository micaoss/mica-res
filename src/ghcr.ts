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

export function descriptorObjects(manifest: Manifest, pin: PinSource, row: ImageRow): ResourceObject[] {
  const descriptors = [...(manifest.manifests ?? []), ...(manifest.config === undefined ? [] : [manifest.config]), ...(manifest.layers ?? [])]
  return descriptors.map(({ digest, size }) => {
    const sha256 = digest.replace('sha256:', '')
    return {
      kind: 'oci-blob' as const,
      sha256,
      size,
      path: blobPath(sha256),
      readable: [`/d/build-env/${pin.release}/${row.name}.${row.platform}/${sha256}`],
      pins: [{ ...pin, row: `image ${row.name} ${row.platform}` }],
    }
  })
}

export async function enumerateImages(lock: Lock, pin: PinSource, repository: string): Promise<ResourceObject[]> {
  const token = await ghcrToken(repository)
  const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES }
  const objects: ResourceObject[] = []
  for (const row of imageRows(lock, repository)) {
    const manifest = await fetchJson<Manifest>(`https://ghcr.io/v2/micaoss/${repository}/manifests/sha256:${row.digest}`, headers)
    objects.push(...descriptorObjects(manifest, pin, row))
  }
  return objects
}
