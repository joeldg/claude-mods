import type { RecallHit } from '../types'
import { oneLine, plainSnippet, shortDayOf } from './format'

/** The most terms one prompt's related search looks for. */
export const MAX_TERMS = 4
/** How much of a prompt is read for references. */
const SCAN_CHARS = 6_000

/** Words too common to be a reference on their own. */
const COMMON = new Set(
  (
    'a about after again all also an and any are as at be been before but by can could did do does done each else ' +
    'for from get got had has have he her here him his how i if in into is it its just like make me more most my ' +
    'new no not now of off ok okay old on once one only or other our out over please same see she so some still ' +
    'such than thanks that the their them then there these they thing things this those to too up us use used ' +
    'using very was we were what when where which while who why will with would yes you your ' +
    'true false null none undefined nan todo fixme test tests code file files fix add run'
  ).split(' '),
)

/** Ticket-shaped words that are standards, not tickets: `UTF-8`, `SHA-256`, `ISO-8601`. */
const NOT_TICKETS = new Set([
  'UTF',
  'SHA',
  'ISO',
  'UTC',
  'GMT',
  'TLS',
  'SSL',
  'AES',
  'RSA',
  'MD',
  'GPT',
  'ES',
  'ECMA',
  'IEEE',
  'HTTP',
  'COVID',
  'IPV',
  'CP',
  'WIN',
  'X',
  'RFC',
  'PEP',
])

/** File extensions a path or file name must end in to count as one. */
const EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs mts cts py pyi ipynb rb go rs java kt kts swift m mm c h cc cpp cxx hpp cs fs php pl lua r ' +
    'sh bash zsh fish ps1 sql graphql proto md mdx rst txt json jsonc jsonl yaml yml toml ini cfg conf env lock ' +
    'html htm css scss sass less vue svelte astro xml plist csv tsv parquet db sqlite log ' +
    'pdf png jpg jpeg gif svg webp heic stl 3mf obj step stp gcode glb gltf ply dockerfile tf hcl gradle ' +
    'zip tar gz tgz wasm'
  ).split(' '),
)

/** File names too common to mean one file without their folder. */
const GENERIC_FILES = new Set([
  'index',
  'main',
  'readme',
  'package',
  'tsconfig',
  'setup',
  '__init__',
  'mod',
  'lib',
  'utils',
  'util',
  'types',
  'config',
  'app',
  'test',
  'settings',
])

const isWordy = (text: string): boolean =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some(word => word.length >= 3 && !COMMON.has(word))

/** Names with a file's shape that name a library, not a file. */
const NOT_FILES = new Set([
  'node.js',
  'next.js',
  'nuxt.js',
  'vue.js',
  'react.js',
  'express.js',
  'three.js',
  'd3.js',
  'chart.js',
  'p5.js',
  'anime.js',
  'deno.land',
])

/**
 * A path or file name as a search term: the file's name, with its folder when the name alone is
 * common (`upload/index.ts`); null for a common name with no folder (`package.json`).
 */
export function fileTerm(path: string): string | null {
  const parts = path.split('/').filter(part => part && part !== '.' && part !== '..' && part !== '~')
  const name = parts[parts.length - 1] ?? path
  if (NOT_FILES.has(name.toLowerCase())) {
    return null
  }
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase()
  if (!GENERIC_FILES.has(stem)) {
    return name
  }
  return parts.length > 1 ? parts.slice(-2).join('/') : null
}

const PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w@.+-]*\/)*[\w@+-][\w@.+-]*\.([A-Za-z0-9]{1,10})$/

/**
 * The strong references in a prompt, for the related-work search: PR and issue numbers (`#214`,
 * `PR 214`, `.../pull/214`), ticket ids (`ABC-123`), file paths and names with a known extension,
 * backticked identifiers and quoted phrases; common words alone never count. At most four, in
 * that order of strength, each once.
 */
