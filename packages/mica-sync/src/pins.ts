// `mica-pin v1`, and the lock objects a pin makes verifiable.
//
// The point of mirroring a lock is NOT that a copy exists: it is that the
// consumer's own pin states the sha256 of the release's `SHA256SUMS`, that
// file states the sha256 of the lock, and the publisher refuses bytes whose
// digest does not match the key. So the chain a consumer verifies --
// pin -> SHA256SUMS -> lock -> the rows inside it -- is checked here before
// anything is published, and a mirrored lock that disagrees with the pin
// cannot enter the bucket. Mirroring the BYTES would have been a copy; this
// is a verification.

import type { ResourceObject } from './objects.ts'

export interface Pin {
  repository: string
  scope?: string
  release: string
  sha256sums: string
}

const SHA256 = /^[0-9a-f]{64}$/
const STAMP = /^[0-9]{8}-[0-9]{4}$/

function refuse(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`)
}

export function parsePin(text: string): Pin {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  if (lines[0] !== '# mica-pin v1')
    refuse('header', `${lines[0] ?? '(empty)'} is not "# mica-pin v1"`)
  const fields = new Map(lines.slice(1).filter(line => !line.startsWith('#')).map((line) => {
    const equals = line.indexOf('=')
    if (equals < 1)
      refuse('field-form', `${line} is not KEY=VALUE`)
    return [line.slice(0, equals), line.slice(equals + 1)]
  }))
  const repository = fields.get('REPOSITORY')
  const release = fields.get('RELEASE')
  const sha256sums = fields.get('SHA256SUMS')
  if (repository === undefined || release === undefined || sha256sums === undefined)
    refuse('field-missing', `a pin states REPOSITORY, RELEASE and SHA256SUMS; got ${[...fields.keys()].join(', ')}`)
  if (!STAMP.test(release))
    refuse('field-value', `RELEASE=${release} is not a YYYYMMDD-HHMM stamp`)
  if (!SHA256.test(sha256sums))
    refuse('field-value', `SHA256SUMS=${sha256sums} is not a sha256`)
  const scope = fields.get('SCOPE')
  return scope === undefined ? { repository, release, sha256sums } : { repository, scope, release, sha256sums }
}

// The release tag the pin names: scoped producers carry their scope, separated
// by a dot since 2026-09-16.
export function tagOf(pin: Pin): string {
  return pin.scope === undefined ? pin.release : `${pin.scope}.${pin.release}`
}

export function sumsDigest(text: string, file: string): string {
  const row = text.split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(fields => fields[1]?.replace(/^\*/, '') === file)
  if (row === undefined)
    refuse('sums-entry', `SHA256SUMS lists no ${file}`)
  if (!SHA256.test(row[0]!))
    refuse('field-value', `${row[0]} is not a sha256`)
  return row[0]!
}

function asset(repository: string, tag: string, file: string): string {
  return `https://github.com/micaoss/${repository}/releases/download/${tag}/${file}`
}

// Two objects per pinned release: the `SHA256SUMS` the pin names by digest,
// and the lock that file names by digest. `lock/` keeps them out of the
// product-scope space of the `mica` namespace, where a scope is a board or a
// product and never a repository.
export function lockObjects(holder: { repository: string, pin: string }, pin: Pin, sumsText: string): ResourceObject[] {
  const digest = Bun.SHA256.hash(sumsText, 'hex')
  if (digest !== pin.sha256sums)
    refuse('pin-digest', `${holder.repository}:${holder.pin} pins SHA256SUMS ${pin.sha256sums} and the release serves ${digest}`)
  const tag = tagOf(pin)
  const lock = `${pin.repository}.lock`
  const record = { repository: holder.repository, lock: holder.pin, release: tag }
  return [
    {
      kind: 'lock',
      sha256: digest,
      size: Buffer.byteLength(sumsText),
      origin: asset(pin.repository, tag, 'SHA256SUMS'),
      readable: [`mica/lock/${pin.repository}/${tag}/SHA256SUMS`],
      pins: [{ ...record, row: `lock ${pin.repository} ${tag} SHA256SUMS` }],
    },
    {
      kind: 'lock',
      sha256: sumsDigest(sumsText, lock),
      origin: asset(pin.repository, tag, lock),
      readable: [`mica/lock/${pin.repository}/${tag}/${lock}`],
      pins: [{ ...record, row: `lock ${pin.repository} ${tag} ${lock}` }],
    },
  ]
}
