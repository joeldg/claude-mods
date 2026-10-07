/** The slicers on this Mac that files are handed to. */
export type Slicer = 'bambu' | 'snapmaker' | 'orca'

export type SlicerInfo = {
  /** What `open -b` and `quit app id` take. */
  bundle: string
  /** The executable's name, as `pgrep -x` matches it. */
  process: string
  /** The app's name as the person knows it. */
  label: string
}

export const SLICERS: Readonly<Record<Slicer, SlicerInfo>> = {
  bambu: { bundle: 'com.bambulab.bambu-studio', process: 'BambuStudio', label: 'Bambu Studio' },
  snapmaker: { bundle: 'com.snapmaker.snapmaker-orca', process: 'Snapmaker_Orca', label: 'Snapmaker Orca' },
  orca: { bundle: 'com.orcaslicer.OrcaSlicer', process: 'OrcaSlicer', label: 'OrcaSlicer' },
}

export const DEFAULT_FULL_SPECTRUM = 'full.?spectrum|snapmaker-only|-fs\\.3mf$|-u1[-.]'

/** What a Snapmaker U1 full-spectrum project's settings name: its `Snapmaker PLA Full Spectrum @U1` profiles. */
export const FULL_SPECTRUM_MARKER = 'Full Spectrum'

/** The full-spectrum path pattern from the option, case-insensitive; the default when it is empty or not a valid regex. */
export const fullSpectrumPattern = (source: unknown): RegExp => {
  const text = typeof source === 'string' && source.trim() !== '' ? source : DEFAULT_FULL_SPECTRUM
  try {
    return new RegExp(text, 'i')
  } catch {
    return new RegExp(DEFAULT_FULL_SPECTRUM, 'i')
  }
}

// ---------------------------------------------------------------------------------------------
// Splitting a command into simple commands and words

/** One shell word as written: its source text and where it sits in the command. */
export type Word = { raw: string; start: number; end: number }

function skipSingle(s: string, i: number): number {
  const close = s.indexOf("'", i)
  return close < 0 ? s.length : close + 1
}

function skipBacktick(s: string, i: number): number {
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
    } else if (s[i] === '`') {
      return i + 1
    } else {
      i++
    }
  }
  return s.length
}

/** Index just past the `"` closing a double-quoted string whose body starts at `i`. */
function skipDouble(s: string, i: number): number {
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      i += 2
    } else if (ch === '"') {
      return i + 1
    } else if (ch === '$' && s[i + 1] === '(') {
      i = skipParens(s, i + 2)
    } else if (ch === '`') {
      i = skipBacktick(s, i + 1)
    } else {
      i++
    }
  }
  return s.length
}

/** Index just past the `)` closing a `$(` whose body starts at `i`. */
function skipParens(s: string, i: number): number {
  let depth = 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      i += 2
    } else if (ch === "'") {
      i = skipSingle(s, i + 1)
    } else if (ch === '"') {
      i = skipDouble(s, i + 1)
    } else if (ch === '`') {
      i = skipBacktick(s, i + 1)
    } else if (ch === '(') {
      depth++
      i++
    } else if (ch === ')') {
      depth--
      i++
      if (depth === 0) {
        return i
      }
    } else {
      i++
    }
  }
  return s.length
}

/** Index just past a heredoc's body, which starts at `i`, and its terminator line. */
function skipHeredoc(s: string, i: number, doc: { tag: string; strip: boolean }): number {
  while (i < s.length) {
    const nl = s.indexOf('\n', i)
    const line = s.slice(i, nl < 0 ? s.length : nl).replace(/\r$/, '')
    i = nl < 0 ? s.length : nl + 1
    if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.tag) {
      break
    }
  }
  return i
}

/**
 * The simple commands of a Bash command line, each as its words: split on `&&`, `||`, `;`, `|`,
 * `&`, newlines and parentheses outside quotes, with comments and heredoc bodies left out.
 * Quotes, `$( )` and backticks stay inside the word they belong to; offsets are the command's.
 */
