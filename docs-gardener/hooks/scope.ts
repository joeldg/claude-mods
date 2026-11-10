/** Folders never gardened, wherever they sit in the tree. */
export const EXCLUDED_DIRS: readonly string[] = ['node_modules', 'third_party', 'vendor', '.venv', 'venv', 'site-packages', 'dist', 'build', '.git']

/** Docs nothing needs to link to: never orphans. */
export const ENTRY_DOCS: ReadonlySet<string> = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md'])

/** The `excludeGlobs` option: a comma- or newline-separated string, or a list of globs. */
export function parseGlobs(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/[,\n]/) : []
  return parts.map(part => part.trim()).filter(part => part.length > 0)
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A gitignore-style glob over a root-relative path: `**` spans folders, `*` and `?` stay within one, a bare
 * name matches at any depth, and a trailing `/` names a folder with everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.replace(/^\.\//, '')
  const isFolder = pattern.endsWith('/')
  pattern = pattern.replace(/\/+$/, '')
  const isAnywhere = !pattern.includes('/')
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(char)
    }
  }
  return new RegExp(`^${isAnywhere ? '(?:.*/)?' : ''}${out}${isFolder ? '(?:/.*)?' : ''}$`)
}

/** True when the path sits under an excluded folder, or it or one of its folders matches an exclude glob. */
export function isExcluded(rel: string, excludeGlobs: readonly string[]): boolean {
  const segments = rel.split('/')
  const folders = segments.slice(0, -1)
  if (folders.some(segment => EXCLUDED_DIRS.includes(segment))) {
    return true
  }
  if (excludeGlobs.length === 0) {
    return false
  }
  const candidates = [rel, ...folders.map((_, i) => folders.slice(0, i + 1).join('/'))]
  return excludeGlobs.map(globToRegExp).some(pattern => candidates.some(candidate => pattern.test(candidate)))
}

export const isDoc = (rel: string): boolean => /\.md$/i.test(rel)

/** A markdown file under the root that nothing excludes. */
export const inScope = (rel: string, excludeGlobs: readonly string[]): boolean => isDoc(rel) && !isExcluded(rel, excludeGlobs)

/** `.` and `..` segments resolved, repeated and trailing slashes dropped; a relative path may keep leading `..`. */
export function normalisePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!isAbsolute) {
        out.push('..')
      }
      continue
    }
    out.push(segment)
  }
  return `${isAbsolute ? '/' : ''}${out.join('/')}`
}

export const joinPath = (folder: string, name: string): string => normalisePath(folder ? `${folder}/${name}` : name)

export const folderOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

export const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** A path relative to the root: an absolute one under it, or a relative one as given; null for one outside. */
export function relativeTo(root: string, path: string): string | null {
  const base = normalisePath(root)
  if (!path.startsWith('/')) {
    return normalisePath(path)
  }
  const full = normalisePath(path)
  if (full === base) {
    return ''
  }
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null
}

const excludeArgs = (excludeGlobs: readonly string[]): string[] => [
  ...EXCLUDED_DIRS.flatMap(dir => ['-g', `!${dir}`]),
  ...excludeGlobs.flatMap(glob => ['-g', `!${glob}`]),
]

/** `rg --files` over the markdown of a root, hidden folders included, the exclusions as globs. */
export function rgFilesArgv(root: string, excludeGlobs: readonly string[]): string[] {
  return ['rg', '--files', '-g', '*.md', '--hidden', ...excludeArgs(excludeGlobs), root]
}

/** One `rg` that prints which of the identifiers occur whole-word in the code (anything but markdown). */
export function rgIdentifiersArgv(root: string, identifiers: readonly string[], excludeGlobs: readonly string[]): string[] {
  return [
    'rg',
    '--no-filename',
    '-o',
    '-w',
    '-F',
    '-m',
    '1',
    ...identifiers.flatMap(identifier => ['-e', identifier]),
    '-g',
    '!*.md',
    ...excludeArgs(excludeGlobs),
    root,
  ]
}

const DATED = /(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?:[^0-9]|$)/

/** The `yyyy-mm-dd` a file name carries, or null. */
export const datedName = (name: string): string | null => DATED.exec(name)?.[1] ?? null

const DAY_MS = 86_400_000

/** The ISO week of a time, `2026-42`, the year being the ISO week-year. */
export function isoWeek(now: number): string {
  const date = new Date(now)
  const weekday = (date.getUTCDay() + 6) % 7
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday + 3)
  const year = new Date(thursday).getUTCFullYear()
  const fourth = new Date(Date.UTC(year, 0, 4))
  const week1Monday = Date.UTC(year, 0, 4 - ((fourth.getUTCDay() + 6) % 7))
  const monday = thursday - 3 * DAY_MS
  const week = 1 + Math.round((monday - week1Monday) / (7 * DAY_MS))
  return `${year}-${String(week).padStart(2, '0')}`
}

/** Where a folder's roll-up goes: `<folder>/ROLLUP-<iso week>.md`. */
export const rollupPath = (folder: string, now: number): string => joinPath(folder.replace(/\/$/, ''), `ROLLUP-${isoWeek(now)}.md`)
