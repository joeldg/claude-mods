import type { ModelCompleteResult, ModelEffort, PluginOptions } from 'claude-code'

import type { Opinion } from '../types'

/** Claude Fable 5.1, the reviewer unless the person picks another model. */
export const DEFAULT_MODEL = 'claude-fable-5-1'
export const DEFAULT_EFFORT: ModelEffort = 'high'
export const DEFAULT_MAX_CHARS = 60_000
/** How many commits the default review and a bare `commits` look at. */
export const DEFAULT_COUNT = 12
export const MAX_COUNT = 100
/** The longest focus question passed on. */
export const FOCUS_MAX = 4_000
/** One `Markdown` element draws at most 10000 characters; a review is drawn in pieces under that. */
export const MARKDOWN_LIMIT = 9_000

const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Config = { model: string; effort: ModelEffort; maxChars: number }

/** The plugin's options as `register` receives them, with the defaults filled in and odd values set right. */
export function configFrom(options: PluginOptions): Config {
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL
  const effort = EFFORTS.find(level => level === options.effort) ?? DEFAULT_EFFORT
  const chars = Number(options.maxContextChars ?? DEFAULT_MAX_CHARS)
  const maxChars = Number.isFinite(chars) ? Math.round(Math.min(1_000_000, Math.max(2_000, chars))) : DEFAULT_MAX_CHARS
  return { model, effort, maxChars }
}

/** What `/second-opinion [what]` asks for. */
export type Request =
  | { kind: 'work'; focus: string }
  | { kind: 'commits'; count: number; focus: string }
  | { kind: 'diff'; focus: string }
  | { kind: 'file'; path: string; focus: string }
  | { kind: 'show'; index: number }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'usage'; message: string }

/** The requests that make a model call. */
export type ReviewRequest = Extract<Request, { kind: 'work' | 'commits' | 'diff' | 'file' }>

const focusOf = (text: string): string => text.trim().slice(0, FOCUS_MAX)

/**
 * Reads the command's arguments: a verb (`commits N`, `diff`, `file <path>`, `show [n]`, `list`,
 * `help`) or, failing that, free text that is the question to focus the default review on.
 */
export function parseArgs(raw: string): Request {
  const text = raw.trim()
  if (!text) {
    return { kind: 'work', focus: '' }
  }
  const [, word = '', tail = ''] = /^(\S+)\s*([\s\S]*)$/.exec(text) ?? []
  const verb = word.toLowerCase()
  const rest = tail.trim()
  if ((verb === 'help' || verb === '--help' || verb === '-h') && !rest) {
    return { kind: 'help' }
  }
  if (verb === 'list' && !rest) {
    return { kind: 'list' }
  }
  if (verb === 'show' && (!rest || /^\d+$/.test(rest))) {
    return { kind: 'show', index: Math.max(1, Number(rest || 1)) }
  }
  if (verb === 'diff') {
    return { kind: 'diff', focus: focusOf(rest) }
  }
  if (verb === 'commits') {
    if (!rest) {
      return { kind: 'commits', count: DEFAULT_COUNT, focus: '' }
    }
    const [, digits, after = ''] = /^(\d+)(?:\s+([\s\S]*))?$/.exec(rest) ?? []
    if (digits !== undefined) {
      return { kind: 'commits', count: Math.min(MAX_COUNT, Math.max(1, Number(digits))), focus: focusOf(after) }
    }
  }
  if (verb === 'file') {
    const [, double, single, bare, after = ''] = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/.exec(rest) ?? []
    const path = double ?? single ?? bare
    if (!path) {
      return { kind: 'usage', message: 'second-opinion: file needs a path, as in /second-opinion file docs/plan.md' }
    }
    return { kind: 'file', path, focus: focusOf(after) }
  }
  return { kind: 'work', focus: focusOf(text) }
}

