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

  const snapshot = await env.BUCKET.get(`index/${pointer.version}.json`)
  if (snapshot === null)
    return null
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
  if (decision.reason === 'stored')
    await env.BUCKET.put(key, bytes, { customMetadata: { sha256: bodyDigest } })
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const matched = route(new URL(request.url).pathname)
    if (matched.kind === 'not-found')
      return notFound()

    if (matched.kind === 'write' || matched.kind === 'write-named') {
      if (request.method !== 'PUT')
        return new Response('method not allowed\n', { status: 405, headers: { allow: 'PUT' } })
      return matched.kind === 'write'
        ? write(matched.key, matched.digest, request, env)
        : writeNamed(matched.key, matched.immutable, matched.scope, request, env)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } })

    const headers = { 'cache-control': cacheControl(matched) }
    if (matched.kind === 'download') {
      const lookup = await readableMap(env)
      const key = lookup?.readable.get(matched.readable)
      return key === undefined ? notFound() : serve(key, request, env, headers)
    }
    return serve(matched.key, request, env, headers)
  },
} satisfies ExportedHandler<Env>
