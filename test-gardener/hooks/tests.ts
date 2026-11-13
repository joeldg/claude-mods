import type { GardenerSettings } from '../types'

export type Language = 'python' | 'js' | 'go' | 'ruby' | 'rust'

/** One test as a file holds it: its name (a Python/Go/Rust function, a JS or Ruby title), its line and its body. */
export type TestUnit = { name: string; line: number; body: string; isParametrized: boolean; isSkipped: boolean }
/** A test as the scan cache keeps it: no body. */
export type TestSummary = Omit<TestUnit, 'body'>
export type TestRef = { file: string; name: string }
export type DuplicateKind = 'clone' | 'near' | 'parametrize'
/** Two tests alike: `a` is the test looked at (the new one), `b` the one it resembles. */
export type Duplicate = { a: TestRef; b: TestRef; similarity: number; kind: DuplicateKind }
/** A test file as the scan knows it. */
export type TestFileInfo = { path: string; mtimeMs: number; module: string | null; imports: string[]; tests: TestSummary[] }
/** A test file covering a module, with its tests. */
export type NeighbourFile = { path: string; count: number; names: string[] }
export type FileTest = { file: string; unit: TestUnit }
export type BranchCount = { tests: number; lines: number }
/** What a write to a test file came to; paths relative to the project. */
export type WriteFinding = { file: string; module: string | null; isNew: boolean; count: number; neighbours: NeighbourFile[]; duplicates: Duplicate[] }
export type ParametrizeGroup = { file: string; names: string[] }
export type AuditFile = { path: string; module: string | null; imports: string[]; units: TestUnit[] }
export type AuditInput = {
  /** The subtree audited, relative to the project; '' for the whole project. */
  scope: string
  files: AuditFile[]
  /** ripwire's clone pairs, already on test files; null when ripwire did not run: the own cross-file pass runs instead. */
  ripwire: Duplicate[] | null
  /** Every file of the project, relative, for the orphan check; null when unknown. */
  projectFiles: string[] | null
}
export type Audit = {
  scope: string
  fileCount: number
  testCount: number
  duplicates: Duplicate[]
  parametrize: ParametrizeGroup[]
  oversized: { file: string; count: number }[]
  skipped: TestRef[]
  orphans: { file: string; module: string }[]
  source: 'ripwire' | 'own'
  isCapped: boolean
}

/** Similarity from which a pair is a clone, whatever the near-duplicate setting. */
export const CLONE = 0.9
/** Tokens per shingle. */
const SHINGLE = 5
/** Tokens a body is cut to before comparing, so a dump file stays cheap. */
const MAX_TOKENS = 400
/** Pairwise comparisons the own cross-file audit pass makes at most. */
const MAX_COMPARISONS = 250_000
/** Test names a neighbourhood report lists per file. */
const NAMES_SHOWN = 8
/** Duplicate sentences a write note carries at most. */
const NOTE_DUPLICATES = 3
/** Rows a section of the audit lists at most. */
const SECTION_ROWS = 20

const EXTENSIONS: Record<string, Language> = {
  py: 'python',
  js: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  go: 'go',
  rb: 'ruby',
  rs: 'rust',
}
const TEST_DIRS = new Set(['tests', 'test', '__tests__'])
const RUST_ROOTS = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc'])

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean)
const basenameOf = (path: string): string => segmentsOf(path).at(-1) ?? ''
const stemOf = (base: string): string => (base.lastIndexOf('.') > 0 ? base.slice(0, base.lastIndexOf('.')) : base)
const indentOf = (line: string): number => line.length - line.trimStart().length
const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

