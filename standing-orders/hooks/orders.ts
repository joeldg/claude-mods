import type { RenderElement } from 'claude-code'
import type { Order, Scope, Unsent } from '../types'

/** The longest order kept, in characters. */
export const MAX_TEXT = 200
/** The longest goal kept, in characters. */
const MAX_GOAL = 500
/** A sentence longer than this is prose or a paste, never offered as an order. */
const MAX_SENTENCE = 320
/** A line longer than this is pasted output (minified code, a JSON blob). */
const MAX_LINE = 600
/** A prompt with more lines than this is read only at its first and last few: a paste sits between. */
const LONG_PROMPT_LINES = 12
const EDGE_LINES = 3
/** The fewest words an order is offered with. */
const MIN_WORDS = 3

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/** Curly apostrophes and quotes as their ASCII forms. */
const plain = (text: string): string => text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')

/** One line, trimmed, wrapping quotes and trailing punctuation dropped, at most MAX_TEXT characters. */
export const normalizeOrder = (text: string): string => {
  let one = plain(text).replace(/\s+/g, ' ').trim()
  const quoted = one.match(/^"(.*)"$/)
  if (quoted) {
    one = (quoted[1] ?? '').trim()
  }
  return clip(one.replace(/[\s.,;:!]+$/, ''), MAX_TEXT)
}

/** Whether two orders say the same thing, ignoring case, spacing and trailing punctuation. */
export const sameOrder = (a: string, b: string): boolean => normalizeOrder(a).toLowerCase() === normalizeOrder(b).toLowerCase()

export const hasOrder = (orders: readonly Order[], text: string): boolean => orders.some(order => sameOrder(order.text, text))

// ---------------------------------------------------------------------------------------------
// Spotting a directive in a prompt

