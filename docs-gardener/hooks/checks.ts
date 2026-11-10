import type { DocsFinding, DocsFindingKind } from '../types'
import { ENTRY_DOCS, baseName, datedName, folderOf, joinPath, normalisePath, rollupPath } from './scope'

/** One doc as the checks read it: its path relative to the repo root and its text. */
export type Doc = { file: string; text: string }

export const DAY_MS = 86_400_000
/** The most existence and code lookups one doc may cost. */
export const MAX_LOOKUPS = 40
/** A paragraph shorter than this is never a duplicate: boilerplate repeats. */
export const MIN_PARAGRAPH = 200

/** The text's lines, a final newline not counted as a line. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

const finding = (file: string, line: number, kind: DocsFindingKind, text: string, suggestion: string): DocsFinding => ({
  file,
  line,
  kind,
  text,
  suggestion,
})

export const byPlace = (a: DocsFinding, b: DocsFinding): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)

export const sortFindings = (findings: readonly DocsFinding[]): DocsFinding[] => [...findings].sort(byPlace)

const FENCE = /^\s*(```|~~~)/

/** Inline code spans with their 1-based line; fenced blocks are skipped. */
export function inlineCode(text: string): { token: string; line: number }[] {
  const out: { token: string; line: number }[] = []
  let isFenced = false
  splitLines(text).forEach((line, i) => {
    if (FENCE.test(line)) {
      isFenced = !isFenced
      return
    }
    if (isFenced) {
      return
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      out.push({ token: (match[1] ?? '').trim(), line: i + 1 })
    }
  })
  return out
}

export type Reference = { kind: 'path' | 'make' | 'identifier'; token: string; line: number }

/** Characters that mark a span as a command, a template, a URL or prose rather than a path. */
const NOT_A_PATH = /[\s<>{}*$=@()\\|"']|:\/\//
/** Suffixes that are domains, not file extensions. */
const DOMAINS = new Set(['com', 'org', 'net', 'io', 'ai', 'app', 'co', 'edu', 'gov', 'me'])

const isIdentifierLike = (token: string): boolean =>
  token.length >= 6 && (/[A-Za-z0-9]_[A-Za-z0-9]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token))

/** What one inline code span refers to: a path, a make target, an identifier, or nothing checkable. */
function classify(token: string): { kind: Reference['kind']; token: string } | null {
  const make = /^make\s+([A-Za-z0-9_.\/-]+)(?:\s|$)/.exec(token)
  if (make && make[1] !== undefined && !make[1].startsWith('-')) {
    return { kind: 'make', token: make[1] }
  }
  if (NOT_A_PATH.test(token) || token.startsWith('-') || token.startsWith('~')) {
    return null
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
    return isIdentifierLike(token) ? { kind: 'identifier', token } : null
  }
  const bare = token.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '')
  if (bare === '' || bare === '.' || bare === '..') {
    return null
  }
  if (bare.includes('/')) {
    return { kind: 'path', token: bare }
  }
  const dotted = /^(.+)\.([A-Za-z0-9]{1,6})$/.exec(bare)
  if (!dotted) {
    return null
  }
  const [, name = '', suffix = ''] = dotted
  if (name.length < 2 || /^\d+$/.test(suffix) || DOMAINS.has(suffix.toLowerCase())) {
    return null
  }
  return { kind: 'path', token: bare }
}

/** Every checkable reference in the doc, each path, target or identifier once, at its first line. */
export function findReferences(text: string): Reference[] {
  const seen = new Set<string>()
  const out: Reference[] = []
  for (const { token, line } of inlineCode(text)) {
    const ref = classify(token)
    if (ref === null || seen.has(`${ref.kind}:${ref.token}`)) {
      continue
    }
    seen.add(`${ref.kind}:${ref.token}`)
    out.push({ ...ref, line })
  }
  return out
}

export type DeadReferenceLookups = {
  /** Whether a path exists, relative to the repo root. */
  exists: (rel: string) => Promise<boolean>
  /** Whether the identifier occurs whole-word in the code (anything but markdown). */
  inCode: (identifier: string) => Promise<boolean>
  /** The Makefile's targets; null when the repo has no Makefile. */
  makeTargets: ReadonlySet<string> | null
}