export const splitCommand = (command: string): Word[][] => {
  const segments: Word[][] = []
  let words: Word[] = []
  let wordStart = -1
  let pending: { tag: string; strip: boolean }[] = []
  const s = command
  const endWord = (at: number) => {
    if (wordStart >= 0) {
      words.push({ raw: s.slice(wordStart, at), start: wordStart, end: at })
      wordStart = -1
    }
  }
  const endSegment = () => {
    if (words.length > 0) {
      segments.push(words)
    }
    words = []
  }
  const begin = (at: number) => {
    if (wordStart < 0) {
      wordStart = at
    }
  }
  let i = 0
  while (i < s.length) {
    const ch = s[i] ?? ''
    if (ch === '\\') {
      if (s[i + 1] === '\n' && wordStart < 0) {
        i += 2
        continue
      }
      begin(i)
      i += 2
    } else if (ch === "'") {
      begin(i)
      i = skipSingle(s, i + 1)
    } else if (ch === '"') {
      begin(i)
      i = skipDouble(s, i + 1)
    } else if (ch === '`') {
      begin(i)
      i = skipBacktick(s, i + 1)
    } else if (ch === '$' && s[i + 1] === '(') {
      begin(i)
      i = skipParens(s, i + 2)
    } else if (ch === '#' && wordStart < 0) {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl
    } else if (ch === '\n') {
      endWord(i)
      endSegment()
      i++
      for (const doc of pending) {
        i = skipHeredoc(s, i, doc)
      }
      pending = []
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord(i)
      i++
    } else if (ch === ';' || ch === '|' || ch === '(' || ch === ')') {
      endWord(i)
      endSegment()
      i++
    } else if (ch === '&') {
      if (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>') {
        begin(i)
        i++
      } else {
        endWord(i)
        endSegment()
        i++
      }
    } else if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord(i)
      wordStart = i
      let j = i + 2
      const strip = s[j] === '-'
      if (strip) {
        j++
      }
      while (s[j] === ' ' || s[j] === '\t') {
        j++
      }
      let tag = ''
      while (j < s.length && !/[\s;|&<>()]/.test(s[j] ?? '')) {
        const c = s[j] ?? ''
        if (c === "'" || c === '"') {
          const close = c === "'" ? skipSingle(s, j + 1) : skipDouble(s, j + 1)
          tag += s.slice(j + 1, close - 1)
          j = close
        } else if (c === '\\') {
          tag += s[j + 1] ?? ''
          j += 2
        } else {
          tag += c
          j++
        }
      }
      if (tag !== '') {
        pending.push({ tag, strip })
      }
      endWord(j)
      i = j
    } else if (ch === '<' || ch === '>') {
      // A redirection starts its own word unless an fd number (`2>`) or `&` (`&>`) leads it.
      if (wordStart >= 0 && !/^(?:\d+|&)$/.test(s.slice(wordStart, i))) {
        endWord(i)
      }
      begin(i)
      i++
    } else {
      begin(i)
      i++
    }
  }
  endWord(Math.min(i, s.length))
  endSegment()
  return segments
}

// ---------------------------------------------------------------------------------------------
// Expanding words and paths

/** Variables the command assigned before a point: a value, or null when it is not knowable here. */
export type Vars = ReadonlyMap<string, string | null>

