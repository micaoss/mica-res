// Who reads a thing, with the space that was searched printed beside the
// answer.
//
// "7 readers" is a number; "7 readers across every file in every checked-out
// repository, excluding node_modules, .git, _out, repos and tmp" is a number
// AND its aperture, and the second cannot be quoted without its boundary
// because the boundary is in the sentence. This exists because the rule did
// not hold on its own: the same author who recorded "a file-type search space
// is an aperture" passed `--include` for four extensions the next day and
// under-counted the readers of the index document. A format survives its
// author; a rule waits for them to remember it.

export const EXCLUDED = ['node_modules', '.git', '_out', 'repos', 'tmp']

export interface Hit {
  file: string
  line: number
  text: string
}

export function searchSpace(root: string, excluded: readonly string[] = EXCLUDED): string {
  return `search space: ${root}, every file, excluding ${excluded.join(', ')}`
}

// What the root actually contained, so the aperture is RECONSTRUCTABLE rather
// than merely acknowledged: "repositories not checked out here are outside it"
// tells a reader there is a boundary, not where it ran. A reader in December
// cannot otherwise know which repositories were in the workspace tonight -- and
// for a sweep that finds nothing, this list is the entire evidence.
export function rootsLine(names: readonly string[]): string {
  const sorted = [...names].sort()
  return `  searched ${sorted.length} top-level director${sorted.length === 1 ? 'y' : 'ies'}: ${sorted.join(', ') || '(none)'}`
}

export async function rootsOf(root: string, excluded: readonly string[] = EXCLUDED): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory() && !excluded.includes(entry.name)).map(entry => entry.name)
}

// The boundary travels with the count, in the same sentence, always -- a
// reader who quotes the number quotes the limit with it.
export function verdict(needle: string, hits: Hit[]): string {
  const files = new Set(hits.map(hit => hit.file)).size
  return `${hits.length} hit(s) for ${needle} in ${files} file(s) -- inside this space only; `
    + 'repositories not checked out here, anything on a device, local scripts and third parties are outside it'
}

export function parseGrep(output: string): Hit[] {
  return output.split('\n').filter(line => line.length > 0).flatMap((line) => {
    const match = /^([^:]+):([0-9]+):(.*)$/.exec(line)
    return match === null ? [] : [{ file: match[1]!, line: Number(match[2]), text: match[3]!.trim() }]
  })
}

export async function sweep(root: string, needle: string): Promise<Hit[]> {
  const args = ['grep', '-rIn', ...EXCLUDED.flatMap(name => ['--exclude-dir', name]), '--', needle, root]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(proc.stdout).text()
  const status = await proc.exited
  // grep exits 1 for "no match", which is an answer; anything above that is a
  // failure and must not read as an empty result.
  if (status > 1)
    throw new Error(`grep: exit ${status} ${(await new Response(proc.stderr).text()).slice(0, 200)}`)
  return parseGrep(output)
}
