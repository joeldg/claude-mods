import { expect, test } from 'claude-code/testing'

import { DEFAULT_BRANCH_REFS, EXCLUDED_DIRS, datedName, folderOf, globToRegExp, inScope, isoWeek, joinPath, normalisePath, parseGlobs, pickDefaultBranch, relativeTo, rgFilesArgv, rgIdentifiersArgv } from '../hooks/scope'

test('the vendored, built and virtualenv folders are out of scope wherever they sit', async () => {
  expect(EXCLUDED_DIRS).toEqual(['node_modules', 'third_party', 'vendor', '.venv', 'venv', 'site-packages', 'dist', 'build', '.git'])
  for (const dir of EXCLUDED_DIRS) {
    expect(inScope(`${dir}/pkg/README.md`, [])).toBe(false)
    expect(inScope(`apps/web/${dir}/README.md`, [])).toBe(false)
  }
  expect(inScope('.venv/lib/site-packages/y/README.md', [])).toBe(false)
  // A folder that only contains the name is not excluded.
  expect(inScope('builders/README.md', [])).toBe(true)
  expect(inScope('docs/distribution.md', [])).toBe(true)
})

test('markdown anywhere else is in scope, CLAUDE.md and AGENTS.md included; other files are not', async () => {
  expect(inScope('README.md', [])).toBe(true)
  expect(inScope('CLAUDE.md', [])).toBe(true)
  expect(inScope('AGENTS.md', [])).toBe(true)
  expect(inScope('.github/PULL_REQUEST_TEMPLATE.md', [])).toBe(true)
  expect(inScope('docs/notes.MD', [])).toBe(true)
  expect(inScope('src/config.py', [])).toBe(false)
  expect(inScope('docs/notes.markdown', [])).toBe(false)
})

test('excludeGlobs: a folder glob, a bare file name (any folder) and a pattern', async () => {
  const globs = ['docs/generated/**', 'CHANGELOG.md', '*.draft.md', 'archive/']
  expect(inScope('docs/generated/api.md', globs)).toBe(false)
  expect(inScope('docs/generated/deep/api.md', globs)).toBe(false)
  expect(inScope('docs/api.md', globs)).toBe(true)
  expect(inScope('CHANGELOG.md', globs)).toBe(false)
  expect(inScope('packages/a/CHANGELOG.md', globs)).toBe(false)
  expect(inScope('docs/plan.draft.md', globs)).toBe(false)
  expect(inScope('docs/plan.md', globs)).toBe(true)
  expect(inScope('archive/2025.md', globs)).toBe(false)
  expect(inScope('archives/2025.md', globs)).toBe(true)
  expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true)
  expect(globToRegExp('docs/*.md').test('docs/sub/a.md')).toBe(false)
})

test('parseGlobs reads a comma or newline separated string, or a list', async () => {
  expect(parseGlobs('docs/generated/**, CHANGELOG.md\n *.draft.md ,')).toEqual(['docs/generated/**', 'CHANGELOG.md', '*.draft.md'])
  expect(parseGlobs(['a/**', ' b.md '])).toEqual(['a/**', 'b.md'])
  expect(parseGlobs('')).toEqual([])
  expect(parseGlobs(42)).toEqual([])
})

test('paths are normalised, joined from a doc folder, and made relative to the root', async () => {
  expect(normalisePath('./a/../b//c.md')).toBe('b/c.md')
  expect(normalisePath('docs/./x.md')).toBe('docs/x.md')
  expect(joinPath('docs', '../scripts/run.sh')).toBe('scripts/run.sh')
  expect(joinPath('', 'README.md')).toBe('README.md')
  expect(joinPath('docs/sub', './a.md')).toBe('docs/sub/a.md')
  expect(folderOf('docs/sub/a.md')).toBe('docs/sub')
  expect(folderOf('README.md')).toBe('')
  expect(relativeTo('/home/dev/widgets', '/home/dev/widgets/docs/a.md')).toBe('docs/a.md')
  expect(relativeTo('/home/dev/widgets/', '/home/dev/widgets/README.md')).toBe('README.md')
  expect(relativeTo('/home/dev/widgets', '/home/dev/other/a.md')).toBeNull()
  expect(relativeTo('/home/dev/widgets', '/home/dev/widgets-2/a.md')).toBeNull()
  expect(relativeTo('/home/dev/widgets', 'docs/./a.md')).toBe('docs/a.md')
})

