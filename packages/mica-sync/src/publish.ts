// The publish side of the sync, against the resource service's control plane
// (`/admin/api/res/*`, a personal API token with the `res:publish` scope).
//
// Bytes never pass through the API: an object with an https origin is pulled
// server-side into staging with the sha256 enforced by R2, and bytes this
// process holds (git packs, status snapshots, registry manifests read with a
// token) go to a presigned PUT whose checksum R2 enforces. A publish then
// copies staging to the readable key inside R2. Nothing here can delete: the
// token's scope has no delete route.

import type { ResourceObject } from './objects.ts'

export interface Publisher {
  /** e.g. `https://res.micaos.dev/admin/api` */
  base: string
  token: string
  fetcher?: typeof fetch
}

export interface HeldObject {
  sha256: string
  size: number
}

export interface PublishItem {
  path: string
  source: { uploadId: string } | { sha256: string }
  contentType?: string
  meta?: Record<string, string>
}

// A canonical key per object: the readable name a consumer already uses, which
// is the object's own key, preferring the Debian pool shape; OCI blobs by
// digest. A name with a leading slash is a registry name, not a key, so it is
// never a candidate (see `registryTags`).
export function canonicalKey(object: Pick<ResourceObject, 'kind' | 'sha256' | 'readable'>): string | undefined {
  if (object.kind === 'oci-blob')
    return `oci/blobs/sha256/${object.sha256}`
  const names = object.readable.filter(name => !name.startsWith('/')).sort()
  return names.find(name => name.startsWith('upstream/debian/pool/')) ?? names[0]
}

export function splitKey(key: string): { namespace: string, path: string } {
  const slash = key.indexOf('/')
  return { namespace: key.slice(0, slash), path: key.slice(slash + 1) }
}

// Registry tags an object answers to (`/v2/<repo>/manifests/<tag>`).
export function registryTags(object: Pick<ResourceObject, 'sha256' | 'readable'>): { repository: string, tag: string, digest: string }[] {
  return object.readable.flatMap((name) => {
    const match = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(name)
    return match === null || match[2]!.startsWith('sha256:') ? [] : [{ repository: match[1]!, tag: match[2]!, digest: `sha256:${object.sha256}` }]
  })
}

export function objectMeta(object: ResourceObject): Record<string, string> {
  return {
    kind: object.kind,
    ...(object.origin === undefined ? {} : { origin: object.origin }),
    ...(object.commit === undefined ? {} : { commit: object.commit }),
    pins: JSON.stringify(object.pins),
  }
}

async function call<T>(publisher: Publisher, method: string, path: string, body?: unknown): Promise<T> {
  const fetcher = publisher.fetcher ?? fetch
  const answer = await fetcher(`${publisher.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${publisher.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await answer.text()
  if (!answer.ok)
    throw new Error(`${method} ${path}: ${answer.status} ${text.slice(0, 500)}`)
  return (JSON.parse(text) as { data: T }).data
}

export interface CatalogueRow {
  path: string
  sha256: string
  size: number
  // The metadata the publisher wrote (`objectMeta`) and the v1 import carried
  // over unchanged: `kind`, `origin`, `commit`, and `pins` as a JSON STRING
  // inside it. The route parses the stored column before answering
  // (`resource.routes.ts`: `meta: JSON.parse(r.meta)`), so this arrives as an
  // object with one string member that is itself JSON.
  meta?: Record<string, string>
}

/** Every object of a namespace as the service records it, metadata included. */
export async function listCatalogue(publisher: Publisher, namespace: string): Promise<CatalogueRow[]> {
  const rows: CatalogueRow[] = []
  let after: string | undefined
  for (;;) {
    const query = new URLSearchParams({ limit: '5000', ...(after === undefined ? {} : { after }) })
    const page = await call<CatalogueRow[]>(publisher, 'GET', `/res/namespaces/${namespace}/objects?${query}`)
    rows.push(...page)
    if (page.length < 5000)
      return rows
    after = page.at(-1)!.path
  }
}

/** Every live object of a namespace, by path. */
export async function listHeld(publisher: Publisher, namespace: string): Promise<Map<string, HeldObject>> {
  const held = new Map<string, HeldObject>()
  let after: string | undefined
  for (;;) {
    const query = new URLSearchParams({ limit: '5000', ...(after === undefined ? {} : { after }) })
    const page = await call<{ path: string, sha256: string, size: number }[]>(publisher, 'GET', `/res/namespaces/${namespace}/objects?${query}`)
    for (const object of page)
      held.set(object.path, { sha256: object.sha256, size: object.size })
    if (page.length < 5000)
      return held
    after = page.at(-1)!.path
  }
}

/** Stream an https origin into staging on the server side. */
// A 429 or a 5xx from the origin means "ask later", not "this object cannot be
// mirrored": GitHub rate-limits release downloads, and a single 429 used to
// abort a whole apply. Retried with backoff; anything else fails at once.
function transient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /answered (429|5\d\d)/.test(text) || / (429|502|503|504) /.test(text)
}

export async function stagePull(publisher: Publisher, namespace: string, input: { origin: string, sha256: string, contentType: string }): Promise<string> {
  const waits = [5_000, 15_000, 45_000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await call<{ id: string }>(publisher, 'POST', `/res/namespaces/${namespace}/uploads/pull`, input)).id
    }
    catch (error) {
      const wait = waits[attempt]
      if (wait === undefined || !transient(error))
        throw error
      console.log(`  origin busy for ${input.sha256.slice(0, 12)}, retrying in ${wait / 1000}s`)
      await Bun.sleep(wait)
    }
  }
}

/** Upload bytes this process holds straight to R2 through a presigned PUT. */
export async function stageBytes(publisher: Publisher, namespace: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const sha256 = Bun.SHA256.hash(bytes, 'hex')
  const upload = await call<{ id: string, url: string, headers: Record<string, string>, direct?: boolean }>(publisher, 'POST', `/res/namespaces/${namespace}/uploads`, { sha256, size: bytes.length, contentType })
  // `direct` means the service takes the bytes itself because its store
  // cannot presign; that endpoint needs the token, a presigned R2 URL does not.
  const headers = upload.direct === true ? { ...upload.headers, authorization: `Bearer ${publisher.token}` } : upload.headers
  const put = await (publisher.fetcher ?? fetch)(upload.url, { method: 'PUT', headers, body: bytes })
  if (!put.ok)
    throw new Error(`upload: ${put.status} ${(await put.text()).slice(0, 300)} for ${sha256}`)
  return upload.id
}

/** Publish objects in batches of 200, one catalog snapshot per batch. */
export async function publishBatch(publisher: Publisher, namespace: string, items: PublishItem[]): Promise<{ changed: number }> {
  let changed = 0
  for (let i = 0; i < items.length; i += 200) {
    const answer = await call<{ objects: { outcome: string }[] }>(publisher, 'POST', `/res/namespaces/${namespace}/batch`, { objects: items.slice(i, i + 200) })
    changed += answer.objects.filter(o => o.outcome !== 'unchanged').length
  }
  return { changed }
}

export async function setTag(publisher: Publisher, tag: { repository: string, tag: string, digest: string }): Promise<void> {
  await call(publisher, 'PUT', '/res/namespaces/oci/oci-tags', tag)
}

export function publisherFromEnv(): Publisher {
  const token = process.env['MICA_RES_TOKEN']
  if (token === undefined || token === '')
    throw new Error('MICA_RES_TOKEN is not set; --apply publishes through the control plane with a res:publish API token')
  return { base: `${process.env['MICA_RES_BASE'] ?? 'https://res.micaos.dev'}/admin/api`, token }
}
