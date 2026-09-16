// The routing and the write rules of res.micaos.dev, kept pure so they are
// tested without Cloudflare. The bucket is private; these routes are its only
// public surface, and none of them deletes anything.

const SHA256 = /^[0-9a-f]{64}$/
const STAMP = /^[0-9]{8}-[0-9]{4}$/

export type Route
  = | { kind: 'blob', key: string }
    | { kind: 'index', key: string, immutable: boolean }
    | { kind: 'download', readable: string }
    | { kind: 'site', key: string }
    | { kind: 'write', key: string, digest: string }
    | { kind: 'not-found' }

const SITE: Record<string, string> = {
  '/': 'site/index.html',
  '/upstream': 'site/upstream.html',
}

export function route(pathname: string): Route {
  const site = SITE[pathname]
  if (site !== undefined)
    return { kind: 'site', key: site }

  const blob = /^\/blob\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(pathname)
  if (blob)
    return blob[2]!.startsWith(blob[1]!) ? { kind: 'blob', key: `blob/${blob[1]}/${blob[2]}` } : { kind: 'not-found' }

  if (pathname === '/index/current.json')
    return { kind: 'index', key: 'index/current.json', immutable: false }

  const snapshot = /^\/index\/([0-9-]+)\.json$/.exec(pathname)
  if (snapshot)
    return STAMP.test(snapshot[1]!) ? { kind: 'index', key: `index/${snapshot[1]}.json`, immutable: true } : { kind: 'not-found' }

  if (pathname.startsWith('/d/') && !pathname.includes('..'))
    return { kind: 'download', readable: pathname }

  const write = /^\/w\/blob\/([0-9a-f]{64})$/.exec(pathname)
  if (write) {
    const digest = write[1]!
    return { kind: 'write', key: `blob/${digest.slice(0, 2)}/${digest}`, digest }
  }

  return { kind: 'not-found' }
}

export function cacheControl(matched: Route): string {
  switch (matched.kind) {
    case 'blob':
    case 'download':
      return 'public, max-age=31536000, immutable'
    case 'index':
      return matched.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60, must-revalidate'
    case 'site':
      return 'public, max-age=300'
    default:
      return 'no-store'
  }
}

// A write may only create the object whose key is its own sha256. A stolen
// write token can therefore add a blob nobody references, and nothing else.
export function writeDecision(input: { digest: string, bodyDigest: string, existing: string | null }): { status: 200 | 400 | 409, reason: string } {
  if (!SHA256.test(input.digest) || input.digest !== input.bodyDigest)
    return { status: 400, reason: 'key-not-digest' }
  if (input.existing === null)
    return { status: 200, reason: 'stored' }
  return input.existing === input.bodyDigest
    ? { status: 200, reason: 'exists-identical' }
    : { status: 409, reason: 'exists-different' }
}
