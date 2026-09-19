// How a red default branch reaches a person.
//
// A page nobody opens fails the same way the last two days failed, so the
// collector opens a GitHub issue in this repository, keeps ONE issue updated
// while anything is red, and closes it when everything is green. Watchers are
// notified by GitHub; no new channel, no new credential -- the workflow token
// is enough.

import { githubHeaders } from './fetch.ts'
import type { Health } from './health.ts'
import { issueBody } from './health.ts'

/** In the title, so the collector finds its own issue without a label. */
export const MARKER = 'CI health: default branch failing'

export interface OpenIssue {
  number: number
  title: string
  body: string
}

export type Action
  = | { kind: 'create', title: string, body: string }
    | { kind: 'update', number: number, title: string, body: string }
    | { kind: 'close', number: number }
    | { kind: 'none' }

export function decide(red: Health[], open: OpenIssue | undefined, now: number): Action {
  if (red.length === 0)
    return open === undefined ? { kind: 'none' } : { kind: 'close', number: open.number }

  const title = `${MARKER}: ${red.map(one => one.repository).join(', ')}`
  const body = issueBody(red, now)
  if (open === undefined)
    return { kind: 'create', title, body }
  // Rewriting the same body every half hour would be noise; the title carries
  // the repository set, and the body carries the ages, so it is updated only
  // when either changed.
  return open.title === title && open.body === body ? { kind: 'none' } : { kind: 'update', number: open.number, title, body }
}

const API = 'https://api.github.com/repos/micaoss/mica-res/issues'

export async function openIssue(): Promise<OpenIssue | undefined> {
  const answer = await fetch(`${API}?state=open&per_page=100`, { headers: githubHeaders() })
  if (!answer.ok)
    throw new Error(`issues: ${answer.status}`)
  const issues = await answer.json() as { number: number, title: string, body: string | null, pull_request?: unknown }[]
  const found = issues.find(issue => issue.pull_request === undefined && issue.title.startsWith(MARKER))
  return found === undefined ? undefined : { number: found.number, title: found.title, body: found.body ?? '' }
}

export async function apply(action: Action): Promise<string> {
  const headers = { ...githubHeaders(), 'content-type': 'application/json' }
  if (action.kind === 'none')
    return 'nothing to announce'
  if (action.kind === 'create') {
    const answer = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ title: action.title, body: action.body }) })
    if (!answer.ok)
      throw new Error(`issue create: ${answer.status} ${(await answer.text()).slice(0, 200)}`)
    return `opened issue #${(await answer.json() as { number: number }).number}`
  }
  if (action.kind === 'update') {
    const answer = await fetch(`${API}/${action.number}`, { method: 'PATCH', headers, body: JSON.stringify({ title: action.title, body: action.body }) })
    if (!answer.ok)
      throw new Error(`issue update: ${answer.status}`)
    return `updated issue #${action.number}`
  }
  await fetch(`${API}/${action.number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body: 'Every default branch is green again; closed by the collector.' }) })
  const answer = await fetch(`${API}/${action.number}`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'closed' }) })
  if (!answer.ok)
    throw new Error(`issue close: ${answer.status}`)
  return `closed issue #${action.number}`
}