export type Expanded = {
  /** The word with quotes removed and what is known expanded; what is not stays as written. */
  value: string
  /** False when an unknown variable, command substitution or glob leaves the value open. */
  isResolved: boolean
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/

/** A word's value as the shell would read it: quotes removed, `~`, `$HOME` and the command's own variables expanded. */
export const expandWord = (raw: string, vars: Vars, home: string | null): Expanded => {
  let value = ''
  let isResolved = true
  let i = 0
  if (raw === '~' || raw.startsWith('~/')) {
    if (home) {
      value = home
      i = 1
    } else {
      isResolved = false
    }
  }
  const substitute = (name: string, written: string) => {
    const known = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      ? null
      : vars.has(name)
        ? (vars.get(name) ?? null)
        : name === 'HOME'
          ? home
          : null
    if (known === null) {
      value += written
      isResolved = false
    } else {
      value += known
    }
  }
  /** Expands the `$` at `j`; returns the index past what it took. */
  const dollar = (j: number): number => {
    const next = raw[j + 1] ?? ''
    if (next === '{') {
      const close = raw.indexOf('}', j + 2)
      const end = close < 0 ? raw.length : close + 1
      substitute(raw.slice(j + 2, close < 0 ? raw.length : close), raw.slice(j, end))
      return end
    }
    if (next === '(') {
      const end = skipParens(raw, j + 2)
      value += raw.slice(j, end)
      isResolved = false
      return end
    }
    const name = NAME.exec(raw.slice(j + 1))?.[0]
    if (name) {
      substitute(name, `$${name}`)
      return j + 1 + name.length
    }
    if (/[0-9@*#?$!-]/.test(next)) {
      value += raw.slice(j, j + 2)
      isResolved = false
      return j + 2
    }
    value += '$'
    return j + 1
  }
  while (i < raw.length) {
    const ch = raw[i] ?? ''
    if (ch === "'") {
      const close = raw.indexOf("'", i + 1)
      value += raw.slice(i + 1, close < 0 ? raw.length : close)
      i = close < 0 ? raw.length : close + 1
    } else if (ch === '"') {
      i++
      while (i < raw.length && raw[i] !== '"') {
        const c = raw[i] ?? ''
        if (c === '\\' && '"\\$`\n'.includes(raw[i + 1] ?? 'x')) {
          value += raw[i + 1] === '\n' ? '' : raw[i + 1]
          i += 2
        } else if (c === '$') {
          i = dollar(i)
        } else if (c === '`') {
          const end = skipBacktick(raw, i + 1)
          value += raw.slice(i, end)
          isResolved = false
          i = end
        } else {
          value += c
          i++
        }
      }
      i++
    } else if (ch === '\\') {
      value += raw[i + 1] === '\n' ? '' : (raw[i + 1] ?? '')
      i += 2
    } else if (ch === '$') {
      i = dollar(i)
    } else if (ch === '`') {
      const end = skipBacktick(raw, i + 1)
      value += raw.slice(i, end)
      isResolved = false
      i = end
    } else {
      if (ch === '*' || ch === '?' || ch === '[') {
        isResolved = false
      }
      value += ch
      i++
    }
  }
  return { value, isResolved }
}

/** An absolute path with `.`, `..` and repeated slashes folded away. */
export const normalizePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return `/${parts.join('/')}`
}

/** The absolute path a value names from `cwd`; null when it is relative and the directory is unknown. */
export const resolvePath = (value: string, cwd: string | null): string | null =>
  value.startsWith('/') ? normalizePath(value) : cwd ? normalizePath(`${cwd}/${value}`) : null

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

// ---------------------------------------------------------------------------------------------
// Finding the slicer opens

/** A file an `open` hands to the slicer. */
export type OpenFile = {
  /** The argument as written in the command. */
  raw: string
  /** Its value: quotes removed, and what could be expanded expanded. */
  written: string
  /** The absolute path it names, or null when a variable, glob or unknown directory leaves it open. */
  path: string | null
  /** What an earlier `cp` or `mv` in the same command put there, when one did. */
  copiedFrom: { written: string; path: string | null } | null
}

/** One `open` of a slicer in a command. */
export type SlicerOpen = {
  slicer: Slicer
  /** Where the words that choose the app sit (`-a BambuStudio`, `-b <id>`), and the other short flags sharing them. */
  selector: { start: number; end: number; keep: string }
  /** Those words as written. */
  selectorText: string
  files: OpenFile[]
}

/** Where a command starts: the session's directory and the home directory, when known. */
export type Place = { cwd: string | null; home: string | null }

const APPS: Readonly<Record<string, Slicer>> = {
  bambustudio: 'bambu',
  snapmakerorca: 'snapmaker',
  orcaslicer: 'orca',
}

/** The slicer an `open -a` value names: a name with or without spaces, or an `.app` path. */
export const slicerOfApp = (app: string): Slicer | null => {
  const key = baseName(app)
    .replace(/\.app$/i, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return APPS[key] ?? null
}

/** The slicer an `open -b` bundle id names. */
export const slicerOfBundle = (bundle: string): Slicer | null => {
  const id = bundle.trim().toLowerCase()
  const found = (Object.keys(SLICERS) as Slicer[]).find(slicer => SLICERS[slicer].bundle.toLowerCase() === id)
  return found ?? null
}

const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time'])
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'builtin'])
const DECLARES = new Set(['export', 'declare', 'readonly', 'local', 'typeset'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** A redirection word: `>x`, `2>&1`, `&>x`, `<x`, `<<EOF`. */
const REDIRECT = /^(?:\d+|&)?(?:>>?|<<?<?|>&|<&|>\|)/
/** A redirection whose target is the next word. */
const REDIRECT_ALONE = /^(?:\d+|&)?(?:>>?|<|<<<|>\|)$/
/** Long `open` flags that take the next word. */
const OPEN_VALUE_FLAGS = new Set(['--env', '--stdin', '--stdout', '--stderr', '--arch'])

type Scope = {
  vars: Map<string, string | null>
  cwd: string | null
  home: string | null
  copies: Map<string, { written: string; path: string | null }>
}

function assign(scope: Scope, raw: string) {
  const eq = raw.indexOf('=')
  const expanded = expandWord(raw.slice(eq + 1), scope.vars, scope.home)
  scope.vars.set(raw.slice(0, eq), expanded.isResolved ? expanded.value : null)
}

const operands = (words: readonly Word[]): Word[] => {
  const kept: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]?.raw ?? ''
    if (REDIRECT.test(raw)) {
      i += REDIRECT_ALONE.test(raw) ? 1 : 0
    } else if (!raw.startsWith('-')) {
      kept.push(words[i] as Word)
    }
  }
  return kept
}

