// res.micaos.dev. The bucket is private and this Worker is its only public
// surface: immutable blobs by digest, the index, readable download paths that
// resolve through the index, the generated site, and one content-addressed
// write endpoint. There is no delete route.

import { readIndex, readPointer } from '../../src/index-doc.ts'
import { cacheControl, route, writeDecision } from './routes.ts'

export interface Env {
  BUCKET: R2Bucket
  WRITE_TOKEN?: string
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

async function write(key: string, digest: string, request: Request, env: Env): Promise<Response> {
  if (env.WRITE_TOKEN === undefined || env.WRITE_TOKEN === '')
    return new Response('write is not configured\n', { status: 503 })
  if (request.headers.get('authorization') !== `Bearer ${env.WRITE_TOKEN}`)
    return new Response('unauthorized\n', { status: 401 })

  const bytes = new Uint8Array(await request.arrayBuffer())
  const bodyDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  const existing = await env.BUCKET.head(key)
  const decision = writeDecision({ digest, bodyDigest, existing: existing === null ? null : digest })
  if (decision.status !== 200)
    return new Response(`${decision.reason}\n`, { status: decision.status })
  if (decision.reason === 'stored')
    await env.BUCKET.put(key, bytes)
  return new Response(`${decision.reason}\n`, { status: 200 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const matched = route(new URL(request.url).pathname)
    if (matched.kind === 'not-found')
      return notFound()

    if (matched.kind === 'write') {
      return request.method === 'PUT'
        ? write(matched.key, matched.digest, request, env)
        : new Response('method not allowed\n', { status: 405, headers: { allow: 'PUT' } })
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
