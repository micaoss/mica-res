// Every read of a producer's state is anonymous, exactly as a consumer reads it.

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers })
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.text()
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