export function extractRefs(prompt: string): string[] {
  const text = prompt
    .slice(0, SCAN_CHARS)
    // Fenced code is pasted material, not something the person named.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  const found: string[] = []
  const seen = new Set<string>()
  const add = (term: string) => {
    const clean = term.replace(/\s+/g, ' ').trim()
    const key = clean.toLowerCase()
    if (clean && !seen.has(key)) {
      seen.add(key)
      found.push(clean)
    }
  }

  // PR and issue numbers, in the order they come; a bare `#` wants two digits, as `#1` is mostly "number one".
  const numbers = [
    ...text.matchAll(/(?:^|[^\w&#/])#(\d{2,6})\b/g),
    ...text.matchAll(/\b(?:PR|pull request|pull|issue)\s*#?\s*(\d{1,6})\b/gi),
    ...text.matchAll(/\/(?:pull|issues)\/(\d{1,6})\b/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (const match of numbers) {
    add(`#${match[1]}`)
  }

  // Ticket ids.
  for (const match of text.matchAll(/(?:^|[^\w-])([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
    const prefix = match[1] ?? ''
    if (!NOT_TICKETS.has(prefix) && !/^\d+$/.test(prefix)) {
      add(`${prefix}-${match[2]}`)
    }
  }

  // File paths and names: whitespace-separated words, URLs left out.
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>,;:!?]+$/, '').replace(/\.$/, '')
    if (!word || word.includes('://') || word.startsWith('@') || word.length > 200) {
      continue
    }
    const ext = PATH.exec(word)?.[1]?.toLowerCase()
    const term = ext && EXTENSIONS.has(ext) && !/^\d+(\.\d+)+$/.test(word) ? fileTerm(word) : null
    if (term) {
      add(term)
    }
  }

  // Backticked identifiers and short commands.
  for (const match of text.matchAll(/`([^`\n]{3,60})`/g)) {
    const inner = (match[1] ?? '').trim()
    const words = inner.split(/\s+/)
    const ext = PATH.exec(inner)?.[1]?.toLowerCase()
    if (words.length <= 5 && isWordy(inner) && !(ext && EXTENSIONS.has(ext))) {
      add(inner.replace(/"/g, ''))
    }
  }

  // Quoted phrases.
  for (const match of text.matchAll(/"([^"\n]{3,80})"|“([^”\n]{3,80})”/g)) {
    const inner = (match[1] ?? match[2] ?? '').trim()
    if (inner.split(/\s+/).length <= 8 && isWordy(inner)) {
      add(inner)
    }
  }

  return found.slice(0, MAX_TERMS)
}

/** The terms not dismissed this session (compared without case). */
export const undismissed = (terms: readonly string[], dismissed: readonly string[]): string[] => {
  const gone = new Set(dismissed.map(term => term.toLowerCase()))
  return terms.filter(term => !gone.has(term.toLowerCase()))
}

/** The related search's query: the terms as phrases, OR'd. */
export const relatedQuery = (terms: readonly string[]): string =>
  terms.map(term => `"${term.replace(/"/g, '')}"`).join(' OR ')

/** The terms a hit's text names, by the words of each (case and `#` aside). */
export function termsIn(terms: readonly string[], hits: readonly RecallHit[]): string[] {
  const haystack = hits
    .map(hit => `${plainSnippet(hit.snippet, 2_000)} ${hit.title} ${JSON.stringify(hit.extra ?? {})}`)
    .join(' ')
    .toLowerCase()
  return terms.filter(term => {
    const words = term
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
    return words.length > 0 && words.every(word => haystack.includes(word))
  })
}

/** `Past sessions mention #214: Sep 25 "merged 213, go ahead with #214" (+2 more)` */
export function relatedLine(terms: readonly string[], hits: readonly RecallHit[], total: number): {
  lead: string
  quote: string
  more: string
} {
  const named = termsIn(terms, hits.slice(0, 3))
  const shown = (named.length > 0 ? named : terms).slice(0, 2)
  const top = hits[0]
  const quote = top ? oneLine(plainSnippet(top.snippet, 200), 64) : ''
  const others = Math.max(total, hits.length) - 1
  return {
    lead: `Past sessions mention ${shown.join(' and ')}: ${top ? shortDayOf(top.ts) : ''}`.trimEnd(),
    quote: quote ? ` "${quote}"` : '',
    more: others > 0 ? ` (+${others} more)` : '',
  }
}

/** The lowest engine score a related hit may have: lower is an old, faint mention. */
export const RELATED_MIN_SCORE = 0.2

/**
 * Whether a hit really mentions one of the terms: a PR or issue number as that number (its record,
 * or `#214`, `PR 214`, `/pull/214` in its text), anything else by all of its words.
 */
export function isStrongHit(terms: readonly string[], hit: RecallHit): boolean {
  if (hit.score < RELATED_MIN_SCORE) {
    return false
  }
  const text = `${plainSnippet(hit.snippet, 2_000)} ${hit.title}`
  return terms.some(term => {
    const number = /^#(\d+)$/.exec(term)?.[1]
    if (number) {
      const recorded = hit.extra && Number(hit.extra.number) === Number(number) && (hit.kind === 'pr' || hit.kind === 'issue')
      const said = new RegExp(`(?:#|\\b(?:PR|pull request|issue)\\s*#?\\s*|/(?:pull|issues)/)${number}\\b`, 'i').test(text)
      return Boolean(recorded) || said
    }
    return termsIn([term], [hit]).length > 0
  })
}

/** Words a question to /recall ask carries that say nothing about what to find. */
const QUESTION_WORDS = new Set(
  (
    'decide decided decision decisions remember recall recalled last time times session sessions past ago earlier ' +
    'previous previously yesterday week weeks month months tell know find found did does put used said say ' +
    'should could would where which what when why how who whom whose there were was'
  ).split(' '),
)

/**
 * A question as an engine query for /recall ask: its references and quoted phrases kept whole, its
 * other telling words OR'd, so the best matches rank first instead of every word being required.
 */
export function askQuery(question: string): string {
  const refs = extractRefs(question).map(term => term.replace(/"/g, ''))
  const taken = new Set(refs.flatMap(term => [term.toLowerCase(), term.toLowerCase().replace(/^#/, '')]))
  const words = (
    question
      .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' ')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]/g) ?? []
  ).filter(word => word.length >= 3 && !COMMON.has(word) && !QUESTION_WORDS.has(word) && !taken.has(word))
  const terms = [...refs.map(term => `"${term}"`), ...new Set(words)].slice(0, 10)
  return terms.length > 0 ? terms.join(' OR ') : question.trim()
}