export const plural = (count: number, word: string): string => `${count} ${count === 1 ? word : `${word}s`}`
/** 1204 → 1,204. */
export const formatCount = (count: number): string => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const languageOf = (path: string): Language | null => {
  const base = basenameOf(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? null : (EXTENSIONS[base.slice(dot + 1).toLowerCase()] ?? null)
}

/**
 * Whether a path is a test file, per language: Python `test_*.py`, `*_test.py` or anything under `tests/` or `test/`
 * (not conftest or __init__); JS/TS `*.test.*`, `*.spec.*` or under `__tests__/`; Go `_test.go`; Ruby `_spec.rb`;
 * Rust under `tests/`.
 */
export const isTestFile = (path: string): boolean => {
  const language = languageOf(path)
  if (language === null) {
    return false
  }
  const parts = segmentsOf(path)
  const stem = stemOf(parts.at(-1) ?? '').toLowerCase()
  const dirs = parts.slice(0, -1).map(dir => dir.toLowerCase())
  const underTests = dirs.some(dir => dir === 'tests' || dir === 'test')
  switch (language) {
    case 'python':
      return stem !== 'conftest' && stem !== '__init__' && (stem.startsWith('test_') || stem.endsWith('_test') || underTests)
    case 'js':
      return /\.(test|spec)$/.test(stem) || dirs.includes('__tests__')
    case 'go':
      return stem.endsWith('_test')
    case 'ruby':
      return stem.endsWith('_spec')
    case 'rust':
      return underTests
  }
}

/** The module a test file is named after: `test_foo.py` → foo, `foo.test.ts` → foo, `foo_test.go` → foo; null for a non-test file. */
export const moduleOf = (path: string): string | null => {
  const language = languageOf(path)
  if (language === null || !isTestFile(path)) {
    return null
  }
  const parts = segmentsOf(path)
  let stem = stemOf(parts.at(-1) ?? '').toLowerCase()
  switch (language) {
    case 'python':
      stem = stem.startsWith('test_') ? stem.slice(5) : stem.endsWith('_test') ? stem.slice(0, -5) : stem
      break
    case 'js':
      stem = stem.replace(/\.(test|spec)$/, '')
      break
    case 'go':
      stem = stem.replace(/_test$/, '')
      break
    case 'ruby':
      stem = stem.replace(/_spec$/, '')
      break
    case 'rust':
      break
  }
  if (stem === 'index') {
    const owner = parts
      .slice(0, -1)
      .reverse()
      .find(dir => !TEST_DIRS.has(dir.toLowerCase()))
    return owner === undefined ? null : owner.toLowerCase()
  }
  return stem === '' ? null : stem
}

/** The module name an argument spells: `src/cart/total.ts` → total, `meshkit.mesh_build` → mesh_build. */
export const moduleName = (text: string): string => {
  const last = text.trim().split(/[/\\.:]+/).filter(Boolean)
  // A path keeps its last segment less the extension; a dotted module its last segment.
  const base = basenameOf(text.trim())
  const stem = text.includes('/') || /\.(?:py|[cm]?[jt]sx?|go|rb|rs)$/i.test(base) ? stemOf(base) : (last.at(-1) ?? '')
  return stem.toLowerCase()
}

// --- comments and strings ---------------------------------------------------------------------------------------------

type Syntax = { line: string[]; block: [string, string] | null; quotes: string[] }
const SYNTAX: Record<Language, Syntax> = {
  python: { line: ['#'], block: null, quotes: ['"""', "'''", '"', "'"] },
  ruby: { line: ['#'], block: null, quotes: ['"', "'"] },
  js: { line: ['//'], block: ['/*', '*/'], quotes: ['`', '"', "'"] },
  go: { line: ['//'], block: ['/*', '*/'], quotes: ['`', '"', "'"] },
  rust: { line: ['//'], block: ['/*', '*/'], quotes: ['"'] },
}

/** The index just past the string literal opening at `start` with `quote`; the text's end when unterminated. */
const stringEnd = (text: string, start: number, quote: string): number => {
  let i = start + quote.length
  const isRaw = quote === '`' || quote.length === 3
  while (i < text.length) {
    if (!isRaw && text[i] === '\\') {
      i += 2
      continue
    }
    if (text.startsWith(quote, i)) {
      return i + quote.length
    }
    // A one-quote string does not run past its line.
    if (quote.length === 1 && quote !== '`' && text[i] === '\n') {
      return i
    }
    i++
  }
  return text.length
}

/** Whether a Rust `'` at `i` opens a char literal (`'a'`, `'\n'`) rather than a lifetime. */
const isRustChar = (text: string, i: number): boolean => /^'(?:\\.|[^'\\])'/.test(text.slice(i, i + 4))

/** The text with every comment, and every string when `strings`, replaced by spaces: positions hold, and `it(` in either is not a test. */
const blank = (text: string, language: Language, strings: boolean): string => {
  const syntax = SYNTAX[language]
  const out = text.split('')
  let i = 0
  while (i < text.length) {
    const quote = syntax.quotes.find(q => text.startsWith(q, i))
    if (quote !== undefined && !(language === 'rust' && quote === "'" && !isRustChar(text, i))) {
      const end = stringEnd(text, i, quote)
      while (strings && i < end) {
        if (text[i] !== '\n') {
          out[i] = ' '
        }
        i++
      }
      i = end
      continue
    }
    const line = syntax.line.find(marker => text.startsWith(marker, i))
    if (line !== undefined) {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (syntax.block && text.startsWith(syntax.block[0], i)) {
      const close = text.indexOf(syntax.block[1], i + syntax.block[0].length)
      const end = close < 0 ? text.length : close + syntax.block[1].length
      while (i < end) {
        if (text[i] !== '\n') {
          out[i] = ' '
        }
        i++
      }
      continue
    }
    i++
  }
  return out.join('')
}

export const blankComments = (text: string, language: Language): string => blank(text, language, false)
/** Comments and strings blanked: what a test is matched in, its title then read from the original text. */
export const blankLiterals = (text: string, language: Language): string => blank(text, language, true)

/** The index of the bracket closing the one at `open`, strings and comments skipped; the text's last index when unbalanced. */
const closeOf = (text: string, open: number, language: Language): number => {
  const syntax = SYNTAX[language]
  let depth = 0
  let i = open
  while (i < text.length) {
    const char = text[i] ?? ''
    const quote = syntax.quotes.find(q => text.startsWith(q, i))
    if (quote !== undefined && !(language === 'rust' && quote === "'" && !isRustChar(text, i))) {
      i = stringEnd(text, i, quote)
      continue
    }
    if (syntax.line.some(marker => text.startsWith(marker, i))) {
      while (i < text.length && text[i] !== '\n') {
        i++
      }
      continue
    }
    if (syntax.block && text.startsWith(syntax.block[0], i)) {
      const close = text.indexOf(syntax.block[1], i + 2)
      i = close < 0 ? text.length : close + 2
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++
    } else if (char === ')' || char === ']' || char === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }
    i++
  }
  return text.length - 1
}

// --- test extraction --------------------------------------------------------------------------------------------------

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/
const PY_PARAM = /@(?:pytest\.mark\.parametrize|parameterized\.\w+|parametrize|given|hypothesis\.given)\b/
const PY_SKIP_MARK = /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure)|skip\w*)\b/
const PY_SKIP_CALL = /\b(?:pytest\.(?:skip|xfail|importorskip)|self\.skipTest)\s*\(/

const pythonTests = (text: string): TestUnit[] => {
  const lines = text.split('\n')
  const units: TestUnit[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = PY_DEF.exec(lines[i] ?? '')
    if (!match) {
      continue
    }
    const indent = (match[1] ?? '').length
    const decorators: string[] = []
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j] ?? ''
      if (line.trim().startsWith('@') && indentOf(line) === indent) {
        decorators.push(line.trim())
      } else {
        break
      }
    }
    let end = i + 1
    while (end < lines.length && ((lines[end] ?? '').trim() === '' || indentOf(lines[end] ?? '') > indent)) {
      end++
    }
    while (end > i + 1 && (lines[end - 1] ?? '').trim() === '') {
      end--
    }
    const body = lines.slice(i, end).join('\n')
    units.push({
      name: match[2] ?? '',
      line: i + 1,
      body,
      isParametrized: decorators.some(d => PY_PARAM.test(d)),
      isSkipped: decorators.some(d => PY_SKIP_MARK.test(d)) || PY_SKIP_CALL.test(body),
    })
  }
  return units
}