/** A line that starts like pasted output: a quote, a shell prompt, a comment, a log, a stack frame, a timestamp, JSON. */
const PASTED_START =
  /^(?:>|\$\s|#|\/\/|\/\*|\||[{}[\]]|at\s+\S+.*[(:]\d|\(?\d{1,4}[-/:.]\d{1,2}|\d+\s*[|:]\s|npm\s|yarn\s|pnpm\s|error\s*:|warning\s*:|exception\s*:|traceback\b|caused by\b)/i
const LOG_LEVEL = /^(?:ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|CRITICAL|NOTICE)\b/
const NAMED_ERROR = /\b\w+(?:Error|Exception):/
/** Characters that are rare in someone's own sentence and common in code and logs. */
const CODE_CHARS = /[{}<>;=|\\$@%^&*()[\]_/:~+#]/g

/** Whether a line reads as pasted output or code rather than something the person wrote. */
const looksPasted = (line: string): boolean => {
  if (line.length > MAX_LINE || PASTED_START.test(line) || LOG_LEVEL.test(line) || NAMED_ERROR.test(line)) {
    return true
  }
  if (/[;{]$/.test(line)) {
    return true
  }
  const prose = line.replace(/`[^`]*`/g, 'code')
  return (prose.match(CODE_CHARS) ?? []).length / prose.length > 0.2
}

const LIST_MARK = /^(?:[-*•]\s+|\d{1,2}[.)]\s+)/

/** The prompt's own lines worth reading: code fences, quotes and pasted output left out. */
const proseLines = (prompt: string): string[] => {
  const lines: string[] = []
  let isFenced = false
  for (const raw of plain(prompt).split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      isFenced = !isFenced
      continue
    }
    const line = raw.trim()
    if (!isFenced && line) {
      lines.push(line)
    }
  }
  const read = lines.length > LONG_PROMPT_LINES ? [...lines.slice(0, EDGE_LINES), ...lines.slice(-EDGE_LINES)] : lines
  return read.filter(line => !looksPasted(line)).map(line => line.replace(LIST_MARK, ''))
}

/** Sentences end at . ! ? or ; followed by a space or the line's end, so `~/.claude/CLAUDE.md` stays whole. */
const SENTENCE = /(?:[^.!?;]|[.!?;](?!\s|$))+[.!?;]*/g

const sentencesOf = (line: string): string[] => (line.match(SENTENCE) ?? []).map(part => part.trim()).filter(Boolean)

/** Where a new clause may start inside a sentence: after a comma or colon, a dash, or a joining word. */
const BOUNDARY = /[,:]\s+|\s+[-–—]+\s+|\s+(?:but|so|and|then|because)\s+/gi

/** Words that lead into a clause and carry nothing of it: `please`, `ok,`, `and also`, `Claude,`. */
const FILLER =
  /^(?:(?:and|also|but|so|ok|okay|oh|btw|hey|please|plz|pls|just|then|now|alright|actually|anyway|again|one more thing|one thing|like i said|as i said|as i mentioned|for the record|note|reminder|just a reminder|quick reminder)\b[,:!]?|claude[,:!])\s*/i

const stripLead = (clause: string): string => {
  let text = clause.trim()
  for (let previous = ''; previous !== text; ) {
    previous = text
    text = text.replace(FILLER, '').trim()
  }
  return text
}

const QUESTION =
  /^(?:what|why|how|who|whom|whose|where|when|which|can|could|would|will|shall|is|are|was|were|does|did|has|am|isn't|aren't|wasn't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't|can't|any idea)\b|^do\s+(?:you|we|i|they|it|these|those|this|that)\b|^should\s+(?:we|i|you|it|this|that|they)\b/i

/** Phrasing that marks the instruction as about this moment only. */
const ONE_OFF =
  /\b(?:yet|for now|right now|just now|at the moment|this time|today|tonight|this one|that one|for a (?:sec|second|minute|moment|bit))\b/i

/** Clause openings that make it a statement about someone or something, not an instruction. */
const NOT_INSTRUCTION_START =
  /^(?:i|i'm|im|i'll|i've|i'd|it|it's|its|that|that's|this|there|there's|he|she|they|they're|my|maybe|perhaps|probably|hopefully|if|when|whether)\b/i

/** Words after `always`/`never` that make it a remark ("always nice to see", "never mind"), not an instruction. */
const NOT_AFTER_ALWAYS = new Set([
  'a', 'an', 'the', 'mind', 'seen', 'been', 'heard', 'thought', 'knew', 'known', 'saw', 'had', 'did', 'said', 'was',
  'were', 'is', 'are', 'am', 'ever', 'before', 'once', 'so', 'too', 'such', 'more', 'less', 'true', 'fine', 'easy',
  'hard', 'worth', 'better', 'best', 'worse', 'nice', 'good', 'great', 'fun', 'cool', 'interesting', 'helpful',
  'glad', 'happy', 'there', 'here', 'enough', 'really', 'quite', 'pretty', 'again', 'gonna', 'going', 'works',
  'happens', 'gets', 'got', 'felt', 'feels', 'seems', 'something', 'someone', 'somebody', 'anything', 'knows',
  'know', 'late', 'fails', 'amazing', 'awesome', 'weird', 'strange', 'funny', 'lovely', 'welcome', 'sure', 'the',
  'ending', 'mine', 'yours', 'ours', 'you', 'me', 'us', 'them', 'it', 'that', 'this',
])
/** `-ed` words that are verbs in their own right, so `never embed` stays an instruction. */
const ED_VERBS = new Set(['need', 'embed', 'proceed', 'exceed', 'feed', 'seed', 'speed', 'succeed', 'shred', 'spread', 'bleed', 'breed', 'heed'])
/** `-ing` words that are verbs in their own right, so `always bring` stays an instruction. */
const ING_VERBS = new Set(['bring', 'string', 'spring', 'swing', 'sting', 'cling', 'fling', 'wring'])

/** Whether the word after `always`/`never` reads as a verb in the imperative. */
const isImperativeAfterAlways = (word: string): boolean => {
  const lower = word.toLowerCase()
  if (NOT_AFTER_ALWAYS.has(lower)) {
    return false
  }
  if (lower.length > 4 && lower.endsWith('ed') && !ED_VERBS.has(lower)) {
    return false
  }
  // `always uses`, `never has`: a third-person remark; `never pass`, `always focus` are still verbs.
  if (/[^su]s$/.test(lower)) {
    return false
  }
  return !(lower.length > 5 && lower.endsWith('ing') && !ING_VERBS.has(lower))
}

/** Verbs after `don't` that make it reassurance or a remark ("don't worry", "we don't know"), not an instruction. */
const NOT_AFTER_DONT = new Set([
  'worry', 'mind', 'panic', 'know', 'think', 'understand', 'see', 'get', 'hesitate', 'sweat', 'fret', 'bother',
  'stress', 'remember', 'recall', 'believe', 'have', 'care', 'agree', 'feel', 'really', 'even', 'quite', 'actually',
  'necessarily', 'like', 'love', 'hate', 'thank', 'judge', 'blame', 'you', 'mean', 'seem', 'expect', 'suppose',
  'need',
])

/** Words that leave an instruction with nothing to follow once its trigger is gone: `never do that again`. */
const VAGUE = new Set([
  'do', 'doing', 'does', 'did', 'that', 'this', 'it', 'so', 'anything', 'something', 'again', 'please', 'ever',
  'now', 'then', 'there', 'here', 'those', 'these', 'them', 'one', 'thing', 'things', 'the', 'a', 'an', 'any', 'more',
  'like', 'stuff', 'me', 'yourself', 'what', 'said', 'say', 'ok', 'okay', 'thanks', 'thank', 'you', 'to', 'of', 'with',
  'for', 'and', 'or', 'but', 'is', 'be', "that's", "it's", 'way', 'either', 'too', 'also', 'all', 'just', 'anymore',
])

const hasContent = (rest: string): boolean =>
  (rest.toLowerCase().match(/[a-z0-9`~/._'-]+/g) ?? []).some(word => !VAGUE.has(word.replace(/^'+|'+$/g, '')))

/** `always`/`never` given as an instruction: bare, after `we`, or after `you should` (a bare `you always` is a complaint). */
const ALWAYS =
  /^(?:we\s+(?:should\s+|must\s+|need\s+to\s+|have\s+to\s+)?|(?:you|claude)\s+(?:should|must|need\s+to|have\s+to)\s+)?(?:always|never)\s+([a-z']+)/i
/** `don't` given as an instruction: bare or after `we` (`you don't listen` is a complaint). */
const DONT = /^(?:we\s+)?(?:don'?t|do\s+not)\s+([a-z']+)/i
const SHOULD_NOT = /^(?:you|we|claude)\s+(?:should(?:n'?t|\s+not)|must(?:n'?t|\s+not)|shall\s+not)\s+([a-z']+)/i
const LEADS = [
  /^make\s+sure\s+(?:to|you|that|we)\b/i,
  /^remember\s+(?:to|that)\b/i,
  /^stop\s+[a-z]+ing\b/i,
  /^(?:in|for)\s+this\s+(?:project|repo|repository|codebase|job|session)\b/i,
]

/** "I told you not to X", "I want you to always X": a restated or wished-for order, rewritten as the order itself. */
const REPHRASE: readonly (readonly [RegExp, string])[] = [
  [/^i(?:'ve|'d)?\s+(?:already\s+)?(?:told|asked|want|need|would\s+like|like)\s+you\s+(?:already\s+|again\s+)?not\s+to\s+/i, "don't "],
  [/^i(?:'ve|'d)?\s+(?:already\s+)?(?:told|asked|want|need|would\s+like|like)\s+you\s+(?:already\s+|again\s+)?never\s+to\s+/i, 'never '],
  [/^i(?:'ve|'d)?\s+(?:already\s+)?(?:told|asked|want|need|would\s+like|like)\s+you\s+(?:already\s+|again\s+)?to\s+(always|never|stop)\b/i, '$1'],
]

const rephrase = (clause: string): string => {
  for (const [pattern, replacement] of REPHRASE) {
    if (pattern.test(clause)) {
      return clause.replace(pattern, replacement)
    }
  }
  return clause
}
const SCOPED_HABIT =
  /^(?:we|you)\s+(?:always\s+|only\s+)?(?:use|prefer|keep|follow|run|need|want)\b(.*)\b(?:in|for)\s+this\s+(?:project|repo|repository|codebase|job)\b/i
const FROM_NOW = /\b(?:from now on|going forward|moving forward|from here on(?: out)?)\b/i

/** What follows the clause's trigger when the clause is an instruction; null when it is not one. */
const instructionRest = (clause: string): string | null => {
  const always = clause.match(ALWAYS)
  if (always) {
    const verb = always[1] ?? ''
    return isImperativeAfterAlways(verb) ? clause.slice(always[0].length - verb.length) : null
  }
  const dont = clause.match(DONT) ?? clause.match(SHOULD_NOT)
  if (dont) {
    const verb = dont[1] ?? ''
    return NOT_AFTER_DONT.has(verb.toLowerCase()) ? null : clause.slice(dont[0].length - verb.length)
  }
  for (const lead of LEADS) {
    const found = clause.match(lead)
    if (found) {
      return clause.slice(found[0].length)
    }
  }
  const habit = clause.match(SCOPED_HABIT)
  if (habit) {
    return habit[1] ?? ''
  }
  const phrase = clause.match(FROM_NOW)
  if (phrase && !NOT_INSTRUCTION_START.test(clause)) {
    return clause.replace(FROM_NOW, ' ')
  }
  return null
}

/** The instruction a sentence gives, from the clause where it starts; null when it gives none. */
export const directiveOf = (sentence: string): string | null => {
  const whole = sentence.trim()
  if (whole.length > MAX_SENTENCE || whole.endsWith('?') || QUESTION.test(stripLead(whole))) {
    return null
  }
  const starts = [0, ...[...whole.matchAll(BOUNDARY)].map(found => (found.index ?? 0) + found[0].length)]
  for (const start of starts) {
    const clause = rephrase(stripLead(whole.slice(start)))
    const rest = instructionRest(clause)
    if (rest === null) {
      continue
    }
    const order = normalizeOrder(clause)
    if (order.split(' ').length >= MIN_WORDS && !ONE_OFF.test(order) && hasContent(rest)) {
      return order
    }
  }
  return null
}

/**
 * The first lasting instruction a prompt gives ("never open bambu with full spectrum files"), normalized;
 * null when it gives none. Questions, one-off phrasing, code fences and pasted output are passed over.
 */
export const findDirective = (prompt: string): string | null => {
  if (prompt.trimStart().startsWith('/')) {
    return null
  }
  for (const line of proseLines(prompt)) {
    for (const sentence of sentencesOf(line)) {
      const order = directiveOf(sentence)
      if (order) {
        return order
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Where project orders live

/** FNV-1a over the UTF-16 units, as 8 hex digits. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const MAX_KEY = 120

/**
 * The project's folder as a file name, the way `~/.claude/projects` names them: every character
 * but a letter or digit becomes `-` (`/Users/me/project` is `-Users-me-project`); a key longer
 * than MAX_KEY is cut and ends in a hash of the whole path.
 */
export const projectKey = (root: string): string => {
  const path = root.length > 1 ? root.replace(/[\\/]+$/, '') : root
  const key = path.replace(/[^A-Za-z0-9]/g, '-')
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 9)}-${fnv1a(path)}`
}

const withoutTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/[\\/]+$/, '') : path)

/** `~/.claude/standing-orders/<key>.json` under `home`. */
export const ordersPath = (home: string, root: string): string =>
  `${withoutTrailingSlash(home)}/.claude/standing-orders/${projectKey(root)}.json`

/** `path` with the home folder written as `~`. */
export const tildePath = (path: string, home: string | undefined): string => {
  const base = home ? withoutTrailingSlash(home) : ''
  return base && (path === base || path.startsWith(`${base}/`)) ? `~${path.slice(base.length)}` : path
}

/** The orders a project file holds; null when the file is not JSON of that shape (it is then left alone). */
export const parseProjectFile = (text: string): Order[] | null => {
  if (text.trim() === '') {
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const list: unknown = Array.isArray(data) ? data : (data as { orders?: unknown } | null)?.orders
  if (!Array.isArray(list)) {
    return null
  }
  const orders: Order[] = []
  for (const item of list as unknown[]) {
    const raw = typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text
    const at = typeof item === 'object' && item !== null ? (item as { addedAt?: unknown }).addedAt : undefined
    const text = typeof raw === 'string' ? normalizeOrder(raw) : ''
    if (text) {
      orders.push({ text, addedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
    }
  }
  return orders
}

export const serializeProjectFile = (root: string, orders: readonly Order[]): string =>
  `${JSON.stringify({ root, orders }, null, 2)}\n`

// ---------------------------------------------------------------------------------------------
// What Claude and the person read

export const BLOCK_LEAD = 'Standing orders (kept by the standing-orders mod; follow them unless the user says otherwise):'

/** The context block: project orders, session orders and the active goal; null when there are none. */
export const blockText = (project: readonly Order[], session: readonly Order[], goal: string | null): string | null => {
  if (project.length === 0 && session.length === 0 && !goal) {
    return null
  }
  const lines = [BLOCK_LEAD]
  if (project.length > 0) {
    lines.push('For this project:', ...project.map(order => `- ${order.text}`))
  }
  if (session.length > 0) {
    lines.push('For this session:', ...session.map(order => `- ${order.text}`))
  }
  if (goal) {
    lines.push(`Active goal: ${goal}`)
  }
  return lines.join('\n')
}

const scopeWords = (scope: Scope): string => (scope === 'project' ? 'this project' : 'this session')

/** The note attached to the next prompt for orders kept mid-conversation. */
export const unsentText = (list: readonly Unsent[]): string => {
  const lead =
    list.length === 1
      ? 'A standing order was just added (kept by the standing-orders mod; follow it unless the user says otherwise):'
      : 'Standing orders were just added (kept by the standing-orders mod; follow them unless the user says otherwise):'
  return [lead, ...list.map(order => `- ${order.text} (for ${scopeWords(order.scope)})`)].join('\n')
}

export type Listing = {
  root: string
  /** Where project orders are saved, as shown; null when there is no home folder to save them in. */
  file: string | null
  project: readonly Order[]
  session: readonly Order[]
  goal: string | null
}

/** `/orders`: project orders numbered first, then session orders, then the goal. */
export const listText = ({ root, file, project, session, goal }: Listing): string => {
  const lines: string[] = []
  if (project.length === 0 && session.length === 0) {
    lines.push(
      `No standing orders for ${root}. When you give a lasting instruction the band above the prompt offers to keep it, or use /orders add [project|session] <text>.`,
    )
  } else {
    lines.push(`Standing orders for ${root}:`)
    if (project.length > 0) {
      lines.push(`This project${file ? ` (${file})` : ''}:`, ...project.map((order, i) => `  ${i + 1}. ${order.text}`))
    }
    if (session.length > 0) {
      lines.push('This session:', ...session.map((order, i) => `  ${project.length + i + 1}. ${order.text}`))
    }
  }
  if (goal) {
    lines.push(`Active goal: ${goal}`)
  }
  return lines.join('\n')
}

/** `/orders export`: every order as a Markdown list in a fence, to paste into CLAUDE.md; null when there are none. */
export const exportMarkdown = (orders: readonly Order[]): string | null => {
  if (orders.length === 0) {
    return null
  }
  const fence = orders.some(order => order.text.includes('```')) ? '````' : '```'
  return [`${fence}markdown`, '## Standing orders', '', ...orders.map(order => `- ${order.text}`), fence].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Commands

export const USAGE = [
  'Usage:',
  '  /orders                                list the standing orders, numbered',
  '  /orders add [project|session] <text>   keep an order (project when no scope is given)',
  '  /orders forget <n>                     drop order number n',
  '  /orders clear session|project          drop every order of one scope',
  '  /orders export                         print them as Markdown for CLAUDE.md',
].join('\n')

export type OrdersCommand =
  | { verb: 'list' }
  | { verb: 'add'; scope: Scope; text: string }
  | { verb: 'forget'; number: number }
  | { verb: 'clear'; scope: Scope }
  | { verb: 'export' }
  | { verb: 'usage' }

const asScope = (word: string | undefined): Scope | null => {
  const lower = word?.toLowerCase()
  return lower === 'project' || lower === 'session' ? lower : null
}

export const parseOrdersCommand = (args: string): OrdersCommand => {
  const text = args.replace(/\s+/g, ' ').trim()
  const [word = '', ...rest] = text.split(' ')
  const verb = word.toLowerCase()
  if (verb === '' || verb === 'list') {
    return rest.length === 0 ? { verb: 'list' } : { verb: 'usage' }
  }
  if (verb === 'add') {
    const scope = asScope(rest[0])
    const order = normalizeOrder((scope ? rest.slice(1) : rest).join(' '))
    return order ? { verb: 'add', scope: scope ?? 'project', text: order } : { verb: 'usage' }
  }
  if (verb === 'forget' || verb === 'remove' || verb === 'rm') {
    const number = Number((rest[0] ?? '').replace(/^#/, ''))
    return rest.length === 1 && Number.isInteger(number) && number > 0 ? { verb: 'forget', number } : { verb: 'usage' }
  }
  if (verb === 'clear') {
    const scope = asScope(rest[0])
    return scope && rest.length === 1 ? { verb: 'clear', scope } : { verb: 'usage' }
  }
  if (verb === 'export' && rest.length === 0) {
    return { verb: 'export' }
  }
  return { verb: 'usage' }
}

/** What `/goal <args>` does to the active goal: a new one, null for `/goal clear`, undefined for a bare `/goal`. */
export const goalChange = (args: string): string | null | undefined => {
  const text = args.replace(/\s+/g, ' ').trim()
  if (!text) {
    return undefined
  }
  return /^clear$/i.test(text) ? null : clip(text, MAX_GOAL)
}

/** True for what the engine draws when no plugin draws the band, or an empty Box. */
export function isBlankTree(tree: RenderElement): boolean {
  if (tree.type === 'engine') {
    return true
  }
  return tree.type === 'Box' && (tree.children ?? []).length === 0
}