function changeDir(scope: Scope, args: readonly Word[]) {
  const [target] = operands(args)
  if (!target) {
    scope.cwd = scope.home
    scope.vars.set('PWD', scope.cwd)
    return
  }
  const expanded = expandWord(target.raw, scope.vars, scope.home)
  scope.cwd = expanded.isResolved && expanded.value !== '-' ? resolvePath(expanded.value, scope.cwd) : null
  scope.vars.set('PWD', scope.cwd)
}

function noteCopy(scope: Scope, args: readonly Word[]) {
  const words = operands(args)
  const dest = words.pop()
  if (!dest || words.length === 0) {
    return
  }
  const to = expandWord(dest.raw, scope.vars, scope.home)
  const destKey = (to.isResolved ? resolvePath(to.value, scope.cwd) : null) ?? to.value
  for (const source of words) {
    const from = expandWord(source.raw, scope.vars, scope.home)
    const copied = { written: from.value, path: from.isResolved ? resolvePath(from.value, scope.cwd) : null }
    scope.copies.set(`${destKey.replace(/\/+$/, '')}/${baseName(from.value)}`, copied)
    if (words.length === 1) {
      scope.copies.set(destKey, copied)
    }
  }
}

function parseOpen(command: string, scope: Scope, args: readonly Word[]): SlicerOpen | null {
  let selector: { kind: 'a' | 'b'; value: string; start: number; end: number; keep: string } | null = null
  const fileWords: Word[] = []
  let isOnlyFiles = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as Word
    const raw = word.raw
    if (raw === '--args') {
      break
    }
    if (REDIRECT.test(raw)) {
      i += REDIRECT_ALONE.test(raw) ? 1 : 0
      continue
    }
    if (!isOnlyFiles && raw === '--') {
      isOnlyFiles = true
      continue
    }
    if (!isOnlyFiles && raw.startsWith('--')) {
      i += OPEN_VALUE_FLAGS.has(raw) ? 1 : 0
      continue
    }
    if (!isOnlyFiles && /^-[A-Za-z]/.test(raw)) {
      const group = raw.slice(1)
      for (let k = 0; k < group.length; k++) {
        const flag = group[k]
        if (flag === 'a' || flag === 'b') {
          const attached = group.slice(k + 1)
          const valueWord = attached ? undefined : args[i + 1]
          if (attached || valueWord) {
            selector = {
              kind: flag,
              value: expandWord(attached || (valueWord as Word).raw, scope.vars, scope.home).value,
              start: word.start,
              end: (valueWord ?? word).end,
              keep: group.slice(0, k),
            }
            i += valueWord ? 1 : 0
          }
          break
        }
        if (flag === 's') {
          i += group.slice(k + 1) ? 0 : 1
          break
        }
      }
      continue
    }
    fileWords.push(word)
  }
  if (!selector || fileWords.length === 0) {
    return null
  }
  const slicer = selector.kind === 'a' ? slicerOfApp(selector.value) : slicerOfBundle(selector.value)
  if (!slicer) {
    return null
  }
  const files = fileWords.map((word): OpenFile => {
    const expanded = expandWord(word.raw, scope.vars, scope.home)
    const path = expanded.isResolved ? resolvePath(expanded.value, scope.cwd) : null
    return { raw: word.raw, written: expanded.value, path, copiedFrom: scope.copies.get(path ?? expanded.value) ?? null }
  })
  return {
    slicer,
    selector: { start: selector.start, end: selector.end, keep: selector.keep },
    selectorText: command.slice(selector.start, selector.end),
    files,
  }
}

