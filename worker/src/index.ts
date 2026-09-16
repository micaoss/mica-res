// res.micaos.dev. The bucket is private and this Worker is its only public
// surface: immutable blobs by digest, the index, readable download paths that
// resolve through the index, the generated site, and one content-addressed
// write endpoint. There is no delete route.

import { readIndex, readPointer } from '../../src/index-doc.ts'
import { cacheControl, namedWriteDecision, route, writeDecision } from './routes.ts'
import type { WriteScope } from './routes.ts'

export interface Env {
  BUCKET: R2Bucket
  // The sync's bearer: content-addressed blobs, the index and the site.
  WRITE_TOKEN?: string
  // The collector's bearer: the status prefix only.
  STATUS_WRITE_TOKEN?: string
}

interface Resolved {
  version: string
  readable: Map<string, string>
}

let resolved: Resolved | null = null

async function readableMap(env: Env): Promise<Resolved | null> {
  const pointerObject = await env.BUCKET.get('index/current.json')
  if (pointerObject === null)
    return null
  const pointer = readPointer(await pointerObject.text())
  if (resolved !== null && resolved.version === pointer.version)
    return resolved

  // A snapshot is immutable, so it belongs in the edge cache rather than being
  // read from R2 by every cold isolate: resolving a readable name (a registry
  // tag among them) used to cost a full read of the index.
  const url = `https://res.micaos.dev/index/${pointer.version}.json`
  const cache = caches.default
  let snapshot = await cache.match(new Request(url))
  if (snapshot === undefined) {
    const stored = await env.BUCKET.get(`index/${pointer.version}.json`)
    if (stored === null)
      return null
    snapshot = new Response(await stored.text(), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' },
    })
    await cache.put(new Request(url), snapshot.clone())
  }
  const document = readIndex(await snapshot.text())
  resolved = {
    version: pointer.version,
    readable: new Map(document.objects.flatMap(object => object.readable.map(readable => [readable, object.path] as const))),
  }
  return resolved
}

function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'cache-control': 'no-store' } })
}

async function serve(key: string, request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const range = request.headers.get('range')
  const object = await env.BUCKET.get(key, range === null ? undefined : { range: request.headers })
  if (object === null)
    return notFound()

  const body = request.method === 'HEAD' ? null : object.body
  const status = object.range !== undefined && range !== null ? 206 : 200
  const response = new Response(body, { status, headers })
  object.writeHttpMetadata(response.headers)
  response.headers.set('cache-control', headers['cache-control']!)
  response.headers.set('etag', object.httpEtag)
  return response
}

function bearerOf(scope: WriteScope, env: Env): string | undefined {
  return scope === 'status' ? env.STATUS_WRITE_TOKEN : env.WRITE_TOKEN
}

// Fails closed: an unset bearer for a scope means that scope cannot be written
// at all, and a wrong bearer is never told which one was expected.
function authorise(scope: WriteScope, request: Request, env: Env): Response | null {
  const expected = bearerOf(scope, env)
  if (expected === undefined || expected === '')
    return new Response('write is not configured\n', { status: 503 })
  if (request.headers.get('authorization') !== `Bearer ${expected}`)
    return new Response('unauthorized\n', { status: 401 })
  return null
}

async function body(request: Request): Promise<{ bytes: Uint8Array, digest: string }> {
  const bytes = new Uint8Array(await request.arrayBuffer())
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return { bytes, digest }
}

async function write(key: string, digest: string, request: Request, env: Env): Promise<Response> {
  const refusal = authorise('mirror', request, env)
  if (refusal !== null)
    return refusal

  const { bytes, digest: bodyDigest } = await body(request)
  const existing = await env.BUCKET.head(key)
  const decision = writeDecision({ digest, bodyDigest, existing: existing === null ? null : digest })
  if (decision.status !== 200)
    return new Response(`${decision.reason}\n`, { status: decision.status })
  if (decision.reason === 'stored') {
    // A registry client reads the media type back as the content type.
    const mediaType = request.headers.get('x-mica-media-type') ?? undefined
    await env.BUCKET.put(key, bytes, {
      customMetadata: { sha256: bodyDigest, ...(mediaType === undefined ? {} : { mediaType }) },
      ...(mediaType === undefined ? {} : { httpMetadata: { contentType: mediaType } }),
    })
  }
  return new Response(`${decision.reason}\n`, { status: 200 })
}

