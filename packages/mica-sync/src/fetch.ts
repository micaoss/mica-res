// Every read of a producer's state is anonymous, exactly as a consumer reads it.

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  // A reset socket or a 429 is "ask again", not "this does not exist": the
  // same split as everywhere else -- retry what means later, refuse what
  // means no.
  const waits = [2_000, 6_000, 18_000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers })
      if (response.status === 429 || response.status >= 500)
        throw new Error(`${response.status} ${response.statusText} for ${url}`)
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText} for ${url}`)
      return await response.text()
    }
    catch (error) {
      const wait = waits[attempt]
      const text = error instanceof Error ? error.message : String(error)
      const transient = /ECONNRESET|socket connection|fetch failed|429|5\d\d /.test(text)
      if (wait === undefined || !transient)
        throw error
      await Bun.sleep(wait)
    }
  }
}

// The same policy where a 404 is a real answer the caller must see -- a
// release whose assets are still attaching, a repository that keeps no pins.
// A reset socket is still "ask again", so the caller does not have to choose
// between handling absence and surviving a transient: raw `fetch` in a walk
// gave up an entire enumeration on one ECONNRESET.
export async function fetchAllowing404(url: string, headers: Record<string, string> = {}, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const waits = [2_000, 6_000, 18_000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(url, { headers })
      if (response.status === 404)
        return undefined
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText} for ${url}`)
      return await response.text()
    }
    catch (error) {
      const wait = waits[attempt]
      const text = error instanceof Error ? error.message : String(error)
      const transient = /ECONNRESET|socket connection|fetch failed|429|5\d\d /.test(text)
      if (wait === undefined || !transient)
        throw error
      await Bun.sleep(wait)
    }
  }
}

export async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return JSON.parse(await fetchText(url, headers)) as T
}

export function rawUrl(repository: string, path: string, ref = 'main'): string {
  return `https://raw.githubusercontent.com/micaoss/${repository}/${ref}/${path}`
}

export function githubHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN']
  return token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }
}
