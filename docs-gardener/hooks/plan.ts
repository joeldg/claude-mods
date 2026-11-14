import type { DocsFinding, DocsPlanItem, DocsVerdict } from '../types'
import type { Doc } from './checks'
import { splitLines } from './checks'

export { rollupPath } from './scope'

/** What the model is told about the project beside the file. */
export type FactSheet = {
  repo: string
  defaultBranch: string | null
  /** The top-level folders, the excluded ones left out. */
  folders: string[]
  /** The last commit subjects, newest first. */
  commits: string[]
}

/** The most characters of a file (or of a series) one prompt carries. */
export const MAX_PROMPT_CHARS = 60_000

export const DOC_VERDICTS: readonly DocsVerdict[] = ['current', 'update', 'stray', 'duplicate', 'delete']
const SERIES_VERDICTS: readonly DocsVerdict[] = ['current', 'rollup']

export type DocsCommand =
  | { kind: 'audit'; path: string | null; isChanged: boolean; isApply: boolean }
  | { kind: 'check'; path: string }
  | { kind: 'show' }
  | { kind: 'help' }
  | { kind: 'usage'; message: string }

/** Reads `/garden audit [path|--changed] [--apply]`, `/garden check <path>`, `/garden show`, `/garden help`. */
export function parseArgs(args: string): DocsCommand {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')
  if (verb === '' || verb === 'help') {
    return { kind: 'help' }
  }
  if (verb === 'show') {
    return { kind: 'show' }
  }
  if (verb === 'check') {
    const path = rest[0]
    return rest.length === 1 && path !== undefined ? { kind: 'check', path } : { kind: 'usage', message: '/garden check takes one path.' }
  }
  if (verb !== 'audit') {
    return { kind: 'usage', message: `/garden ${verb} is not a command.` }
  }
  let path: string | null = null
  let isChanged = false
  let isApply = false
  for (const word of rest) {
    if (word === '--changed') {
      isChanged = true
    } else if (word === '--apply') {
      isApply = true
    } else if (word.startsWith('-')) {
      return { kind: 'usage', message: `${word} is not a flag of /garden audit.` }
    } else if (path === null) {
      path = word
    } else {
      return { kind: 'usage', message: '/garden audit takes one path.' }
    }
  }
  return { kind: 'audit', path, isChanged, isApply }
}

export const usage = (): string =>
  [
    'Usage: /garden audit [path|--changed] [--apply]',
    '  audit            every markdown file in scope: the deterministic checks, then one model call per flagged file for an edit plan, shown in a pane',
    '  audit <path>     one file or folder',
    '  audit --changed  the docs changed on this branch against the default branch (on the default branch: the last 7 days and the working tree)',
    '  --apply          apply every plan item as it arrives, without the pane (for a scheduled run); the diffs go to the debug log',
    '  check <path>     the deterministic findings alone, no model call (what the docs_check tool answers Claude)',
    '  show             reopen the last audit',
  ].join('\n')

/** 0-based, inclusive. */
export type Range = { start: number; end: number }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

export const isHeading = (line: string): boolean => HEADING.test(line)

