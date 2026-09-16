// `mica/resource-index/v1`: the derived catalogue of what the bucket holds.
// Canonical JSON, immutable snapshots, one `current` pointer. No build reads it
// to decide trust -- verification stays each consumer's own lock.

import type { Kind, Pin, ResourceObject, State } from './objects.ts'

export const SCHEMA = 'mica/resource-index/v1'

export interface IndexDocument {
  schema: string
  version: string
  previous?: { version: string, sha256: string }
  objects: ResourceObject[]
}

const STAMP = /^[0-9]{8}-[0-9]{4}$/
const SHA256 = /^[0-9a-f]{64}$/
const KINDS: Kind[] = ['deb', 'source', 'oci-blob', 'product-image', 'update-archive', 'git-pack']
const STATES: State[] = ['mirrored', 'pending']

function refuse(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`)
}

function canonicalPin(pin: Pin): Pin {
  return { repository: pin.repository, lock: pin.lock, release: pin.release, row: pin.row }
}

// The member order here is the canonical order of the document.
function canonicalObject(object: ResourceObject): ResourceObject {
  return {
    kind: object.kind,
    state: object.state ?? 'pending',
    sha256: object.sha256,
    ...(object.size === undefined ? {} : { size: object.size }),
    ...(object.origin === undefined ? {} : { origin: object.origin }),
    path: object.path,
    readable: [...object.readable].sort(),
    pins: [...object.pins]
      .map(canonicalPin)
      .sort((a, b) => `${a.repository}\t${a.lock}\t${a.row}`.localeCompare(`${b.repository}\t${b.lock}\t${b.row}`)),
  }
}

export function buildIndex(input: { version: string, objects: ResourceObject[], previous?: { version: string, sha256: string } }): IndexDocument {
  if (!STAMP.test(input.version))
    refuse('version', `${input.version} is not a YYYYMMDD-HHMM stamp`)
  return {
    schema: SCHEMA,
    version: input.version,
    ...(input.previous === undefined ? {} : { previous: input.previous }),
    objects: input.objects
      .map(canonicalObject)
      .sort((a, b) => a.sha256.localeCompare(b.sha256)),
  }
}

export function renderIndex(document: IndexDocument): string {
  return `${JSON.stringify(document)}\n`
}

export function readIndex(text: string): IndexDocument {
  if (!text.endsWith('\n'))
    refuse('encoding', 'the document has no final LF')
  const document = JSON.parse(text) as IndexDocument
  if (document.schema !== SCHEMA)
    refuse('schema', `${document.schema} is not ${SCHEMA}`)
  if (!STAMP.test(document.version))
    refuse('version', `${document.version} is not a YYYYMMDD-HHMM stamp`)

  const seen = new Set<string>()
  let previous = ''
  for (const object of document.objects) {
    if (!SHA256.test(object.sha256))
      refuse('field-value', `${object.sha256} is not a lowercase sha256`)
    if (!KINDS.includes(object.kind))
      refuse('kind-unknown', object.kind)
    if (object.state === undefined || !STATES.includes(object.state))
      refuse('field-value', `${object.sha256} has state ${String(object.state)}`)
    if (object.path !== `blob/${object.sha256.slice(0, 2)}/${object.sha256}`)
      refuse('field-value', `${object.path} is not the blob path of ${object.sha256}`)
    if (seen.has(object.sha256))
      refuse('duplicate-object', object.sha256)
    if (object.sha256 < previous)
      refuse('sort-order', `${object.sha256} follows ${previous}`)
    seen.add(object.sha256)
    previous = object.sha256
  }
  return document
}

export function summarise(objects: ResourceObject[]): { kind: Kind, count: number, bytes: number, sizesUnknown: number, mirrored: number, mirroredBytes: number }[] {
  return KINDS.map((kind) => {
    const of = objects.filter(object => object.kind === kind)
    const mirrored = of.filter(object => object.state === 'mirrored')
    return {
      kind,
      count: of.length,
      bytes: of.reduce((total, object) => total + (object.size ?? 0), 0),
      sizesUnknown: of.filter(object => object.size === undefined).length,
      mirrored: mirrored.length,
      mirroredBytes: mirrored.reduce((total, object) => total + (object.size ?? 0), 0),
    }
  }).filter(row => row.count > 0)
}

export interface Pointer {
  schema: string
  version: string
  sha256: string
}

export const POINTER_SCHEMA = 'mica/resource-index-pointer/v1'

export function renderPointer(pointer: { version: string, sha256: string }): string {
  if (!STAMP.test(pointer.version))
    refuse('version', `${pointer.version} is not a YYYYMMDD-HHMM stamp`)
  return `${JSON.stringify({ schema: POINTER_SCHEMA, version: pointer.version, sha256: pointer.sha256 })}\n`
}

export function readPointer(text: string): Pointer {
  const pointer = JSON.parse(text) as Pointer
  if (pointer.schema !== POINTER_SCHEMA)
    refuse('schema', `${pointer.schema} is not ${POINTER_SCHEMA}`)
  if (!STAMP.test(pointer.version) || !SHA256.test(pointer.sha256))
    refuse('field-value', 'the pointer names no snapshot')
  return pointer
}
