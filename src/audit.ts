// The published invariant check: it reads the PUBLISHED index and the BUCKET,
// neither of which it produced, and asserts they agree in both directions.
//
// It shares no code with the enumerator on purpose. Every defect this service
// has produced was the writer being confidently wrong -- state taken from what
// a run uploaded, an enumeration narrowed by an upload flag, a reader matching
// no releases and calling it empty -- and a writer cannot catch an error in its
// own model of the world, because the model is what is wrong. So this file
// parses the document itself, computes a blob path itself, and imports nothing
// that built the index.

export interface AuditObject {
  kind: string
  sha256: string
  size?: number
  path: string
}

export interface BucketEntry {
  key: string
  size: number
}

export type KeyKind = 'blob' | 'index' | 'site' | 'status' | 'unexpected'

export interface Comparison {
  missing: AuditObject[]
  orphans: BucketEntry[]
  unexpected: string[]
  sizeMismatches: { sha256: string, index: number, bucket: number }[]
}

const SHA256 = /^[0-9a-f]{64}$/

function refuse(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`)
}

export function parsePublished(text: string): AuditObject[] {
  const document = JSON.parse(text) as { schema?: string, version?: string, objects?: AuditObject[] }
  if (document.schema !== 'mica/resource-index/v1')
    refuse('schema', String(document.schema))
  if (document.version === undefined || !/^[0-9]{8}-[0-9]{4}$/.test(document.version))
    refuse('version', String(document.version))
  if (!Array.isArray(document.objects))
    refuse('objects', 'the document names no objects')

  const seen = new Set<string>()
  for (const object of document.objects) {
    if (!SHA256.test(object.sha256))
      refuse('sha256', object.sha256)
    if (object.path !== `blob/${object.sha256.slice(0, 2)}/${object.sha256}`)
      refuse('path', `${object.path} is not the blob path of ${object.sha256}`)
    if (seen.has(object.sha256))
      refuse('duplicate', object.sha256)
    seen.add(object.sha256)
  }
  return document.objects
}

export function classifyKey(key: string): KeyKind {
  if (/^blob\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key))
    return 'blob'
  if (/^index\/(current|[0-9]{8}-[0-9]{4})\.json$/.test(key))
    return 'index'
  if (key.startsWith('site/'))
    return 'site'
  if (key.startsWith('status/'))
    return 'status'
  return 'unexpected'
}

export function compare(objects: AuditObject[], entries: BucketEntry[]): Comparison {
  const held = new Map(entries.filter(entry => classifyKey(entry.key) === 'blob').map(entry => [entry.key, entry.size]))
  const named = new Set(objects.map(object => object.path))

  const missing = objects.filter(object => !held.has(object.path))
  const sizeMismatches = objects.flatMap((object) => {
    const size = held.get(object.path)
    return size === undefined || object.size === undefined || size === object.size
      ? []
      : [{ sha256: object.sha256, index: object.size, bucket: size }]
  })
  // An unreferenced blob is legitimate -- a superseded release leaves its
  // objects behind, because nothing here deletes -- so it is reported and
  // counted, never a refusal.
  const orphans = entries.filter(entry => classifyKey(entry.key) === 'blob' && !named.has(entry.key))
  const unexpected = entries.filter(entry => classifyKey(entry.key) === 'unexpected').map(entry => entry.key)
  return { missing, orphans, unexpected, sizeMismatches }
}