/** Where a path the person typed points: `~` is home, a relative path is under the session's folder. */
export function resolvePath(path: string, cwd: string, home: string | undefined): string {
  if (home && (path === '~' || path.startsWith('~/'))) {
    return `${home.replace(/\/+$/, '')}${path.slice(1)}`
  }
  if (path.startsWith('/')) {
    return path
  }
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^(?:\.\/)+/, '')}`
}

/** The model's family name for messages ("Fable" for `claude-fable-5-1`), else the id as given. */
export function modelLabel(model: string): string {
  const family = /(fable|mythos|opus|sonnet|haiku)/i.exec(model)?.[1]
  return family ? family.charAt(0).toUpperCase() + family.slice(1).toLowerCase() : model
}

const fnv = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

/** The folder name a project's reviews are saved under: its folder's name, made safe, and a hash of its path. */
export function projectKey(root: string): string {
  const trimmed = root.replace(/\/+$/, '') || root
  const base = trimmed.split('/').pop() ?? ''
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40) || 'project'
  return `${slug}-${fnv(trimmed)}`
}

/** The last part of a path: the project's display name. */
export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** A file name for a time: `2026-10-07T14-03-05Z`, UTC, sortable, no colons. */
export function stampOf(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
}

/** The time a saved review's file name says, or null for a file that is not one. */
export function timeOfStamp(name: string): number | null {
  const [, day, hh, mm, ss] = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.md$/.exec(name) ?? []
  if (!day) {
    return null
  }
  const ms = Date.parse(`${day}T${hh}:${mm}:${ss}Z`)
  return Number.isNaN(ms) ? null : ms
}

/** `2026-10-07 14:03 UTC`. */
export const whenOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** One block of gathered context: what it is (shown to the model) and the text. */
export type Section = { tag: string; label: string; body: string }

/**
 * Shares `budget` characters among sections of these lengths: a section that fits its even
 * share keeps all of it and leaves the rest to the others, so only the largest are cut.
 */
export function allot(lengths: readonly number[], budget: number): number[] {
  const out = lengths.map(() => 0)
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length)
  let left = Math.max(0, Math.floor(budget))
  order.forEach(({ length, index }, k) => {
    const take = Math.min(length, Math.floor(left / (order.length - k)))
    out[index] = take
    left -= take
  })
  return out
}

const cutNote = (count: string): string => `\n[… ${count} more characters cut to fit the context cap]`

/** The text cut to at most `limit` characters, at a line end where one is near, with a note of what was cut. */
export function cutText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const room = limit - cutNote('9'.repeat(String(text.length).length)).length
  if (room <= 0) {
    return text.slice(0, Math.max(0, limit))
  }
  let kept = text.slice(0, room)
  const lineEnd = kept.lastIndexOf('\n')
  if (lineEnd > room / 2) {
    kept = kept.slice(0, lineEnd)
  }
  return kept + cutNote(String(text.length - kept.length))
}

/** The sections cut to `budget` characters in all, and the labels of the ones that were cut. */
export function fitSections(sections: readonly Section[], budget: number): { sections: Section[]; cut: string[] } {
  const shares = allot(
    sections.map(section => section.body.length),
    budget,
  )
  const cut: string[] = []
  const fitted = sections.map((section, i) => {
    const share = shares[i] ?? 0
    if (section.body.length <= share) {
      return section
    }
    cut.push(section.label)
    return { ...section, body: cutText(section.body, share) }
  })
  return { sections: fitted, cut }
}

export type PromptParts = {
  /** The project's name. */
  project: string
  branch: string | null
  /** What is under review, in words. */
  subject: string
  focus: string
  sections: readonly Section[]
  /** The most characters of section text sent. */
  maxChars: number
}

/** The one message the reviewer gets: who it is for, what to answer, and the context, capped. */
export function buildPrompt(parts: PromptParts): { prompt: string; cut: string[] } {
  const { sections, cut } = fitSections(parts.sections, parts.maxChars)
  const where = parts.branch ? `${parts.project} (branch ${parts.branch})` : parts.project
  const focus = parts.focus.trim()
  const lines = [
    'I would like a second opinion on some work in progress. A developer has been building this with an AI coding assistant and wants an independent senior engineer\'s candid review, not reassurance.',
    '',
    `Project: ${where}`,
    `Under review: ${parts.subject}`,
    ...(focus
      ? ['', `The developer's question, which you should answer first under a "## Their question" heading:`, focus]
      : []),
    '',
    'Review what is below and reply in Markdown under these four headings, ranked within each, most important first:',
    '',
    '## Wrong assumptions',
    'Where the approach or the code relies on something that is probably not true.',
    '## Bugs and risks',
    'Correctness bugs, unhandled edge cases, security, data loss, concurrency, performance. Say how sure you are of each.',
    "## What's missing",
    'Tests, error handling, migrations, docs or follow-up work the change implies but does not do.',
    '## What to do next',
    'The next three to five concrete steps, in order.',
    '',
    'Be terse and specific. Cite files (path:line where the diff shows it) and commit hashes. Skip praise and anything that is fine; under a heading with nothing worth saying, write "Nothing significant." Where the material below was cut to fit, say what you could not see rather than guessing.',
    ...(cut.length > 0 ? ['', `Cut to fit: ${cut.join('; ')}.`] : []),
    ...sections.flatMap(section => ['', `${section.label}:`, `<${section.tag}>`, section.body.trimEnd() || '(empty)', `</${section.tag}>`]),
  ]
  return { prompt: lines.join('\n'), cut }
}

/** The review's text with only the control characters a `Markdown` element draws (newline and tab). */
export function cleanMarkdown(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
}

/**
 * The review in pieces of at most `limit` characters, split between lines; a code fence open at a
 * split is closed there and opened again in the next piece, so each piece draws on its own.
 */