test('a dated file name carries one yyyy-mm-dd; the ISO week names a roll-up', async () => {
  expect(datedName('2026-10-07.md')).toBe('2026-10-07')
  expect(datedName('digest-2026-10-07-notes.md')).toBe('2026-10-07')
  expect(datedName('2026-09-plan.md')).toBeNull()
  expect(datedName('v1-2026.md')).toBeNull()
  expect(datedName('notes.md')).toBeNull()
  expect(isoWeek(Date.UTC(2026, 9, 12))).toBe('2026-42')
  expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-53')
  expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-01')
})

test('the rg command lines list markdown with the exclusions, and look identifiers up whole-word in the code', async () => {
  const files = rgFilesArgv('/home/dev/widgets', ['docs/generated/**'])
  expect(files.slice(0, 4)).toEqual(['rg', '--files', '-g', '*.md'])
  expect(files).toContain('!node_modules')
  expect(files).toContain('!.git')
  expect(files).toContain('!docs/generated/**')
  expect(files.at(-1)).toBe('/home/dev/widgets')
  const idents = rgIdentifiersArgv('/home/dev/widgets', ['parse_config', 'load_widgets'], [])
  // Every match is printed (no -m 1: a file naming two identifiers must yield both) and hidden folders are searched.
  expect(idents.slice(0, 6)).toEqual(['rg', '--no-filename', '-o', '-w', '-F', '--hidden'])
  expect(idents).not.toContain('-m')
  expect(idents).toContain('-e')
  expect(idents[idents.indexOf('-e') + 1]).toBe('parse_config')
  expect(idents).toContain('!*.md')
  expect(idents).toContain('!vendor')
  expect(idents.at(-1)).toBe('/home/dev/widgets')
  // Texts looked up anywhere, not whole-word: the stem of `AUTO_NNN`, a folder name a doc mentions.
  const texts = rgIdentifiersArgv('/home/dev/widgets', ['AUTO_'], [], false)
  expect(texts.slice(0, 5)).toEqual(['rg', '--no-filename', '-o', '-F', '--hidden'])
  expect(texts).not.toContain('-w')
})

test('the default branch is picked from one for-each-ref read: origin/HEAD, then origin/main, origin/master, main, master, then the current branch', async () => {
  const rows = (...lines: string[]): string => lines.map(line => `${line}\n`).join('')
  expect(DEFAULT_BRANCH_REFS).toEqual(['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'])
  // origin/HEAD's target wins over every stand-in, whatever its name.
  expect(pickDefaultBranch(rows('refs/heads/main\t', 'refs/remotes/origin/HEAD\trefs/remotes/origin/develop', 'refs/remotes/origin/main\t'), 'feature')).toBe('origin/develop')
  expect(pickDefaultBranch(rows('refs/heads/main\t', 'refs/remotes/origin/main\t', 'refs/remotes/origin/master\t'), 'feature')).toBe('origin/main')
  expect(pickDefaultBranch(rows('refs/heads/main\t', 'refs/remotes/origin/master\t'), 'feature')).toBe('origin/master')
  expect(pickDefaultBranch(rows('refs/heads/main\t', 'refs/heads/master\t'), 'feature')).toBe('main')
  expect(pickDefaultBranch(rows('refs/heads/master\t'), 'feature')).toBe('master')
  // origin/HEAD listed without a target is passed over; neither main nor master: the branch checked out now, or none.
  expect(pickDefaultBranch(rows('refs/remotes/origin/HEAD\t', 'refs/remotes/origin/master\t'), 'feature')).toBe('origin/master')
  expect(pickDefaultBranch(rows(), 'feature')).toBe('feature')
  expect(pickDefaultBranch('', null)).toBeNull()
  expect(pickDefaultBranch(null, 'feature')).toBe('feature')
})