const JS_CALL = /(?<![.\w$])(test|it|xit|xtest)((?:\.\w+)*)\s*\(/g
const JS_TITLE = /^\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/

const jsTests = (text: string): TestUnit[] => {
  const clean = blankLiterals(text, 'js')
  const units: TestUnit[] = []
  for (const match of clean.matchAll(JS_CALL)) {
    const start = match.index ?? 0
    const keyword = match[1] ?? ''
    const modifiers = match[2] ?? ''
    let open = start + match[0].length - 1
    // `it.each(table)('title', fn)`: the title follows the table's own call.
    if (/\.each\b/.test(modifiers)) {
      const afterTable = clean.slice(closeOf(clean, open, 'js') + 1)
      const next = /^\s*\(/.exec(afterTable)
      if (!next) {
        continue
      }
      open = clean.length - afterTable.length + next[0].length - 1
    }
    const title = JS_TITLE.exec(text.slice(open + 1))
    const line = lineAt(clean, start)
    const name = title ? (title[2] ?? '') : `test@${line}`
    const body = text.slice(start, closeOf(clean, open, 'js') + 1)
    units.push({
      name,
      line,
      body,
      isParametrized: /\.each\b/.test(modifiers),
      isSkipped: keyword.startsWith('x') || /\.(skip|todo)\b/.test(modifiers),
    })
  }
  return units
}

const GO_FUNC = /^func\s+(?:\([^)]*\)\s*)?(Test\w*)\s*\(/gm

const goTests = (text: string): TestUnit[] => {
  const clean = blankLiterals(text, 'go')
  const units: TestUnit[] = []
  for (const match of clean.matchAll(GO_FUNC)) {
    const start = match.index ?? 0
    const brace = clean.indexOf('{', start + match[0].length)
    if (brace < 0) {
      continue
    }
    const body = text.slice(start, closeOf(clean, brace, 'go') + 1)
    units.push({
      name: match[1] ?? '',
      line: lineAt(clean, start),
      body,
      isParametrized: /\.Run\s*\(|\brange\s+(?:tests|cases|tcs|tt|table)\b/.test(body),
      isSkipped: /\.Skip(?:Now|f)?\s*\(/.test(body),
    })
  }
  return units
}

const RB_IT = /^(\s*)(it|specify|scenario|xit|xspecify|xscenario)\s+(['"])((?:\\.|(?!\3).)*)\3/

const rubyTests = (text: string): TestUnit[] => {
  const lines = text.split('\n')
  const units: TestUnit[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = RB_IT.exec(lines[i] ?? '')
    if (!match) {
      continue
    }
    const indent = (match[1] ?? '').length
    let end = i + 1
    while (end < lines.length && ((lines[end] ?? '').trim() === '' || indentOf(lines[end] ?? '') > indent)) {
      end++
    }
    // The block's own `end` closes the body.
    if (end < lines.length && (lines[end] ?? '').trim().startsWith('end') && indentOf(lines[end] ?? '') === indent) {
      end++
    }
    while (end > i + 1 && (lines[end - 1] ?? '').trim() === '') {
      end--
    }
    const body = lines.slice(i, end).join('\n')
    units.push({
      name: match[4] ?? '',
      line: i + 1,
      body,
      isParametrized: false,
      isSkipped: (match[2] ?? '').startsWith('x') || /^\s*(?:skip|pending)\b/m.test(body),
    })
  }
  return units
}

const RS_FN = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/

const rustTests = (text: string): TestUnit[] => {
  const clean = blankLiterals(text, 'rust')
  const units: TestUnit[] = []
  for (const match of clean.matchAll(/#\[test\]/g)) {
    const start = match.index ?? 0
    const after = clean.slice(start + match[0].length)
    const fn = RS_FN.exec(after)
    if (!fn) {
      continue
    }
    const fnAt = start + match[0].length + (/fn\s+\w+$/.exec(fn[0])?.index ?? 0)
    const attributes = [clean.slice(start, fnAt), ...attributesBefore(clean, start)].join('\n')
    const brace = clean.indexOf('{', fnAt)
    if (brace < 0) {
      continue
    }
    units.push({
      name: fn[1] ?? '',
      line: lineAt(clean, fnAt),
      body: text.slice(fnAt, closeOf(clean, brace, 'rust') + 1),
      isParametrized: /#\[(?:rstest|test_case|case)\b/.test(attributes),
      isSkipped: /#\[ignore\b/.test(attributes),
    })
  }
  return units
}

/** The attribute lines directly above `index`. */
const attributesBefore = (text: string, index: number): string[] => {
  const lines = text.slice(0, index).split('\n')
  lines.pop()
  const out: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (line.startsWith('#[')) {
      out.push(line)
    } else {
      break
    }
  }
  return out
}

/** The tests a test file holds, by language; none for a file of no known language. */
export const extractTests = (path: string, text: string): TestUnit[] => {
  switch (languageOf(path)) {
    case 'python':
      return pythonTests(text)
    case 'js':
      return jsTests(text)
    case 'go':
      return goTests(text)
    case 'ruby':
      return rubyTests(text)
    case 'rust':
      return rustTests(text)
    case null:
      return []
  }
}

// --- imports ----------------------------------------------------------------------------------------------------------

const dedupe = (names: readonly string[]): string[] => [...new Set(names.filter(name => name !== ''))]

const pythonImports = (text: string): string[] => {
  const out: string[] = []
  // A parenthesised import list is read as one line.
  const joined = text.replace(/\(\s*\n([^)]*)\)/g, (_, inner: string) => `(${inner.replace(/\s*\n\s*/g, ' ')})`)
  for (const line of joined.split('\n')) {
    const from = /^\s*from\s+([\w.]+)\s+import\s+\(?([^)#]*)\)?/.exec(line)
    if (from) {
      const segments = (from[1] ?? '').split('.').filter(Boolean)
      if (segments.length > 0) {
        out.push(segments.at(-1) ?? '')
      }
      for (const name of (from[2] ?? '').split(',')) {
        const bare = (name.trim().split(/\s+as\s+/)[0] ?? '').trim()
        if (bare !== '' && bare !== '*') {
          out.push(bare)
        }
      }
      continue
    }
    const plain = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/.exec(line)
    if (plain) {
      for (const item of (plain[1] ?? '').split(',')) {
        const path = (item.trim().split(/\s+as\s+/)[0] ?? '').trim()
        out.push(path.split('.').filter(Boolean).at(-1) ?? '')
      }
    }
  }
  return dedupe(out)
}

const JS_SPEC = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\b(?:vi|jest)\.(?:mock|doMock|requireActual|importActual)\s*\(\s*)(['"])([^'"\n]+)\1/g
const JS_PROJECT = /^(?:\.{1,2}(?:\/|$)|\/|~\/|@\/|#|(?:src|app|lib|test|tests)\/)/

/** The module a project import names: its file less the extension, or its folder for an index file. */
const jsModuleOf = (spec: string): string | null => {
  const clean = spec.replace(/[?#].*$/, '').replace(/\.(?:[cm]?[jt]sx?|json|vue|svelte)$/, '')
  const parts = clean.split('/').filter(part => part !== '' && part !== '.' && part !== '..')
  const last = parts.at(-1)
  if (last === undefined) {
    return null
  }
  return last === 'index' ? (parts.at(-2) ?? null) : last
}

const jsImports = (text: string): string[] => {
  const out: string[] = []
  for (const match of blankComments(text, 'js').matchAll(JS_SPEC)) {
    const spec = match[2] ?? ''
    if (JS_PROJECT.test(spec)) {
      const name = jsModuleOf(spec)
      if (name !== null) {
        out.push(name)
      }
    }
  }
  return dedupe(out)
}

const snakeCase = (constant: string): string =>
  constant
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()

const rubyImports = (text: string): string[] => {
  const out: string[] = []
  for (const match of text.matchAll(/^\s*require_relative\s+['"]([^'"]+)['"]/gm)) {
    out.push(stemOf(basenameOf(match[1] ?? '')))
  }
  for (const match of text.matchAll(/^\s*require\s+['"]([^'"]+)['"]/gm)) {
    if ((match[1] ?? '').includes('/')) {
      out.push(stemOf(basenameOf(match[1] ?? '')))
    }
  }
  for (const match of text.matchAll(/\b(?:describe|context)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/g)) {
    out.push(snakeCase((match[1] ?? '').split('::').at(-1) ?? ''))
  }
  return dedupe(out)
}

const rustImports = (text: string): string[] => {
  const out: string[] = []
  for (const match of text.matchAll(/^\s*(?:pub\s+)?use\s+([\w:]+)(?:::\{([^}]*)\})?/gm)) {
    for (const segment of (match[1] ?? '').split('::')) {
      if (segment !== '' && !RUST_ROOTS.has(segment)) {
        out.push(segment)
      }
    }
    for (const item of (match[2] ?? '').split(',')) {
      const name = (item.trim().split(/\s+as\s+/)[0] ?? '').split('::')[0] ?? ''
      if (name !== '' && name !== 'self' && name !== '*') {
        out.push(name)
      }
    }
  }
  for (const match of text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
    out.push(match[1] ?? '')
  }
  return dedupe(out)
}

/** The project modules a test file imports, as bare names (`mesh_build`, `total`); none for Go, whose tests sit beside their package. */
export const importsOf = (path: string, text: string): string[] => {
  switch (languageOf(path)) {
    case 'python':
      return pythonImports(text)
    case 'js':
      return jsImports(text)
    case 'ruby':
      return rubyImports(text)
    case 'rust':
      return rustImports(text)
    case 'go':
    case null:
      return []
  }
}

// --- similarity -------------------------------------------------------------------------------------------------------

const OPERATORS = ['...', '===', '!==', '==', '!=', '<=', '>=', '=>', '->', '&&', '||', '::', '**', '+=', '-=', '*=', '/=', '//', '<<', '>>']
const PY_PREFIX = /^[rbfuRBFU]{1,2}$/

/**
 * A test body as tokens: comments dropped, every string `STR` and every number `NUM`, identifiers kept, the test's own
 * name `NAME` so a renamed copy matches; cut at 400 tokens.
 */
export const normalizeBody = (body: string, language: Language, name?: string): string[] => {
  const syntax = SYNTAX[language]
  const tokens: string[] = []
  let lastEnd = -1
  let i = 0
  while (i < body.length && tokens.length < MAX_TOKENS) {
    const char = body[i] ?? ''
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (syntax.line.some(marker => body.startsWith(marker, i))) {
      while (i < body.length && body[i] !== '\n') {
        i++
      }
      continue
    }
    if (syntax.block && body.startsWith(syntax.block[0], i)) {
      const close = body.indexOf(syntax.block[1], i + 2)
      i = close < 0 ? body.length : close + 2
      continue
    }
    const quote = syntax.quotes.find(q => body.startsWith(q, i))
    if (quote !== undefined && !(language === 'rust' && quote === "'" && !isRustChar(body, i))) {
      // f"…", b"…", rb"…": the prefix is part of the literal.
      if (language === 'python' && lastEnd === i && PY_PREFIX.test(tokens.at(-1) ?? '')) {
        tokens.pop()
      }
      i = stringEnd(body, i, quote)
      lastEnd = i
      tokens.push('STR')
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = i + 1
      while (end < body.length && /[\w$]/.test(body[end] ?? '')) {
        end++
      }
      const word = body.slice(i, end)
      tokens.push(name !== undefined && word === name ? 'NAME' : word)
      i = end
      lastEnd = i
      continue
    }
    if (/[0-9]/.test(char)) {
      let end = i + 1
      while (end < body.length && /[\w.]/.test(body[end] ?? '')) {
        end++
      }
      tokens.push('NUM')
      i = end
      lastEnd = i
      continue
    }
    const operator = OPERATORS.find(op => body.startsWith(op, i))
    const token = operator ?? char
    tokens.push(token)
    i += token.length
    lastEnd = i
  }
  return tokens
}

/** The k-token shingles of a token sequence; a sequence shorter than k is one shingle. */
export const shingles = (tokens: readonly string[], k = SHINGLE): Set<string> => {
  const out = new Set<string>()
  if (tokens.length === 0) {
    return out
  }
  if (tokens.length <= k) {
    out.add(tokens.join('\u0001'))
    return out
  }
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join('\u0001'))
  }
  return out
}

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let shared = 0
  for (const one of a) {
    if (b.has(one)) {
      shared++
    }
  }
  return shared / (a.size + b.size - shared)
}

/** How alike two tests' bodies are: Jaccard similarity of their normalised 5-token shingles, 0 to 1. */
export const similarity = (a: TestUnit, b: TestUnit, language: Language): number =>
  jaccard(shingles(normalizeBody(a.body, language, a.name)), shingles(normalizeBody(b.body, language, b.name)))

/** What a similarity is called: a clone from 0.9 (or the near threshold when higher), a near-duplicate from `near`, else nothing. */
export const classify = (value: number, near: number): DuplicateKind | null =>
  value >= Math.max(CLONE, near) ? 'clone' : value >= near ? 'near' : null

const refOf = (test: FileTest): TestRef => ({ file: test.file, name: test.unit.name })
const keyOf = (test: FileTest): string => `${test.file}::${test.unit.name}`
/** The body with the test's own name blanked, so copies differing only in their name read equal. */
const bodyOf = (unit: TestUnit): string => unit.body.split(unit.name).join('NAME')

/**
 * The tests among `fresh` alike to one in `pool`, and (with `among`) to one another: clones, near-duplicates, and the
 * parametrize candidates (same file, identical once normalised, literals differing). Most alike first.
 */
export const findDuplicates = (fresh: readonly FileTest[], pool: readonly FileTest[], language: Language, near: number, among = true): Duplicate[] => {
  const cache = new Map<FileTest, { tokens: string; set: Set<string> }>()
  const prepared = (test: FileTest) => {
    let entry = cache.get(test)
    if (!entry) {
      const tokens = normalizeBody(test.unit.body, language, test.unit.name)
      entry = { tokens: tokens.join(' '), set: shingles(tokens) }
      cache.set(test, entry)
    }
    return entry
  }
  const seen = new Set<string>()
  const out: Duplicate[] = []
  const compare = (a: FileTest, b: FileTest) => {
    if (a === b || keyOf(a) === keyOf(b)) {
      return
    }
    const pair = [keyOf(a), keyOf(b)].sort().join('|')
    if (seen.has(pair)) {
      return
    }
    seen.add(pair)
    const one = prepared(a)
    const other = prepared(b)
    if (one.tokens !== '' && one.tokens === other.tokens && a.file === b.file && bodyOf(a.unit) !== bodyOf(b.unit)) {
      out.push({ a: refOf(a), b: refOf(b), similarity: 1, kind: 'parametrize' })
      return
    }
    const value = jaccard(one.set, other.set)
    const kind = classify(value, near)
    if (kind !== null) {
      out.push({ a: refOf(a), b: refOf(b), similarity: value, kind })
    }
  }
  for (const a of fresh) {
    for (const b of pool) {
      compare(a, b)
    }
  }
  if (among) {
    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        compare(fresh[i] as FileTest, fresh[j] as FileTest)
      }
    }
  }
  // A stable sort: ties keep the order found (pool pairs before fresh-among-fresh pairs).
  return out.map((one, index) => ({ one, index })).sort((x, y) => y.one.similarity - x.one.similarity || x.index - y.index).map(({ one }) => one)
}

// --- neighbourhood ----------------------------------------------------------------------------------------------------

/** Whether a test file covers a module: named after it (or a sub-module of it, or it of them), or importing it. */
export const coversModule = (info: { module: string | null; imports: readonly string[] }, module: string): boolean => {
  const wanted = module.toLowerCase()
  const own = info.module?.toLowerCase() ?? null
  if (own !== null && (own === wanted || own.startsWith(`${wanted}_`) || wanted.startsWith(`${own}_`))) {
    return true
  }
  return info.imports.some(name => name.toLowerCase() === wanted)
}

/** The test files covering a module, most tests first, `excluding` one path (the file being written). */
export const neighbourhood = (module: string, infos: readonly TestFileInfo[], excluding?: string): NeighbourFile[] =>
  infos
    .filter(info => info.path !== excluding && coversModule(info, module))
    .map(info => ({ path: info.path, count: info.tests.length, names: info.tests.map(test => test.name) }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))

/** The module a test file is about: the first candidate (its name's module, then its imports) another test file covers; else the first. */
export const primaryModule = (candidates: readonly string[], infos: readonly TestFileInfo[], excluding?: string): string | null => {
  const names = candidates.filter(name => name !== '')
  const covered = names.find(name => infos.some(info => info.path !== excluding && coversModule(info, name)))
  return covered ?? names[0] ?? null
}

/** The directory every path shares; null when none do or there are no paths. */
export const commonDirectory = (paths: readonly string[]): string | null => {
  const [first, ...rest] = paths
  if (first === undefined) {
    return null
  }
  let common = segmentsOf(first).slice(0, -1)
  for (const path of rest) {
    const parts = segmentsOf(path).slice(0, -1)
    let i = 0
    while (i < common.length && i < parts.length && common[i] === parts[i]) {
      i++
    }
    common = common.slice(0, i)
  }
  return common.length === 0 ? null : `${first.startsWith('/') ? '/' : ''}${common.join('/')}`
}

// --- texts ------------------------------------------------------------------------------------------------------------

const listOf = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

/**
 * The note Claude reads after writing a test file: which files already cover the module (for a new file, or when a
 * copy lies in another file), the near-duplicates and clones among the tests it added, the file's size past the
 * guideline; null when there is nothing to say.
 */
export const writeNote = (finding: WriteFinding, settings: GardenerSettings): string | null => {
  const sentences: string[] = []
  const { neighbours, duplicates } = finding
  const crossFile = duplicates.some(d => d.a.file !== finding.file || d.b.file !== finding.file)
  const [first, ...rest] = neighbours
  if (first !== undefined && finding.module !== null && (finding.isNew || crossFile)) {
    const also = rest.slice(0, 3).map(n => `${n.path}, ${n.count}`)
    const more = rest.length > 3 ? `; +${rest.length - 3} more` : ''
    sentences.push(`${first.path} already covers ${finding.module} with ${plural(first.count, 'test')}${also.length > 0 ? ` (also ${also.join('; ')}${more})` : ''}.`)
  }
  const coverageOnly = sentences.length
  for (const d of duplicates.slice(0, NOTE_DUPLICATES)) {
    const where = d.b.file === finding.file ? d.b.name : `${d.b.name} in ${d.b.file}`
    const score = `(${d.similarity.toFixed(2)})`
    if (d.kind === 'parametrize') {
      sentences.push(`New test ${d.a.name} differs from ${where} only in literals — parametrize them.`)
    } else if (d.kind === 'clone') {
      sentences.push(`New test ${d.a.name} is a clone of ${where} ${score} — keep one of them, or parametrize.`)
    } else {
      sentences.push(`New test ${d.a.name} is a near-duplicate of ${where} ${score} — parametrize them.`)
    }
  }
  if (duplicates.length > NOTE_DUPLICATES) {
    const left = duplicates.length - NOTE_DUPLICATES
    sentences.push(`And ${left} more ${left === 1 ? 'near-duplicate' : 'near-duplicates'}.`)
  }
  if (finding.count > settings.maxTestsPerFile) {
    sentences.push(`This file now has ${finding.count} tests (guideline ${settings.maxTestsPerFile}): split by concern or extend an existing file instead of starting another.`)
  }
  if (sentences.length === 1 && coverageOnly === 1 && finding.isNew) {
    sentences.push('Extend one of them rather than starting another file.')
  }
  return sentences.length === 0 ? null : `test-gardener: ${sentences.join(' ')}`
}

/** The tests_neighbourhood answer: the files covering the module and what they test, or that none does (with the layout). */
export const neighbourhoodText = (module: string, files: readonly NeighbourFile[], settings: GardenerSettings, hint: { count: number; dir: string } | null): string => {
  if (files.length === 0) {
    const base = `test-gardener: no test file names or imports ${module} yet.`
    return hint === null ? base : `${base} ${plural(hint.count, 'test file')} ${hint.count === 1 ? 'lives' : 'live'} under ${hint.dir}/; a new one there keeps the layout.`
  }
  const parts = files.map(file => {
    const names = file.names.slice(0, NAMES_SHOWN).join(', ')
    const more = file.names.length > NAMES_SHOWN ? ` and ${file.names.length - NAMES_SHOWN} more` : ''
    return `${file.path} (${plural(file.count, 'test')}: ${names}${more})`
  })
  return (
    `test-gardener: ${module} is covered by ${listOf(parts)}.\n` +
    `Extend one of these or parametrize an existing test rather than starting another file; past ${settings.maxTestsPerFile} tests a file is split by concern.`
  )
}

// --- the branch -------------------------------------------------------------------------------------------------------

const TEST_LINE: Record<Language, RegExp> = {
  python: /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
  js: /(?<![.\w$])(?:test|it|xit|xtest)(?:\.\w+)*\s*\(/,
  go: /^func\s+(?:\([^)]*\)\s*)?Test\w*\s*\(/,
  ruby: /^\s*(?:it|specify|scenario|xit)\s+['"]/,
  rust: /^\s*#\[test\]/,
}

/** Whether one line of code defines a test, per language; a JS call inside a string on the line does not. */
export const isTestDefinition = (line: string, language: Language): boolean =>
  TEST_LINE[language].test(language === 'js' ? line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, match => ' '.repeat(match.length)) : line)

/** `refs/remotes/origin/main` as `origin/main`, `refs/heads/main` as `main`. */
const shortRef = (ref: string): string => ref.replace(/^refs\/(?:remotes|heads)\//, '')

/** The branches that stand in for an unset origin/HEAD, in order. */
const STAND_INS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']

/** The refs one `git for-each-ref` read covers to find the default branch: origin/HEAD and its stand-ins. */
export const DEFAULT_BRANCH_REFS: readonly string[] = ['refs/remotes/origin/HEAD', ...STAND_INS]

/**
 * The default branch to diff the checked-out branch against, from one `git for-each-ref --format=%(refname)%09%(symref)`
 * read over DEFAULT_BRANCH_REFS (a read that never fails): what origin/HEAD points to when it is set (a clone made
 * without it has none), else the first of origin/main, origin/master, main, master that exists, else the branch
 * checked out now (null on a detached HEAD).
 */
export const pickDefaultBranch = (refs: string | null, currentBranch: string | null): string | null => {
  const rows = (refs ?? '').split('\n').map(line => line.split('\t'))
  const head = rows.find(([name, target]) => name === 'refs/remotes/origin/HEAD' && target)
  if (head?.[1]) {
    return shortRef(head[1])
  }
  const names = new Set(rows.map(([name]) => name ?? ''))
  const found = STAND_INS.find(ref => names.has(ref))
  return found ? shortRef(found) : currentBranch
}

/** Tests and lines added to test files, from a unified diff (`git diff -U0 base...HEAD`). */
export const countBranchTests = (diff: string): BranchCount => {
  let language: Language | null = null
  let tests = 0
  let lines = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git a\/.* b\/(.*)$/.exec(line)
      const path = header?.[1] ?? ''
      language = isTestFile(path) ? languageOf(path) : null
      continue
    }
    if (language === null || !line.startsWith('+') || line.startsWith('+++ ')) {
      continue
    }
    lines++
    if (isTestDefinition(line.slice(1), language)) {
      tests++
    }
  }
  return { tests, lines }
}

export const isBigBranch = (count: BranchCount, settings: GardenerSettings): boolean =>
  count.tests > settings.bigBranchTests || count.lines > settings.bigBranchLines

export const bandText = (count: BranchCount): string =>
  `${formatCount(count.tests)} ${count.tests === 1 ? 'test' : 'tests'} · +${formatCount(count.lines)} lines of tests on this branch → /tests audit`

// --- paths ------------------------------------------------------------------------------------------------------------

/** `path` under `root`, absolute, `.` and `..` folded. */
export const resolvePath = (root: string, path: string): string => {
  const joined = path.startsWith('/') ? path : `${root}/${path}`
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      out.pop()
    } else {
      out.push(part)
    }
  }
  return `/${out.join('/')}`
}

/** `path` relative to `root`; unchanged when outside it. */
export const relative = (root: string, path: string): string => {
  const base = root.replace(/\/+$/, '')
  return path === base ? '.' : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

/** A short stable hash of a text (djb2), eight hex digits: the scan cache's file name per project. */
export const hashOf = (text: string): string => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// --- ripwire ----------------------------------------------------------------------------------------------------------

const unescapeXml = (text: string): string =>
  text.replace(/&(lt|gt|amp|quot|apos|#(\d+));/g, (whole, name: string, code: string) =>
    name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'amp' ? '&' : name === 'quot' ? '"' : name === 'apos' ? "'" : code ? String.fromCharCode(Number(code)) : whole,
  )

/**
 * The clone pairs in `ripwire <dir> --clones` output whose members are test files: a type-2 group (exact or renamed) is
 * similarity 1, a type-3 pair carries its own; paths resolved against the output's `root`, itself against `cwd`.
 */
export const parseRipwireClones = (output: string, cwd: string, near: number): Duplicate[] => {
  const rootAttr = /<clones\b[^>]*\broot="([^"]*)"/.exec(output)?.[1]
  const root = rootAttr === undefined || rootAttr === '' ? cwd : resolvePath(cwd, rootAttr)
  const out: Duplicate[] = []
  for (const group of output.matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/g)) {
    const attrs = group[1] ?? ''
    const type = /\btype="(\d+)"/.exec(attrs)?.[1]
    const value = type === '2' ? 1 : Number(/\bsimilarity="([\d.]+)"/.exec(attrs)?.[1] ?? '1')
    const kind = classify(value, near)
    if (kind === null) {
      continue
    }
    const members: TestRef[] = []
    for (const member of (group[2] ?? '').matchAll(/<f\b[^>]*\bn="([^"]*)"[^>]*\bp="([^"]*)"/g)) {
      const file = resolvePath(root, (member[2] ?? '').replace(/:[\d-]+$/, ''))
      if (isTestFile(file)) {
        members.push({ file, name: unescapeXml(member[1] ?? '') })
      }
    }
    const [first, ...rest] = members
    if (first === undefined) {
      continue
    }
    for (const other of rest) {
      out.push({ a: first, b: other, similarity: value, kind })
    }
  }
  return out
}

// --- the audit --------------------------------------------------------------------------------------------------------

const pairKey = (d: Duplicate): string => [`${d.a.file}::${d.a.name}`, `${d.b.file}::${d.b.name}`].sort().join('|')

/** Whether two test files are about the same module: named alike, or one importing the other's module. */
const linked = (a: AuditFile, b: AuditFile): boolean =>
  (a.module !== null && coversModule(b, a.module)) || (b.module !== null && coversModule(a, b.module))

/** The audit of a set of test files: duplicates (ripwire's, or the own pass's), parametrize groups, sizes, skips, orphans. */
export const assembleAudit = (input: AuditInput, settings: GardenerSettings): Audit => {
  const files = input.files.filter(file => file.units.length > 0)
  const parametrize: ParametrizeGroup[] = []
  const grouped = new Map<string, number>()
  const pairs: Duplicate[] = input.ripwire === null ? [] : [...input.ripwire]
  let comparisons = 0
  let isCapped = false
  for (const file of files) {
    const language = languageOf(file.path) ?? 'python'
    const byTokens = new Map<string, TestUnit[]>()
    for (const unit of file.units) {
      const key = normalizeBody(unit.body, language, unit.name).join(' ')
      byTokens.set(key, [...(byTokens.get(key) ?? []), unit])
    }
    for (const [key, units] of byTokens) {
      if (key !== '' && units.length > 1 && new Set(units.map(bodyOf)).size > 1) {
        parametrize.push({ file: file.path, names: units.map(unit => unit.name) })
        for (const unit of units) {
          grouped.set(`${file.path}::${unit.name}`, parametrize.length - 1)
        }
      }
    }
    const list = file.units.map(unit => ({ file: file.path, unit }))
    comparisons += (list.length * (list.length - 1)) / 2
    pairs.push(...findDuplicates(list, [], language, settings.nearDuplicate).filter(d => d.kind !== 'parametrize'))
  }
  if (input.ripwire === null) {
    cross: for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i] as AuditFile
        const b = files[j] as AuditFile
        if (!linked(a, b)) {
          continue
        }
        comparisons += a.units.length * b.units.length
        if (comparisons > MAX_COMPARISONS) {
          isCapped = true
          break cross
        }
        const language = languageOf(a.path) ?? 'python'
        pairs.push(
          ...findDuplicates(
            a.units.map(unit => ({ file: a.path, unit })),
            b.units.map(unit => ({ file: b.path, unit })),
            language,
            settings.nearDuplicate,
            false,
          ),
        )
      }
    }
  }
  // One row per pair, the highest similarity kept; a pair inside one parametrize group is that group's.
  const best = new Map<string, Duplicate>()
  for (const pair of pairs) {
    const a = grouped.get(`${pair.a.file}::${pair.a.name}`)
    const b = grouped.get(`${pair.b.file}::${pair.b.name}`)
    if (pair.kind === 'parametrize' || (a !== undefined && a === b)) {
      continue
    }
    const key = pairKey(pair)
    const known = best.get(key)
    if (known === undefined || pair.similarity > known.similarity) {
      best.set(key, pair)
    }
  }
  const rank = (d: Duplicate) => (d.kind === 'clone' ? 0 : 1)
  const duplicates = [...best.values()].map((one, index) => ({ one, index })).sort((x, y) => rank(x.one) - rank(y.one) || y.one.similarity - x.one.similarity || x.index - y.index).map(({ one }) => one)
  const orphans: Audit['orphans'] = []
  if (input.projectFiles !== null) {
    const stems = new Set<string>()
    const dirs = new Set<string>()
    for (const path of input.projectFiles) {
      if (isTestFile(path)) {
        continue
      }
      const parts = segmentsOf(path)
      stems.add(stemOf(parts.at(-1) ?? '').toLowerCase())
      for (const dir of parts.slice(0, -1)) {
        dirs.add(dir.toLowerCase())
      }
    }
    const exists = (name: string) => stems.has(name.toLowerCase()) || dirs.has(name.toLowerCase())
    for (const file of files) {
      if (file.module !== null && !exists(file.module) && !file.imports.some(exists)) {
        orphans.push({ file: file.path, module: file.module })
      }
    }
  }
  return {
    scope: input.scope,
    fileCount: files.length,
    testCount: files.reduce((sum, file) => sum + file.units.length, 0),
    duplicates,
    parametrize,
    oversized: files.filter(file => file.units.length > settings.maxTestsPerFile).map(file => ({ file: file.path, count: file.units.length })),
    skipped: files.flatMap(file => file.units.filter(unit => unit.isSkipped).map(unit => ({ file: file.path, name: unit.name }))),
    orphans,
    source: input.ripwire === null ? 'own' : 'ripwire',
    isCapped,
  }
}

