// What the mirror holds, read from the service's own record of it.
//
// The index document (`mica/resource-index/v1`) is a RENDERING of this, and a
// rendering can be behind the thing: the published one sat four days stale
// while `coverage` and the guard believed it, because the service moved to
// namespaces and objects and the client kept reading v1. So these two read the
// catalogue, the way `reconcile` and `audit` already do, and there is nothing
// left to be stale.
//
// The object carries everything they need -- the publisher writes `kind`,
// `origin`, `commit` and `pins` as metadata (`objectMeta`) and the v1 import
// carried the same fields over unchanged. The one index field with no
// equivalent here is `state: pending`, and that is the point rather than a
// gap: a pinned object the bucket does not hold is not in the catalogue, and a
// question about what the mirror HOLDS must not be answerable by something it
// merely intends to hold.

import { listCatalogue } from './publish.ts'
import type { CatalogueRow, Publisher } from './publish.ts'
import type { Pin, ResourceObject } from './objects.ts'

// Namespaces that no producer lock names: the collector's output and the
// repository's own assets. The same exclusion `reconcile` makes.
export const OURS = new Set(['status', 'brand', 'docs'])

function refuse(rule: string, detail: string): never {
  throw new Error(`${rule}: ${detail}`)
}

export function objectFromRow(namespace: string, row: CatalogueRow): ResourceObject {
  const meta = row.meta ?? {}
  const kind = meta['kind']
  // An object of unknown kind would be counted as "held" by a coverage answer
  // that cannot say what it is. Refused rather than bucketed as "other": a
  // retention decision reads these counts.
  if (kind === undefined)
    refuse('meta-kind', `${namespace}/${row.path} carries no kind in its metadata`)
  const pins = meta['pins'] === undefined ? [] : JSON.parse(meta['pins']) as Pin[]
  return {
    kind: kind as ResourceObject['kind'],
    state: 'mirrored',
    sha256: row.sha256,
    size: row.size,
    ...(meta['commit'] === undefined ? {} : { commit: meta['commit'] }),
    ...(meta['origin'] === undefined ? {} : { origin: meta['origin'] }),
    readable: [`${namespace}/${row.path}`],
    pins,
  }
}

export interface Catalogue {
  objects: ResourceObject[]
  namespaces: string[]
  // Rows the reader cannot describe. Reported rather than thrown, because the
  // reader is shared: refusing inside it blocked the very command that repairs
  // the row it refused on. Each caller decides whether it can answer with
  // these outstanding -- a report can, a gate that would ALLOW a deletion
  // cannot.
  unusable: { key: string, why: string }[]
}

export async function readCatalogue(publisher: Publisher, namespaces: string[]): Promise<Catalogue> {
  const objects: ResourceObject[] = []
  const walked: string[] = []
  const unusable: { key: string, why: string }[] = []
  for (const namespace of namespaces.filter(name => !OURS.has(name))) {
    walked.push(namespace)
    for (const row of await listCatalogue(publisher, namespace)) {
      try {
        objects.push(objectFromRow(namespace, row))
      }
      catch (error) {
        unusable.push({ key: `${namespace}/${row.path}`, why: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { objects, namespaces: walked, unusable }
}