/**
 * Every `open` of a slicer in a Bash command (`open -a <app>` or `open -b <bundle id>` with one or
 * more files), in order, with each file resolved as far as the command allows: `~`, `$HOME`, `$PWD`,
 * variables assigned earlier in it, a preceding `cd`, and what an earlier `cp`/`mv` copied there.
 */
export const findSlicerOpens = (command: string, place: Place): SlicerOpen[] => {
  const scope: Scope = { vars: new Map([['PWD', place.cwd]]), cwd: place.cwd, home: place.home, copies: new Map() }
  const opens: SlicerOpen[] = []
  for (const segment of splitCommand(command)) {
    let words = segment
    while (words[0] && KEYWORDS.has(words[0].raw)) {
      words = words.slice(1)
    }
    let leading = 0
    while (words[leading] && ASSIGNMENT.test(words[leading]?.raw ?? '')) {
      leading++
    }
    if (leading === words.length) {
      for (const word of words) {
        assign(scope, word.raw)
      }
      continue
    }
    words = words.slice(leading)
    while (words[0] && WRAPPERS.has(words[0].raw)) {
      words = words.slice(1)
    }
    const [head, ...args] = words
    if (!head) {
      continue
    }
    const name = expandWord(head.raw, scope.vars, scope.home).value
    if (DECLARES.has(name)) {
      for (const word of args) {
        if (ASSIGNMENT.test(word.raw)) {
          assign(scope, word.raw)
        }
      }
    } else if (name === 'cd' || name === 'pushd') {
      changeDir(scope, args)
    } else if (name === 'cp' || name === 'mv') {
      noteCopy(scope, args)
    } else if (name === 'open' || name === '/usr/bin/open') {
      const found = parseOpen(command, scope, args)
      if (found) {
        opens.push(found)
      }
    }
  }
  return opens
}

