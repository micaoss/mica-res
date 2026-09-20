// The refusal that retires itself.
//
// A retention decision is safe only where something other than ghcr holds the
// bytes. That condition is computable -- `coverage` reads it off the published
// index -- so it does not have to be a sentence in a record that someone must
// remember to read at the right moment: a candidate whose artefact nothing
// mirrors is refused here, and the refusal disappears on its own the day the
// mirror covers that artefact. Nobody has to notice that the reason ended.
//
// The tag families are the ones the org's packages actually carry, read from
// ghcr rather than assumed. An unrecognised family is a REFUSAL: a classifier
// that cannot place a candidate has not established that it is safe to delete.

import { poolsCovered } from './coverage.ts'
import type { Coverage } from './coverage.ts'

export type Artefact = 'pool' | 'rootfs' | 'board-component' | 'build-env-image' | 'product-oci'

export interface Candidate {
  package: string
  tag: string
}

export interface Verdict {
  candidate: string
  artefact: Artefact | undefined
  release: string | undefined
  allowed: boolean
  reason: string
  retiresWhen: string
}

const STAMP = '[0-9]{8}-[0-9]{4}'
const FAMILIES: { pattern: RegExp, artefact: Artefact }[] = [
  { pattern: new RegExp(`^pool\\.(?:[a-z0-9-]+\\.)?(?:amd64|arm64)\\.(${STAMP})$`), artefact: 'pool' },
  { pattern: new RegExp(`^rootfs\\.(${STAMP})$`), artefact: 'rootfs' },
  { pattern: new RegExp(`^(?:board|kernel|uboot|firmware)\\.[a-z0-9-]+\\.(${STAMP})$`), artefact: 'board-component' },
  { pattern: new RegExp(`^(?:base|bsp|c|go|rust)(?:\\.(?:amd64|arm64))?\\.(${STAMP})$`), artefact: 'build-env-image' },
  { pattern: new RegExp(`^(?:image|update)\\.[a-z0-9-]+\\.(${STAMP})$`), artefact: 'product-oci' },
]

export function classify(tag: string): { artefact: Artefact, release: string } | undefined {
  for (const family of FAMILIES) {
    const match = family.pattern.exec(tag)
    if (match !== null)
      return { artefact: family.artefact, release: match[1]! }
  }
  return undefined
}

export function parseCandidate(text: string): Candidate {
  const match = /^(?:ghcr\.io\/)?([a-z0-9-]+\/[a-z0-9-]+):(\S+)$/.exec(text.trim())
  if (match === null)
    throw new Error(`candidate-form: ${text} is not <owner>/<package>:<tag>`)
  return { package: match[1]!, tag: match[2]! }
}

export function verdict(candidate: Candidate, coverage: Coverage, imageReleases: Set<string>): Verdict {
  const name = `${candidate.package}:${candidate.tag}`
  const placed = classify(candidate.tag)
  if (placed === undefined) {
    return {
      candidate: name,
      artefact: undefined,
      release: undefined,
      allowed: false,
      reason: 'tag-unknown: no published tag family matches, so nothing here establishes that another copy exists',
      retiresWhen: 'the family is added to FAMILIES with the coverage that applies to it',
    }
  }
  if (placed.artefact === 'build-env-image') {
    const held = imageReleases.has(placed.release)
    return {
      candidate: name,
      artefact: placed.artefact,
      release: placed.release,
      allowed: held,
      reason: held
        ? `the mirror holds the blobs of build-env ${placed.release}`
        : `the mirror holds no blob pinned to build-env ${placed.release}`,
      retiresWhen: held ? 'it does not refuse' : `an image row pins build-env ${placed.release}`,
    }
  }
  if (placed.artefact === 'product-oci') {
    return {
      candidate: name,
      artefact: placed.artefact,
      release: placed.release,
      allowed: false,
      reason: 'the mirror holds this release\'s .img.gz and .micaupd ASSETS, never these OCI bytes -- whether the OCI form is needed is the user\'s call, not this check\'s',
      retiresWhen: 'an image row pins the product images of that release',
    }
  }
  // The self-retiring part: the condition is read off the index every run, so
  // the day a `package` or `pool` row exists this stops refusing without an
  // edit here and without anyone remembering that the reason ended.
  const covered = poolsCovered(coverage)
  return {
    candidate: name,
    artefact: placed.artefact,
    release: placed.release,
    allowed: covered,
    reason: covered
      ? 'a `package` or `pool` row names pool bytes, so ghcr is no longer the only copy'
      : 'ghcr holds the only copy: out of the accepted scope of 2026-09-16 ("not to be re-added")',
    retiresWhen: covered ? 'it does not refuse' : 'the index carries a `package` or `pool` row, which `poolsCovered()` reports',
  }
}

export function guard(candidates: Candidate[], coverage: Coverage, imageReleases: Set<string>): Verdict[] {
  return candidates.map(candidate => verdict(candidate, coverage, imageReleases))
}