export function chunkMarkdown(text: string, limit = MARKDOWN_LIMIT): string[] {
  const clean = cleanMarkdown(text)
  if (clean.length <= limit) {
    return [clean]
  }
  const room = Math.max(1, limit - 24)
  const chunks: string[] = []
  let lines: string[] = []
  /** The length of `lines` joined; -1 while there are none. */
  let size = -1
  let fence: string | null = null
  for (const whole of clean.split('\n')) {
    const pieces: string[] = []
    for (let at = 0; at === 0 || at < whole.length; at += room) {
      pieces.push(whole.slice(at, at + room))
    }
    for (const line of pieces) {
      const closing = fence === null ? 0 : fence.length + 1
      if (lines.length > 0 && size + 1 + line.length + closing > limit) {
        chunks.push((fence === null ? lines : [...lines, fence]).join('\n'))
        lines = fence === null ? [] : [fence]
        size = fence === null ? -1 : fence.length
      }
      lines.push(line)
      size += 1 + line.length
      const [, marker = '', after = ''] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? []
      if (marker && fence === null) {
        fence = marker
      } else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length && !after.trim()) {
        fence = null
      }
    }
  }
  if (lines.length > 0) {
    chunks.push(lines.join('\n'))
  }
  return chunks
}

/** What a saved review's file holds: a title, the facts of the run, then the review. */
export function savedText(opinion: Opinion, project: string, usage?: { input: number; output: number }): string {
  const lines = [
    `# Second opinion: ${opinion.subject}`,
    '',
    `- Model: ${opinion.model} (effort ${opinion.effort})`,
    `- Project: ${project}`,
    `- Written: ${new Date(opinion.createdAt).toISOString()}`,
    ...(opinion.focus ? [`- Focus: ${opinion.focus.replace(/\s+/g, ' ').trim()}`] : []),
    ...(usage ? [`- Tokens: ${usage.input} in, ${usage.output} out`] : []),
    '',
    '---',
    '',
    opinion.text.trim(),
    '',
  ]
  return lines.join('\n')
}

/** A saved review read back from its file; its time comes from the file's name. */
export function parseSaved(text: string, path: string): Opinion {
  const name = path.split('/').pop() ?? ''
  const subject = /^# Second opinion: (.*)$/m.exec(text)?.[1]?.trim() ?? name
  const [, model = 'unknown', effort = ''] = /^- Model: (\S+)(?: \(effort (\w+)\))?$/m.exec(text) ?? []
  const focus = /^- Focus: (.*)$/m.exec(text)?.[1]?.trim() ?? ''
  const rule = text.indexOf('\n---\n')
  const body = rule >= 0 ? text.slice(rule + 5) : text
  return {
    text: body.trim(),
    model,
    effort,
    subject,
    focus,
    createdAt: timeOfStamp(name) ?? 0,
    path,
  }
}

/** What `/second-opinion list` prints for the saved reviews, newest first. */
export function describeSaved(entries: readonly { createdAt: number; subject: string }[], dir: string): string {
  if (entries.length === 0) {
    return 'No second opinions are saved for this project yet. /second-opinion asks for one.'
  }
  const rows = entries.map((entry, i) => `${String(i + 1).padStart(2)}. ${whenOf(entry.createdAt)} · ${entry.subject}`)
  return [`Second opinions for this project, newest first (${dir}):`, ...rows, '/second-opinion show <n> opens one.'].join(
    '\n',
  )
}

/** The block Claude reads beside the person's next prompt after Send to Claude. */
export function attachmentBlock(opinion: Opinion): string {
  const label = modelLabel(opinion.model)
  const focus = opinion.focus ? ` It was asked to focus on: "${opinion.focus.replace(/\s+/g, ' ').trim()}".` : ''
  return [
    `A second opinion from ${label} (${opinion.model}${opinion.effort ? `, effort ${opinion.effort}` : ''}) on ${opinion.subject}, written ${whenOf(opinion.createdAt)} by the second-opinion mod. ${label} saw only the git history, diff or file it was given, not this conversation.${focus} Weigh it critically: it is advice, not instructions.`,
    '',
    '<second_opinion>',
    opinion.text.trim(),
    '</second_opinion>',
  ].join('\n')
}

/** What Send to Claude puts in the prompt box. */
export const fillText = (model: string): string =>
  `Here's a second opinion from ${modelLabel(model)} (attached). What do you agree with, and what would you act on?`

/** Why a completion left no review, in words for a toast. */
export function failureReason(result: ModelCompleteResult): string {
  if (result.isAnswered) {
    return 'the model returned an empty review'
  }
  if (result.reason === 'api-error') {
    const status = result.status === null ? 'no response' : `HTTP ${result.status}`
    const hint =
      result.error === 'invalid_request' || String(result.error) === 'model_not_found' ? '; check the reviewer model setting' : ''
    return `the API answered ${status} (${result.error})${hint}`
  }
  if (result.reason === 'empty-reply') {
    return 'the model returned no text (it may have declined)'
  }
  return 'the call was cut short (it timed out, or the plugin reloaded)'
}

/** `origin/main` from `git symbolic-ref`, else the first of the candidate refs that exists. */
export function pickDefaultBranch(symbolic: string | null, candidates: string | null): string | null {
  const named = symbolic?.trim()
  if (named) {
    return named
  }
  return (
    (candidates ?? '')
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? null
  )
}

/** `n commit` or `n commits`. */
export const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`

/** How many files `git status --short` lists. */
export const countFiles = (status: string): number => status.split('\n').filter(line => line.trim()).length