/** The paths tried for a token: from the root, and from the doc's folder. */
export const pathCandidates = (file: string, token: string): string[] =>
  [...new Set([normalisePath(token.replace(/^\//, '')), joinPath(folderOf(file), token)])].filter(candidate => candidate !== '')

/**
 * References to what is not there: a path that exists neither from the root nor from the doc's folder,
 * a make target the Makefile lacks, an identifier the code does not have (the first MAX_LOOKUPS lookups).
 */
export async function deadReferences(doc: Doc, lookups: DeadReferenceLookups): Promise<DocsFinding[]> {
  const out: DocsFinding[] = []
  let left = MAX_LOOKUPS
  for (const ref of findReferences(doc.text)) {
    if (ref.kind === 'make') {
      if (!lookups.makeTargets?.has(ref.token)) {
        out.push(finding(doc.file, ref.line, 'dead-reference', `runs make ${ref.token}, which the Makefile has no target for`, 'Name a current make target or remove it.'))
      }
      continue
    }
    if (left <= 0) {
      break
    }
    left -= 1
    if (ref.kind === 'identifier') {
      if (!(await lookups.inCode(ref.token))) {
        out.push(
          finding(doc.file, ref.line, 'dead-reference', `names ${ref.token}, which is not found in the code`, 'Rename it to what the code calls it now, or remove it.'),
        )
      }
      continue
    }
    let isFound = false
    for (const candidate of pathCandidates(doc.file, ref.token)) {
      if (await lookups.exists(candidate)) {
        isFound = true
        break
      }
    }
    if (!isFound) {
      out.push(finding(doc.file, ref.line, 'dead-reference', `references ${ref.token}, which no longer exists`, 'Point it at the current path or remove the reference.'))
    }
  }
  return out
}

/** The targets a Makefile declares (`name:`; `.PHONY` and `:=` assignments are not targets). */
export function makeTargets(makefile: string): Set<string> {
  const out = new Set<string>()
  for (const line of makefile.split('\n')) {
    const match = /^([A-Za-z0-9_.\/ -]+?)\s*:(?!=)/.exec(line)
    if (!match) {
      continue
    }
    for (const name of (match[1] ?? '').trim().split(/\s+/)) {
      if (name !== '' && !name.startsWith('.')) {
        out.add(name)
      }
    }
  }
  return out
}

/** When each line was last committed, from `git blame --line-porcelain`: epoch ms, or null for a line not committed yet. */
export function parseBlame(porcelain: string): Map<number, number | null> {
  const out = new Map<number, number | null>()
  let line: number | null = null
  let isUncommitted = false
  let time: number | null = null
  for (const row of porcelain.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row)
    if (header) {
      line = Number(header[2])
      isUncommitted = /^0+$/.test(header[1] ?? '')
      time = null
      continue
    }
    if (row.startsWith('author-time ')) {
      time = Number(row.slice('author-time '.length)) * 1000
      continue
    }
    if (row.startsWith('\t') && line !== null) {
      out.set(line, isUncommitted || time === null ? null : time)
      line = null
    }
  }
  return out
}

/** When a line was last committed, in epoch ms; null when it is not committed or unknown. */
export type LineAge = (line: number) => number | null

const MARKER = /\b(TODO|FIXME|TBD|XXX)\b/
const UNCHECKED = /^\s*[-*+]\s+\[ \]\s/

/** Whether the text has any marker a stale-marker check would look at. */
export const hasMarkers = (text: string): boolean => MARKER.test(text) || /^\s*[-*+]\s+\[ \]\s/m.test(text)

/** TODO, FIXME, TBD and XXX lines and unchecked `- [ ]` items whose last commit is `staleDays` or more old. */
export function staleMarkers(doc: Doc, committedAt: LineAge, now: number, staleDays: number): DocsFinding[] {
  const out: DocsFinding[] = []
  splitLines(doc.text).forEach((content, i) => {
    const label = MARKER.exec(content)?.[1] ?? (UNCHECKED.test(content) ? 'unchecked item' : null)
    if (label === null) {
      return
    }
    const at = committedAt(i + 1)
    if (at === null) {
      return
    }
    const days = Math.floor((now - at) / DAY_MS)
    if (days < staleDays) {
      return
    }
    out.push(
      finding(doc.file, i + 1, 'stale-marker', `${label} open for ${days} days: ${content.trim().slice(0, 120)}`, 'Do it and record the outcome, or drop the line.'),
    )
  })
  return out
}

export type Paragraph = {
  /** 1-based first and last line. */
  start: number
  end: number
  text: string
  /** The nearest heading above, without its marks; null before the first. */
  heading: string | null
}

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/

/** The doc's paragraphs: runs of non-blank lines outside fenced code, headings standing apart. */
export function paragraphs(text: string): Paragraph[] {
  const out: Paragraph[] = []
  let heading: string | null = null
  let isFenced = false
  let block: string[] = []
  let start = 0
  const flush = (): void => {
    if (block.length > 0) {
      out.push({ start, end: start + block.length - 1, text: block.join('\n'), heading })
    }
    block = []
  }
  splitLines(text).forEach((line, i) => {
    if (FENCE.test(line)) {
      flush()
      isFenced = !isFenced
      return
    }
    if (isFenced) {
      return
    }
    const head = HEADING.exec(line)
    if (head) {
      flush()
      heading = head[1] ?? ''
      return
    }
    if (line.trim() === '') {
      flush()
      return
    }
    if (block.length === 0) {
      start = i + 1
    }
    block.push(line)
  })
  flush()
  return out
}

/** Emphasis marks dropped, whitespace collapsed, case folded: two renderings of one paragraph compare equal. */
export const normaliseParagraph = (text: string): string => text.toLowerCase().replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim()

type Occurrence = { file: string; line: number; heading: string | null }

const duplicate = (hit: Occurrence, other: Occurrence): DocsFinding =>
  finding(
    hit.file,
    hit.line,
    'duplicate-paragraph',
    `${hit.heading ? `the "${hit.heading}" paragraph` : `the paragraph at line ${hit.line}`} duplicates ${other.file}:${other.line}`,
    'Keep one copy and link to it from the other.',
  )

/**
 * Paragraphs of MIN_PARAGRAPH characters or more that another file has too. Over a corpus each copy after
 * the first (in the docs' order) is flagged against the first; for `only`, that file's copies are flagged
 * against whichever other file has them.
 */
export function duplicateParagraphs(docs: readonly Doc[], only?: string): DocsFinding[] {
  const groups = new Map<string, Occurrence[]>()
  for (const doc of docs) {
    for (const paragraph of paragraphs(doc.text)) {
      if (paragraph.text.length < MIN_PARAGRAPH) {
        continue
      }
      const key = normaliseParagraph(paragraph.text)
      groups.set(key, [...(groups.get(key) ?? []), { file: doc.file, line: paragraph.start, heading: paragraph.heading }])
    }
  }
  const out: DocsFinding[] = []
  for (const hits of groups.values()) {
    if (new Set(hits.map(hit => hit.file)).size < 2) {
      continue
    }
    if (only !== undefined) {
      const other = hits.find(hit => hit.file !== only)
      for (const hit of hits.filter(one => one.file === only)) {
        if (other) {
          out.push(duplicate(hit, other))
        }
      }
      continue
    }
    const first = hits[0]
    for (const hit of hits.slice(1)) {
      if (first && hit.file !== first.file) {
        out.push(duplicate(hit, first))
      }
    }
  }
  return sortFindings(out)
}

/** The in-repo targets of the doc's `](path)` links, resolved from its folder, anchors dropped. */
export function linkTargets(doc: Doc): string[] {
  const out = new Set<string>()
  const folder = folderOf(doc.file)
  for (const match of doc.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = (match[1] ?? '').replace(/#.*$/, '')
    if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      continue
    }
    out.add(raw.startsWith('/') ? normalisePath(raw.slice(1)) : joinPath(folder, raw))
  }
  return [...out]
}

export type OrphanCandidate = {
  file: string
  /** The paths it links to or names in code spans, each as it might exist from the root or the doc's folder. */
  refs: string[]
}

/** The docs no doc links to (entry docs aside) that reference something: the ones git can then date. */
export function orphanCandidates(docs: readonly Doc[]): OrphanCandidate[] {
  const linked = new Set(docs.flatMap(linkTargets))
  const out: OrphanCandidate[] = []
  for (const doc of docs) {
    if (ENTRY_DOCS.has(baseName(doc.file)) || linked.has(doc.file)) {
      continue
    }
    const refs = new Set<string>(linkTargets(doc))
    for (const ref of findReferences(doc.text)) {
      if (ref.kind === 'path') {
        for (const candidate of pathCandidates(doc.file, ref.token)) {
          refs.add(candidate)
        }
      }
    }
    const list = [...refs].filter(ref => !ref.startsWith('..')).slice(0, 50)
    if (list.length > 0) {
      out.push({ file: doc.file, refs: list })
    }
  }
  return out
}

/** The orphan finding for a candidate untouched for `orphanDays` while any of its references changed. */
export function orphanFinding(
  candidate: OrphanCandidate,
  lastTouched: number | null,
  changed: readonly string[],
  now: number,
  orphanDays: number,
): DocsFinding | null {
  if (lastTouched === null || changed.length === 0) {
    return null
  }
  const days = Math.floor((now - lastTouched) / DAY_MS)
  if (days < orphanDays) {
    return null
  }
  const shown = `${changed.slice(0, 2).join(', ')}${changed.length > 2 ? ` and ${changed.length - 2} more` : ''}`
  return finding(
    candidate.file,
    0,
    'orphan',
    `no doc links to it; untouched for ${days} days while ${shown} changed`,
    'Link it from a current doc and bring it up to date, or move it to docs/archive/.',
  )
}

/** Folders holding more than `seriesRollupAt` files named with a date, each offered a roll-up. */
export function datedSeries(files: readonly string[], seriesRollupAt: number, now: number): DocsFinding[] {
  const byFolder = new Map<string, string[]>()
  for (const file of files) {
    const day = datedName(baseName(file))
    if (day === null) {
      continue
    }
    const folder = folderOf(file)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), day])
  }
  const out: DocsFinding[] = []
  for (const [folder, days] of [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (days.length <= seriesRollupAt) {
      continue
    }
    const sorted = [...days].sort()
    const shown = folder === '' ? './' : `${folder}/`
    out.push(
      finding(
        shown,
        0,
        'dated-series',
        `${days.length} dated files, ${sorted[0]} to ${sorted.at(-1)}`,
        `Roll them up into ${rollupPath(shown, now)} and keep the dailies.`,
      ),
    )
  }
  return out
}

/** A doc over `maxLines` lines. */
export function oversized(doc: Doc, maxLines: number): DocsFinding | null {
  const count = splitLines(doc.text).length
  return count > maxLines
    ? finding(doc.file, 0, 'oversized', `${count} lines, over the ${maxLines}-line limit`, 'Split it by topic, or move the reference material into a doc of its own.')
    : null
}

const DONE = new Set(['done', 'complete', 'completed', 'finished', 'shipped', 'closed', 'archived', 'superseded'])

/** A plan that is over: a front-matter `status:` saying so, or an "Outcome" section; suggested for docs/archive/. */
export function finishedPlan(doc: Doc): DocsFinding | null {
  if (doc.file.startsWith('docs/archive/') || doc.file.includes('/archive/')) {
    return null
  }
  const lines = splitLines(doc.text)
  const archive = `git mv ${doc.file} docs/archive/${baseName(doc.file)}`
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i]?.trim() !== '---'; i++) {
      const status = /^status:\s*["']?([^"'\n]+?)["']?\s*$/i.exec(lines[i] ?? '')
      const value = status?.[1]?.trim()
      if (value !== undefined && DONE.has(value.toLowerCase())) {
        return finding(doc.file, i + 1, 'finished-plan', `a finished plan (status: ${value})`, archive)
      }
    }
  }
  const outcome = lines.findIndex(line => /^#{1,6}\s+Outcome\b/i.test(line))
  return outcome >= 0 ? finding(doc.file, outcome + 1, 'finished-plan', 'a finished plan (an "Outcome" section)', archive) : null
}