const refText = (ref: TestRef): string => `${ref.file}::${ref.name}`
const pairText = (d: Duplicate): string => `- ${refText(d.a)} ≈ ${refText(d.b)} (${d.similarity.toFixed(2)})`
const section = (title: string, rows: readonly string[]): string[] =>
  rows.length === 0 ? [] : [title, ...rows.slice(0, SECTION_ROWS), ...(rows.length > SECTION_ROWS ? [`- … and ${rows.length - SECTION_ROWS} more`] : [])]

/** The /tests audit text. */
export const auditText = (audit: Audit, settings: GardenerSettings): string => {
  const head =
    `test-gardener audit${audit.scope === '' ? '' : ` of ${audit.scope}`}: ${plural(audit.fileCount, 'test file')} · ${plural(audit.testCount, 'test')} · ` +
    `${audit.source === 'ripwire' ? 'clones via ripwire' : 'own pairwise pass'}${audit.isCapped ? ' (capped)' : ''}`
  const skipped = audit.skipped.slice(0, 5).map(refText).join(', ') + (audit.skipped.length > 5 ? ` and ${audit.skipped.length - 5} more` : '')
  const lines = [
    ...section(`Clones (≥ ${CLONE}):`, audit.duplicates.filter(d => d.kind === 'clone').map(pairText)),
    ...section(`Near-duplicates (≥ ${settings.nearDuplicate}):`, audit.duplicates.filter(d => d.kind === 'near').map(pairText)),
    ...section('Parametrize candidates (same body, literals differ):', audit.parametrize.map(group => `- ${group.file}: ${group.names.join(', ')}`)),
    ...section(`Files over ${settings.maxTestsPerFile} tests:`, audit.oversized.map(file => `- ${file.file} (${file.count})`)),
    ...(audit.skipped.length === 0 ? [] : [`Skipped or xfail tests: ${audit.skipped.length} — ${skipped}`]),
    ...section('Tests whose module no longer exists:', audit.orphans.map(one => `- ${one.file} (${one.module})`)),
  ]
  if (lines.length === 0) {
    lines.push('Nothing to consolidate: no clones, near-duplicates, parametrize candidates, oversized files, skips or orphaned tests.')
  }
  return [head, ...lines].join('\n')
}

/** The prompt suggested after /tests audit: run the suite, do the top consolidations, run it again; null when there are none. */
export const auditSuggestion = (audit: Audit): string | null => {
  const items: string[] = []
  const clone = audit.duplicates.find(d => d.kind === 'clone')
  if (clone) {
    items.push(`merge the clone ${refText(clone.a)} ≈ ${refText(clone.b)}`)
  }
  const group = audit.parametrize[0]
  if (group) {
    items.push(`parametrize ${listOf(group.names)} in ${group.file}`)
  }
  const big = audit.oversized[0]
  if (big) {
    items.push(`split ${big.file} (${big.count} tests) by concern`)
  }
  const near = audit.duplicates.find(d => d.kind === 'near')
  if (near && items.length < 3) {
    items.push(`fold the near-duplicate ${refText(near.a)} into ${refText(near.b)}`)
  }
  if (items.length === 0) {
    return null
  }
  return `Run the test suite first, then consolidate per /tests audit: ${items.slice(0, 3).join(', ')}; run the suite again and confirm it stays green.`
}