async function writeNamed(key: string, immutable: boolean, scope: WriteScope, request: Request, env: Env): Promise<Response> {
  const refusal = authorise(scope, request, env)
  if (refusal !== null)
    return refusal

  const { bytes, digest: bodyDigest } = await body(request)
  const held = await env.BUCKET.head(key)
  const existing = held === null ? null : (held.customMetadata?.['sha256'] ?? 'unknown')
  const decision = namedWriteDecision({ immutable, existing, bodyDigest })
  if (decision.status !== 200)
    return new Response(`${decision.reason}\n`, { status: decision.status })
  if (decision.reason !== 'exists-identical') {
    await env.BUCKET.put(key, bytes, {
      customMetadata: { sha256: bodyDigest },
      httpMetadata: { contentType: key.endsWith('.json') ? 'application/json' : key.endsWith('.html') ? 'text/html' : 'application/octet-stream' },
    })
  }
  return new Response(`${decision.reason}\n`, { status: 200 })
}

// An object past the edge's request-body limit (a 129.3 MB archive answered
// 413) is streamed by the Worker from its origin straight into R2, with the
// pinned digest handed to R2 as the expected checksum: R2 refuses the object if
// the bytes do not hash to it, so the content-addressed guarantee is kept
// without the bytes ever passing through a request body or the Worker's memory.
async function pull(key: string, digest: string, request: Request, env: Env): Promise<Response> {
  const refusal = authorise('mirror', request, env)
  if (refusal !== null)
    return refusal

  const held = await env.BUCKET.head(key)
  if (held !== null)
    return new Response('exists-identical\n', { status: 200 })

  const { origin, mediaType } = await request.json() as { origin?: string, mediaType?: string }
  if (origin === undefined || !origin.startsWith('https://'))
    return new Response('origin-required\n', { status: 400 })

  // The origin is a hint, never a trust anchor: the digest is what is
  // enforced, so a wrong origin can only fail. Redirects are followed by hand
  // so that every hop is re-checked as https and the chain is bounded -- the
  // failure mode to avoid is this route becoming an open fetcher. It also
  // never echoes what it fetched: the answer is `stored` or a refusal, so the
  // route cannot be used to read a URL, only to store bytes whose hash is
  // already known.
  let target = origin
  let download: Response | undefined
  for (let hop = 0; hop < 5; hop += 1) {
    const answer = await fetch(target, { redirect: 'manual' })
    if (answer.status < 300 || answer.status > 399) {
      download = answer
      break
    }
    const location = answer.headers.get('location')
    if (location === null)
      return new Response('origin-redirect-without-location\n', { status: 502 })
    const next = new URL(location, target)
    if (next.protocol !== 'https:')
      return new Response('origin-redirect-not-https\n', { status: 400 })
    target = next.toString()
  }
  if (download === undefined)
    return new Response('origin-redirect-loop\n', { status: 502 })
  if (!download.ok || download.body === null)
    return new Response(`origin: ${download.status}\n`, { status: 502 })

  try {
    await env.BUCKET.put(key, download.body, {
      sha256: digest,
      customMetadata: { sha256: digest, ...(mediaType === undefined ? {} : { mediaType }) },
      httpMetadata: { contentType: mediaType ?? 'application/octet-stream' },
    })
  }
  catch {
    // R2 rejects the put when the streamed bytes do not hash to the digest.
    return new Response('sha256-mismatch\n', { status: 409 })
  }
  return new Response('stored\n', { status: 200 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const matched = route(new URL(request.url).pathname)
    if (matched.kind === 'not-found')
      return notFound()

    if (matched.kind === 'pull') {
      return request.method === 'POST'
        ? pull(matched.key, matched.digest, request, env)
        : new Response('method not allowed\n', { status: 405, headers: { allow: 'POST' } })
    }

    if (matched.kind === 'write' || matched.kind === 'write-named') {
      if (request.method !== 'PUT')
        return new Response('method not allowed\n', { status: 405, headers: { allow: 'PUT' } })
      return matched.kind === 'write'
        ? write(matched.key, matched.digest, request, env)
        : writeNamed(matched.key, matched.immutable, matched.scope, request, env)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } })

    if (matched.kind === 'registry-root') {
      // The distribution API's version check. This registry is read-only and
      // anonymous, so there is no authentication to advertise.
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'docker-distribution-api-version': 'registry/2.0',
          'cache-control': cacheControl(matched),
        },
      })
    }

    const headers = { 'cache-control': cacheControl(matched) }
    if (matched.kind === 'download') {
      const lookup = await readableMap(env)
      const key = lookup?.readable.get(matched.readable)
      if (key === undefined)
        return notFound()
      const response = await serve(key, request, env, headers)
      // A registry client reads the digest it was served from the header.
      response.headers.set('docker-content-digest', `sha256:${key.split('/').pop()}`)
      return response
    }
    const response = await serve(matched.key, request, env, headers)
    if (matched.kind === 'blob' && matched.digest !== undefined)
      response.headers.set('docker-content-digest', `sha256:${matched.digest}`)
    return response
  },
} satisfies ExportedHandler<Env>
