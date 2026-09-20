// Reader for `mica-lock v1` (mica:docs/design/release-lock.md). It validates
// only what mica-res consumes -- the third-party rows -- and accepts the other
// kinds unread, so a producer adding a row of its own does not break the sync.

export interface Row {
  kind: string
  fields: string[]
}

export interface Lock {
  rows: Row[]
}

export interface SourceRow {
  name: string
  arch: string
  version: string
  sha256: string
  url: string
}

export interface UpstreamRow extends SourceRow {
  package: string
}

export interface GitRow {
  name: string
  url: string
  ref: string
  commit: string
}

const KINDS = new Set([
  'release', 'image', 'pool', 'package', 'board', 'upstream', 'apt',
  'input', 'origin', 'built', 'index', 'product', 'bundle', 'asset',
  'source',
  // `data <name> <file> <sha256>`: one producer-data release asset (spec
  // 1.2.4, user 2026-09-20). The spec is explicit about what a reader that
  // does not understand a `data` row may assume -- that the file exists in
  // that release and hashes to that value, that it is needed for nothing, and
  // that skipping it is always safe -- so this reader validates the row and
  // mirrors nothing. Mirroring producer data is not in the accepted scope; it
  // is a question for the user, and `prunable` counts the rows so the absence
  // is visible rather than assumed.
  'data',
])

// Only the kinds mica-res reads are column-checked.
const COLUMNS: Record<string, number> = { source: 6, upstream: 7, image: 5, git: 5, asset: 6, data: 4 }

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/

function refuse(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`)
}

export function parseLock(text: string): Lock {
  const lines = text.split('\n')
  if (lines[0] !== '# mica-lock v1')
    refuse('header', 'line 1 is not `# mica-lock v1`')

  const rows: Row[] = []
  for (const line of lines.slice(1)) {
    if (line === '' || line.startsWith('#'))
      continue
    const fields = line.split('\t')
    const kind = fields[0]!
    if (kind !== 'git' && !KINDS.has(kind))
      refuse('kind-unknown', kind)
    const expected = COLUMNS[kind]
    if (expected !== undefined && fields.length !== expected)
      refuse('column-count', `${kind} has ${fields.length} columns, not ${expected}`)
    if ((kind === 'source' || kind === 'upstream') && !SHA256.test(fields[4]!))
      refuse('field-value', `${kind} ${fields[1]} has no lowercase sha256`)
    if (kind === 'asset' && !SHA256.test(fields[5]!))
      refuse('field-value', `asset ${fields[4]} has no lowercase sha256`)
    if (kind === 'data' && !SHA256.test(fields[3]!))
      refuse('field-value', `data ${fields[1]} has no lowercase sha256`)
    if (kind === 'git' && !COMMIT.test(fields[4]!))
      refuse('field-value', `git ${fields[1]} has no commit`)
    rows.push({ kind, fields })
  }
  return { rows }
}

export interface DataRow {
  name: string
  file: string
  sha256: string
}

export function dataRows(lock: Lock): DataRow[] {
  return lock.rows
    .filter(row => row.kind === 'data')
    .map(row => ({ name: row.fields[1]!, file: row.fields[2]!, sha256: row.fields[3]! }))
}

export function sourceRows(lock: Lock): SourceRow[] {
  return lock.rows.filter(row => row.kind === 'source').map(({ fields }) => ({
    name: fields[1]!,
    arch: fields[2]!,
    version: fields[3]!,
    sha256: fields[4]!,
    url: fields[5]!,
  }))
}

export function upstreamRows(lock: Lock): UpstreamRow[] {
  return lock.rows.filter(row => row.kind === 'upstream').map(({ fields }) => ({
    name: fields[1]!,
    arch: fields[2]!,
    version: fields[3]!,
    sha256: fields[4]!,
    url: fields[5]!,
    package: fields[6]!,
  }))
}

export interface AssetRow {
  product: string
  type: string
  kind: string
  file: string
  sha256: string
}

export function assetRows(lock: Lock): AssetRow[] {
  return lock.rows.filter(row => row.kind === 'asset').map(({ fields }) => ({
    product: fields[1]!,
    type: fields[2]!,
    kind: fields[3]!,
    file: fields[4]!,
    sha256: fields[5]!,
  }))
}

export function gitRows(lock: Lock): GitRow[] {
  return lock.rows.filter(row => row.kind === 'git').map(({ fields }) => ({
    name: fields[1]!,
    url: fields[2]!,
    ref: fields[3]!,
    commit: fields[4]!,
  }))
}
