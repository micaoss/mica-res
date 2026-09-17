// The published invariant check, from outside the writer: it reads what the
// edge publishes (the site document and the JSON directory listings) and what
// the download host serves, neither of which this process produced, and
// refuses on any disagreement.
//
// It shares no code with the enumerator or the publisher on purpose. Every
// defect this service has produced was the writer being confidently wrong,
// and a writer cannot catch an error in its own model of the world.

export interface SiteNamespace {
  name: string
  visibility: string
  listable: boolean
  objects: number | null
}

export interface ListedObject {
  key: string
  size: number
  sha256: string
}

interface Listing {
  directories: { path: string }[]
  objects: { path: string, size: number, sha256: string }[]
  next: string | null
}

const SHA256 = /^[0-9a-f]{64}$/

async function json<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const answer = await fetcher(url, { headers: { accept: 'application/json' } })
  if (!answer.ok)
    throw new Error(`${answer.status} for ${url}`)
  return answer.json() as Promise<T>
}

/** Every object of a public namespace, walking its directory listings. */
export async function walkNamespace(home: string, namespace: string, fetcher: typeof fetch = fetch): Promise<ListedObject[]> {
  const found: ListedObject[] = []
  const pending = ['']
  while (pending.length > 0) {
    const prefix = pending.shift()!
    let after: string | null = null
    do {
      const url: string = `${home}/${namespace}/${prefix.split('/').map(encodeURIComponent).join('/')}${after === null ? '' : `?after=${encodeURIComponent(after)}`}`
      const page: Listing = await json<Listing>(fetcher, url)
      for (const directory of page.directories)
        pending.push(directory.path)
      for (const object of page.objects)
        found.push({ key: `${namespace}/${object.path}`, size: object.size, sha256: object.sha256 })
      after = page.next
    } while (after !== null)
  }
  return found
}

/** Problems in what the listings state, before any byte is looked at. */
export function checkListing(namespace: SiteNamespace, objects: ListedObject[]): string[] {
  const problems: string[] = []
  if (namespace.objects !== null && namespace.objects !== objects.length)
    problems.push(`${namespace.name}: the site document counts ${namespace.objects} objects and the listings hold ${objects.length}`)
  const seen = new Set<string>()
  for (const object of objects) {
    if (!SHA256.test(object.sha256))
      problems.push(`${object.key}: ${object.sha256} is not a sha256`)
    if (seen.has(object.key))
      problems.push(`${object.key}: listed twice`)
    seen.add(object.key)
  }
  return problems
}

/** HEAD every object on the download host and compare its length. */
export async function checkBytes(download: string, objects: ListedObject[], fetcher: typeof fetch = fetch, concurrency = 8): Promise<string[]> {
  const problems: string[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, objects.length) }, async () => {
    for (;;) {
      const object = objects[next++]
      if (object === undefined)
        return
      const url = `${download}/${object.key.split('/').map(encodeURIComponent).join('/')}`
      const answer = await fetcher(url, { method: 'HEAD' })
      if (!answer.ok)
        problems.push(`${object.key}: ${answer.status} from the download host`)
      else if (answer.headers.get('content-length') !== String(object.size))
        problems.push(`${object.key}: the download host serves ${answer.headers.get('content-length')} bytes, the catalog says ${object.size}`)
    }
  }))
  return problems
}
