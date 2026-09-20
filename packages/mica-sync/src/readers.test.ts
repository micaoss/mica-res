import { expect, test } from 'bun:test'
import { parseGrep, rootsLine, searchSpace, verdict } from './readers.ts'

test('the search space names the root and what it skips', () => {
  expect(searchSpace('/srv/ybolab/mica')).toBe(
    'search space: /srv/ybolab/mica, every file, excluding node_modules, .git, _out, repos, tmp')
})

test('the boundary is in the same sentence as the count', () => {
  const line = verdict('index/current.json', [
    { file: 'a.ts', line: 1, text: 'x' },
    { file: 'a.ts', line: 9, text: 'y' },
    { file: 'b.yml', line: 3, text: 'z' },
  ])
  expect(line).toStartWith('3 hit(s) for index/current.json in 2 file(s) --')
  expect(line).toContain('not checked out here')
})

test('a grep line is read as file, line and text', () => {
  expect(parseGrep('/x/y.ts:12:  const a = 1\n')).toEqual([{ file: '/x/y.ts', line: 12, text: 'const a = 1' }])
})

test('the roots line makes the aperture reconstructable, not just acknowledged', () => {
  expect(rootsLine(['mica-res', 'mica', 'mica-build'])).toBe(
    '  searched 3 top-level directories: mica, mica-build, mica-res')
  expect(rootsLine([])).toContain('(none)')
})