const normaliseHeading = (text: string): string =>
  text
    .replace(/^#+\s*/, '')
    .replace(/[`*_"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** The last line that has content, or -1 for an empty file. */
const contentEnd = (lines: readonly string[]): number => {
  let end = lines.length - 1
  while (end >= 0 && (lines[end] ?? '').trim() === '') {
    end -= 1
  }
  return end
}

const RANGE = /^(?:L|lines?\s*)?(\d+)\s*(?:-|–|to|,)\s*(?:L|line\s*)?(\d+)$/i
const SINGLE = /^(?:L|line\s*)?(\d+)$/i

const stripQuotes = (section: string): string => section.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()

/** A line-range section (`12-20`, `L12-L20`, `line 14`) as 0-based bounds, unclamped; null for any other spelling. */
export function rangeSpec(section: string): Range | null {
  const spec = stripQuotes(section)
  const range = RANGE.exec(spec)
  if (range) {
    return { start: Number(range[1]) - 1, end: Number(range[2]) - 1 }
  }
  const single = SINGLE.exec(spec)
  return single ? { start: Number(single[1]) - 1, end: Number(single[1]) - 1 } : null
}

/**
 * The lines a plan item's section names: a heading's text (its section runs to the next heading of its
 * level or above, trailing blank lines left out), a line range, a single line, or the whole file.
 */
export function sectionRange(lines: readonly string[], section: string): Range | null {
  const last = contentEnd(lines)
  if (last < 0) {
    return null
  }
  const spec = stripQuotes(section)
  if (/^(whole file|entire file|file|all|\*)$/i.test(spec)) {
    return { start: 0, end: last }
  }
  const range = rangeSpec(spec)
  if (range) {
    const end = Math.min(range.end, last)
    return range.start >= 0 && range.start <= end ? { start: range.start, end } : null
  }
  const wanted = normaliseHeading(spec)
  if (wanted === '') {
    return null
  }
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i] ?? '')
    if (!match || normaliseHeading(match[2] ?? '') !== wanted) {
      continue
    }
    const level = (match[1] ?? '').length
    let end = lines.length - 1
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING.exec(lines[j] ?? '')
      if (next && (next[1] ?? '').length <= level) {
        end = j - 1
        break
      }
    }
    while (end > i && (lines[end] ?? '').trim() === '') {
      end -= 1
    }
    return { start: i, end }
  }
  return null
}

/** The JSON array in a reply, fences and prose around it ignored; null when none parses. */
function jsonArray(reply: string): unknown[] | null {
  let from = 0
  for (let tries = 0; tries < 5; tries++) {
    const start = reply.indexOf('[', from)
    const end = reply.lastIndexOf(']')
    if (start < 0 || end <= start) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(reply.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // Try from the next bracket: the first may sit in prose.
    }
    from = start + 1
  }
  return null
}

/**
 * The model's edit plan, read defensively: an item needs a section the file has (any section for a
 * series), a known verdict, and text where the verdict rewrites; a second item for one section is dropped.
 * `isPlan` is false when the reply held no JSON array at all.
 */
export function parsePlan(reply: string, lines: readonly string[], isSeries: boolean): { isPlan: boolean; items: DocsPlanItem[] } {
  const parsed = jsonArray(reply)
  if (parsed === null) {
    return { isPlan: false, items: [] }
  }
  const allowed = isSeries ? SERIES_VERDICTS : DOC_VERDICTS
  const items: DocsPlanItem[] = []
  const seen = new Set<string>()
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') {
      continue
    }
    const { section, verdict, reason, replacement } = raw as Record<string, unknown>
    if (typeof section !== 'string' || section.trim() === '' || section.length > 200 || typeof verdict !== 'string') {
      continue
    }
    const known = allowed.find(one => one === verdict)
    if (known === undefined) {
      continue
    }
    const text = typeof replacement === 'string' ? replacement : null
    if ((known === 'update' || known === 'rollup') && text === null) {
      continue
    }
    const key = isSeries ? known : normaliseHeading(stripQuotes(section))
    if (seen.has(key)) {
      continue
    }
    let anchor: string | null = null
    if (!isSeries) {
      const range = sectionRange(lines, section)
      if (range === null) {
        continue
      }
      anchor = lines[range.start] ?? null
    }
    seen.add(key)
    items.push({ section: section.trim(), verdict: known, reason: typeof reason === 'string' ? reason.trim() : '', replacement: text, anchor })
  }
  return { isPlan: true, items }
}

/** A unified-style block for the debug log: the lines taken out, then the lines put in. */
export function diffBlock(file: string, range: Range, verdict: string, before: readonly string[], after: readonly string[]): string {
  return [`@@ ${file}:${range.start + 1}-${range.end + 1} (${verdict})`, ...before.map(line => `-${line}`), ...after.map(line => `+${line}`)].join('\n')
}

export type Applied = { text: string; diff: string; range: Range; before: string[]; after: string[] }

/**
 * The file's text with one plan item applied: the section replaced by `replacement`, or removed when it
 * is null. A line range is found again by its anchor when earlier edits moved it; a heading section keeps
 * its heading when the replacement has none; a removal leaves no doubled blank line behind.
 */
export function applyPlanItem(file: string, text: string, item: DocsPlanItem): Applied | { error: string } {
  const lines = text.split('\n')
  const spec = rangeSpec(item.section)
  let range: Range | null
  if (spec !== null && item.anchor !== null) {
    if (lines[spec.start] === item.anchor) {
      range = { start: spec.start, end: Math.min(spec.end, lines.length - 1) }
    } else {
      const at = lines.indexOf(item.anchor)
      if (at < 0) {
        return { error: `line ${spec.start + 1} no longer reads "${item.anchor}", and no line does` }
      }
      if (lines.indexOf(item.anchor, at + 1) >= 0) {
        return { error: `line ${spec.start + 1} no longer reads "${item.anchor}", and more than one line does` }
      }
      range = { start: at, end: Math.min(at + (spec.end - spec.start), lines.length - 1) }
    }
  } else {
    range = sectionRange(lines, item.section)
  }
  if (range === null) {
    return { error: `the section "${item.section}" was not found` }
  }
  if (item.replacement === null && (item.verdict === 'update' || item.verdict === 'rollup')) {
    return { error: 'an update with no replacement text' }
  }
  const before = lines.slice(range.start, range.end + 1)
  let after: string[] = []
  if (item.replacement !== null) {
    after = item.replacement.replace(/\n+$/, '').split('\n')
    const heading = lines[range.start] ?? ''
    if (spec === null && isHeading(heading) && !isHeading(after.find(line => line.trim() !== '') ?? '')) {
      after = [heading, ...after]
    }
  }
  const out = [...lines.slice(0, range.start), ...after, ...lines.slice(range.end + 1)]
  if (after.length === 0) {
    while (range.start > 0 && range.start < out.length && (out[range.start - 1] ?? '').trim() === '' && (out[range.start] ?? '').trim() === '') {
      out.splice(range.start, 1)
    }
  }
  return { text: out.join('\n'), diff: diffBlock(file, range, item.verdict, before, after), range, before, after }
}

/** The inline code spans of some lines, backticks off, each once. */
export function codeSpans(lines: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const line of lines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      out.add(match[1] ?? '')
    }
  }
  out.delete('')
  return out
}

/** The inline code spans `after` no longer has: the paths and names an update drops. */
export function removedCodeSpans(before: readonly string[], after: readonly string[]): string[] {
  const kept = codeSpans(after)
  return [...codeSpans(before)].filter(span => !kept.has(span))
}

const wordsOf = (lines: readonly string[]): string[] => lines.join('\n').split(/\s+/).filter(word => word !== '')

/** Whether `after` says what `before` says, with other line breaks or spacing only. */
export const isWrappingOnly = (before: readonly string[], after: readonly string[]): boolean => wordsOf(before).join(' ') === wordsOf(after).join(' ')

/**
 * `after` laid back on `before`'s lines when it only drops words (a sentence, a parenthesis): the author's line breaks
 * and indentation stay, a line left with no word goes, and a blank line doubled by that goes too. Null when `after`
 * adds or changes a word, so the model's text stands as written.
 */
export function onOriginalLines(before: readonly string[], after: readonly string[]): string[] | null {
  const want = wordsOf(after)
  let w = 0
  const out: string[] = []
  let dropped = false
  for (const line of before) {
    const parts = line.split(/(\s+)/)
    const lead = parts[0] === '' ? (parts[1] ?? '') : ''
    let text = ''
    let hasWord = false
    let kept = false
    for (let i = 0; i < parts.length; i += 2) {
      const word = parts[i] ?? ''
      if (word === '') {
        continue
      }
      hasWord = true
      if (w < want.length && word === want[w]) {
        text += (kept ? (parts[i - 1] ?? ' ') : lead) + word
        kept = true
        w += 1
      }
    }
    if (!hasWord) {
      // A line of no words stays, once, where a dropped line would leave two.
      if (!(dropped && out.at(-1)?.trim() === '')) {
        out.push(line)
      }
      dropped = false
    } else if (kept) {
      out.push(text)
      dropped = false
    } else {
      dropped = true
    }
  }
  return w === want.length ? out : null
}


/** The clauses the write-time note is made of; at most 6, then a count. */
const MAX_CLAUSES = 6

/**
 * The note Claude reads after writing a doc: `docs-gardener: README.md references X, which no longer
 * exists (line 41); the "Known issues" paragraph duplicates docs/runbook.md:88; 3 TODOs are older than
 * 30 days.` Null when the checks found nothing of those three kinds.
 */
export function contextNote(file: string, findings: readonly DocsFinding[], staleDays: number): string | null {
  const clauses: string[] = []
  for (const found of findings) {
    if (found.kind === 'dead-reference') {
      clauses.push(`${found.text} (line ${found.line})`)
    }
  }
  for (const found of findings) {
    if (found.kind === 'duplicate-paragraph') {
      clauses.push(found.text)
    }
  }
  const stale = findings.filter(found => found.kind === 'stale-marker')
  if (stale.length > 0) {
    const count = stale.length
    const isAllTodo = stale.every(found => found.text.startsWith('TODO '))
    const verb = count === 1 ? ' is' : 's are'
    clauses.push(`${count} ${isAllTodo ? `TODO${verb}` : `stale marker${verb}`} older than ${staleDays} days`)
  }
  if (clauses.length === 0) {
    return null
  }
  const shown = clauses.length > MAX_CLAUSES ? [...clauses.slice(0, MAX_CLAUSES), `and ${clauses.length - MAX_CLAUSES} more`] : clauses
  return `docs-gardener: ${file} ${shown.join('; ')}.`
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

export const findingLine = (found: DocsFinding): string => `  ${found.line > 0 ? `L${found.line} ` : ''}${found.kind}: ${found.text}`

/** The findings as text, for the tool and `/garden check`: grouped by file unless the subject is that one file. */
export function describeFindings(findings: readonly DocsFinding[], subject: string): string {
  if (findings.length === 0) {
    return `docs-gardener: nothing to fix in ${subject}.`
  }
  const files = [...new Set(findings.map(found => found.file))]
  const isOneFile = files.length === 1 && files[0] === subject
  const lines = [`docs-gardener: ${plural(findings.length, 'finding')} in ${subject}`]
  for (const file of files) {
    if (!isOneFile) {
      lines.push(file)
    }
    for (const found of findings.filter(one => one.file === file)) {
      lines.push(`${findingLine(found)} — ${found.suggestion}`)
    }
  }
  return lines.join('\n')
}

const numbered = (text: string): string =>
  splitLines(text)
    .map((line, i) => `${i + 1}| ${line}`)
    .join('\n')

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} more characters cut to fit the prompt]`

const factsBlock = (facts: FactSheet): string =>
  [
    'Project fact sheet',
    `- Repository: ${facts.repo}`,
    `- Default branch: ${facts.defaultBranch ?? 'unknown'}`,
    `- Top-level folders: ${facts.folders.join(', ') || 'none'}`,
    `- Last ${facts.commits.length} commit subjects, newest first:`,
    ...facts.commits.map(subject => `  - ${subject}`),
  ].join('\n')

const POLICY = [
  'Policy',
  '- Reference docs describe the current state of the project. Passing thoughts, pasted research dumps and plans that are over do not belong in them.',
  '- A finished plan (a `status:` line saying it is done, or an "Outcome" section) belongs under docs/archive/: say so in the reason of a "current" verdict, with the `git mv` command; never rewrite it into something else.',
  '- Prefer the smallest edit: "update" rewrites one section and carries its full new text, heading included; "delete", "stray" and "duplicate" remove the section (replacement null).',
  '- Never invent facts about the project. When unsure, answer "current".',
  '- The findings are the only checked facts about the code: you see the doc, not the project. Remove a backticked path or name only when a finding calls it dead; one you merely cannot see stays, and an update that drops one the project still has is held back.',
  "- Edit within lines: keep the author's line breaks and indentation, never re-wrap a paragraph. An update that only re-wraps is held back.",
].join('\n')

/** The prompt for one doc: the fact sheet, the policy, the findings, the numbered file, the JSON asked for. */
export function buildPlanPrompt(file: string, text: string, findings: readonly DocsFinding[], facts: FactSheet): string {
  const found =
    findings.length > 0
      ? findings.map(one => `- ${one.line > 0 ? `line ${one.line}: ` : ''}${one.kind}: ${one.text} (${one.suggestion})`).join('\n')
      : '- none'
  return [
    "You are gardening the documentation of a software project. Judge one markdown file against the project's current state and answer with a JSON edit plan only.",
    '',
    factsBlock(facts),
    '',
    POLICY,
    '',
    `File: ${file}`,
    '',
    `Deterministic findings for ${file}`,
    found,
    '',
    `The file, ${plural(splitLines(text).length, 'line')}, each led by its number:`,
    cut(numbered(text), MAX_PROMPT_CHARS),
    '',
    'Answer with a JSON array only, no prose:',
    '[{ "section": "<a heading\'s text, or a line range such as 12-20>", "verdict": "current|update|stray|duplicate|delete", "reason": "<one sentence>", "replacement": "<the section\'s full new text, heading included, or null>" }]',
    'One item per section that needs something; when nothing does, one "current" item for the whole file.',
  ].join('\n')
}

/** The prompt for a dated series: the dailies, oldest first, and the roll-up asked for. */
export function buildRollupPrompt(folder: string, dailies: readonly Doc[], facts: FactSheet, rollup: string): string {
  const parts = dailies.map(doc => `--- ${doc.file} ---\n${doc.text.trimEnd()}`).join('\n\n')
  return [
    'You are gardening the documentation of a software project. A folder holds a series of dated files; write one roll-up that spares reading them.',
    '',
    factsBlock(facts),
    '',
    `Folder: ${folder}`,
    `Roll-up file: ${rollup}`,
    `The dated files, oldest first (${dailies.length}):`,
    cut(parts, MAX_PROMPT_CHARS),
    '',
    'Answer with a JSON array only, no prose:',
    '[{ "section": "ROLLUP", "verdict": "rollup", "reason": "<one sentence>", "replacement": "<the roll-up\'s full markdown: what changed over the period, what stands now, open items, each with the dated file it comes from>" }]',
    'The dated files stay in place: never propose deleting them. When nothing is worth rolling up, answer [{ "section": "ROLLUP", "verdict": "current", "reason": "<why>", "replacement": null }].',
  ].join('\n')
}