/** Whether a command could hold an `open` at all: the cheap test before parsing it. */
export const mentionsOpen = (command: string): boolean => /(?:^|[\s;&|(/])open\s/.test(command)

/**
 * The command with each of these opens pointed at another slicer: only the words choosing the
 * app change (`-a BambuStudio` becomes `-b com.snapmaker.snapmaker-orca`); every other byte stays.
 */
export const rewriteOpens = (command: string, opens: readonly SlicerOpen[], to: Slicer): string =>
  [...opens]
    .sort((a, b) => b.selector.start - a.selector.start)
    .reduce(
      (text, open) =>
        `${text.slice(0, open.selector.start)}${open.selector.keep ? `-${open.selector.keep} ` : ''}-b ${SLICERS[to].bundle}${text.slice(open.selector.end)}`,
      command,
    )

// ---------------------------------------------------------------------------------------------
// Full-spectrum files

/** Whether a file's path (its name or a folder), or the path it was copied from, says full-spectrum. */
export const nameSaysFullSpectrum = (file: OpenFile, pattern: RegExp): boolean =>
  [file.written, file.path, file.copiedFrom?.written, file.copiedFrom?.path].some(
    text => typeof text === 'string' && text !== '' && pattern.test(text),
  )

/** The resolved 3MF paths whose contents can say: the file itself, then what was copied to it. */
export const contentPaths = (file: OpenFile): string[] =>
  [...new Set([file.path, file.copiedFrom?.path])].filter(
    (path): path is string => typeof path === 'string' && /\.3mf$/i.test(path),
  )

export const fileName = (file: OpenFile): string => baseName(file.path ?? file.written)

// ---------------------------------------------------------------------------------------------
// Closing previous instances

/** How many processes `pgrep` listed. */
export const countPids = (stdout: string): number => stdout.split('\n').filter(line => /^\s*\d+\s*$/.test(line)).length

/** The AppleScript for a normal quit, the same as Cmd-Q: the app still asks to save unsaved work. */
export const quitScript = (slicer: Slicer): string => `quit app id "${SLICERS[slicer].bundle}"`

// ---------------------------------------------------------------------------------------------
// /slice

const SLICE_WORDS: Readonly<Record<string, Slicer>> = { bambu: 'bambu', snapmaker: 'snapmaker', snap: 'snapmaker', orca: 'orca' }

/** `/slice <file> [bambu|snapmaker|orca]`: the file, resolved, and the slicer asked for, if one was. */
export const parseSliceArgs = (args: string, place: Place): { file: OpenFile | null; wanted: Slicer | null } => {
  const words = splitCommand(args).flat()
  const last = words.at(-1)
  const lastValue = last ? expandWord(last.raw, new Map(), place.home).value : ''
  const wanted = words.length > 1 ? (SLICE_WORDS[lastValue.toLowerCase()] ?? slicerOfApp(lastValue)) : null
  const fileWords = wanted ? words.slice(0, -1) : words
  if (fileWords.length === 0) {
    return { file: null, wanted }
  }
  const expanded = fileWords.map(word => expandWord(word.raw, new Map(), place.home))
  const written = expanded.map(part => part.value).join(' ')
  const isResolved = expanded.every(part => part.isResolved)
  return {
    file: {
      raw: args.slice(fileWords[0]?.start ?? 0, fileWords.at(-1)?.end ?? args.length),
      written,
      path: isResolved ? resolvePath(written, place.cwd) : null,
      copiedFrom: null,
    },
    wanted,
  }
}

// ---------------------------------------------------------------------------------------------
// What the person and the model are told

const shortName = (slicer: Slicer): string => (slicer === 'bambu' ? 'Bambu' : SLICERS[slicer].label)

const listed = (names: readonly string[]): string => names.join(', ')

export const rerouteToast = (from: Slicer, names: readonly string[]): string =>
  `${shortName(from)} can't open full-spectrum files: opened ${listed(names)} in Snapmaker Orca instead`

export const rerouteNote = (open: SlicerOpen, names: readonly string[]): string =>
  `slicer-handoff: ${listed(names)} ${names.length === 1 ? 'is a full-spectrum (Snapmaker U1) file' : 'are full-spectrum (Snapmaker U1) files'}, ` +
  `which ${SLICERS[open.slicer].label} cannot open (it crashes), so \`${open.selectorText}\` was changed to ` +
  `\`-b ${SLICERS.snapmaker.bundle}\` and the open went to Snapmaker Orca instead. ` +
  `Full-spectrum files must always be opened in Snapmaker Orca (\`open -b ${SLICERS.snapmaker.bundle} <file>\`), never in Bambu Studio or OrcaSlicer.`

export const closedToast = (slicer: Slicer, closed: number, name: string): string =>
  `Closed ${closed} ${SLICERS[slicer].label} window(s) before opening ${name}`

export const stillOpenNote = (slicer: Slicer, left: number): string =>
  `slicer-handoff: ${left === 1 ? 'an instance' : `${left} instances`} of ${SLICERS[slicer].label} ${left === 1 ? 'is' : 'are'} still open after a normal quit request, ` +
  'most likely asking whether to save unsaved changes. Do not open more windows of it and do not quit or kill it yourself; ' +
  'tell the user it is waiting for them.'
