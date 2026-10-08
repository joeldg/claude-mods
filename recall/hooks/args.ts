import type { PluginOptions } from 'claude-code'

import type { RecallForgetTarget } from '../types'

export const DEFAULT_DB = '~/.claude/recall/index.db'
export const DEFAULT_PYTHON = '/usr/bin/python3'
export const SOURCES = ['claude', 'codex', 'memory', 'orders', 'reviews'] as const
export const DEFAULT_ASK_MODEL = 'claude-haiku-4-5-20251001'
export const DEFAULT_MAX_RESULTS = 8
export const MAX_LIMIT = 25
/** The most sessions `/recall last` and the recap tool sum up at once. */
export const MAX_RECAP = 5

/** Every kind of extract the engine indexes. */
export const KINDS = [
  'prompt',
  'answer',
  'summary',
  'title',
  'command',
  'file',
  'commit',
  'pr',
  'issue',
  'url',
  'decision',
  'task',
  'memory',
  'order',
  'review',
  'note',
] as const

/** The kinds the list tool and the list panes show. */
export const LIST_KINDS = ['decision', 'command', 'file', 'commit', 'pr', 'issue', 'url', 'note', 'task'] as const
export type ListKind = (typeof LIST_KINDS)[number]

export type Config = {
  /** As configured: `~` is expanded where it is used. */
  dbPath: string
  python: string
  sources: string[]
  includeSubagents: boolean
  includeRoutines: boolean
  /** 0 turns the periodic re-index off. */
  updateMs: number
  relatedBand: boolean
  lastSessionBand: boolean
  maxResults: number
  askModel: string
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

const number = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** The sources named in a comma-separated list, the known ones in their own order; all of them when none is known. */
export function parseSources(raw: string): string[] {
  const named = new Set(
    raw
      .split(/[\s,]+/)
      .map(name => name.trim().toLowerCase())
      .filter(Boolean),
  )
  const known = SOURCES.filter(name => named.has(name))
  return known.length > 0 ? known : [...SOURCES]
}

/** The plugin's options as `register` receives them, with the defaults filled in and odd values set right. */
export function configFrom(options: PluginOptions): Config {
  const minutes = number(options.updateMinutes, 10)
  return {
    dbPath: text(options.dbPath, DEFAULT_DB),
    python: text(options.python, DEFAULT_PYTHON),
    sources: parseSources(text(options.sources, SOURCES.join(','))),
    includeSubagents: flag(options.includeSubagents, true),
    includeRoutines: flag(options.includeRoutines, false),
    updateMs: minutes > 0 ? Math.round(Math.max(1, Math.min(24 * 60, minutes)) * 60_000) : 0,
    relatedBand: flag(options.relatedBand, true),
    lastSessionBand: flag(options.lastSessionBand, true),
    maxResults: Math.round(Math.max(1, Math.min(MAX_LIMIT, number(options.maxResults, DEFAULT_MAX_RESULTS)))),
    askModel: text(options.askModel, DEFAULT_ASK_MODEL),
  }
}

/** A path with a leading `~` made absolute under `home`; as given when it has none or HOME is unset. */
export function expandHome(path: string, home: string | undefined): string {
  if (home && (path === '~' || path.startsWith('~/'))) {
    return `${home.replace(/\/+$/, '')}${path.slice(1)}`
  }
  return path
}

/** The last part of a path: a project's display name. */
export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** A project's name for people: its folder's, or for a Claude Code worktree (`<repo>/.claude/worktrees/<name>`) its repository's. */
export function projectNameOf(root: string): string {
  const main = /^(.+?)\/\.claude\/worktrees\/[^/]+\/?$/.exec(root)?.[1]
  return baseName(main ?? root)
}

/** What `/recall [...]` asks for. */
export type RecallRequest =
  | { kind: 'help' }
  | { kind: 'search'; query: string }
  | { kind: 'last'; count: number }
  | { kind: 'timeline'; days: number; isAll: boolean }
  | { kind: 'list'; listKind: ListKind; query: string }
  | { kind: 'ask'; question: string }
  | { kind: 'stats' }
  | { kind: 'reindex' }
  | { kind: 'forget'; target: RecallForgetTarget }
  | { kind: 'usage'; message: string }

/** The list verbs `/recall` takes, singular and plural, by the kind each lists. */
const LIST_VERBS: Record<string, ListKind> = {
  decision: 'decision',
  decisions: 'decision',
  command: 'command',
  commands: 'command',
  file: 'file',
  files: 'file',
  commit: 'commit',
  commits: 'commit',
  pr: 'pr',
  prs: 'pr',
  issue: 'issue',
  issues: 'issue',
  url: 'url',
  urls: 'url',
  link: 'url',
  links: 'url',
  task: 'task',
  tasks: 'task',
  note: 'note',
  notes: 'note',
}

export const DEFAULT_TIMELINE_DAYS = 14
export const MAX_QUERY = 500
export const MAX_QUESTION = 2_000

/** `7d`, `30d`, `2w` as days; null for anything else. */
export function periodDays(word: string): number | null {
  const [, digits, unit] = /^(\d{1,3})([dw])$/i.exec(word.trim()) ?? []
  if (!digits || !unit) {
    return null
  }
  const days = Number(digits) * (unit.toLowerCase() === 'w' ? 7 : 1)
  return days >= 1 && days <= 3650 ? days : null
}

/** A date `forget before` takes: `2026-01-31`, or an age such as `90d`. */
const isForgetDate = (word: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(word) || periodDays(word) !== null

const FORGET_USAGE = 'Usage: /recall forget session <id> | project <name> | before <YYYY-MM-DD or 90d>'

function parseForget(rest: string): RecallRequest {
  const [, word = '', tail = ''] = /^(\S+)\s*([\s\S]*)$/.exec(rest) ?? []
  const what = word.toLowerCase()
  const value = tail.trim()
  if (what === 'session' && /^[\w.-]{4,128}$/.test(value)) {
    return { kind: 'forget', target: { kind: 'session', id: value } }
  }
  if (what === 'project' && value && value.length <= 300) {
    return { kind: 'forget', target: { kind: 'project', name: value } }
  }
  if (what === 'before' && isForgetDate(value)) {
    return { kind: 'forget', target: { kind: 'before', date: value } }
  }
  return { kind: 'usage', message: FORGET_USAGE }
}

/**
 * Reads `/recall`'s arguments: a verb (`last [n]`, `timeline [7d] [all]`, `decisions [query]` and the
 * other lists, `ask <question>`, `stats`, `reindex`, `forget ...`, `help`) or, failing that, a search
 * for the whole text. `search <query>` searches for words that start with a verb.
 */
export function parseRecallArgs(raw: string): RecallRequest {
  const whole = raw.trim()
  if (!whole) {
    return { kind: 'help' }
  }
  const [, word = '', tail = ''] = /^(\S+)\s*([\s\S]*)$/.exec(whole) ?? []
  const verb = word.toLowerCase()
  const rest = tail.trim()
  const search = (query: string): RecallRequest =>
    query ? { kind: 'search', query: query.slice(0, MAX_QUERY) } : { kind: 'usage', message: 'Usage: /recall search <query>' }

  if (['help', '-h', '--help', '?'].includes(verb) && !rest) {
    return { kind: 'help' }
  }
  if (verb === 'search' || verb === 'find') {
    return search(rest)
  }
  if (verb === 'last' && (!rest || /^\d{1,2}$/.test(rest))) {
    return { kind: 'last', count: Math.max(1, Math.min(MAX_RECAP, Number(rest || 1))) }
  }
  if (verb === 'timeline') {
    const words = rest ? rest.split(/\s+/) : []
    const days = words.map(periodDays).filter((n): n is number => n !== null)
    const isAll = words.some(one => one.toLowerCase() === 'all')
    const isKnown = words.every(one => periodDays(one) !== null || one.toLowerCase() === 'all')
    if (isKnown && days.length <= 1) {
      return { kind: 'timeline', days: days[0] ?? DEFAULT_TIMELINE_DAYS, isAll }
    }
  }
  const listKind = LIST_VERBS[verb]
  if (listKind) {
    return { kind: 'list', listKind, query: rest.slice(0, MAX_QUERY) }
  }
  if (verb === 'ask') {
    return rest
      ? { kind: 'ask', question: rest.slice(0, MAX_QUESTION) }
      : { kind: 'usage', message: 'Usage: /recall ask <question>, as in /recall ask what did we decide about retries?' }
  }
  if (verb === 'stats' && !rest) {
    return { kind: 'stats' }
  }
  if ((verb === 'reindex' || verb === 'rebuild') && !rest) {
    return { kind: 'reindex' }
  }
  if (verb === 'forget') {
    return parseForget(rest)
  }
  return search(whole)
}

/** What `/remember [...]` asks for. */
export type RememberRequest =
  | { kind: 'add'; text: string }
  | { kind: 'list' }
  | { kind: 'forget'; ref: string }
  | { kind: 'usage'; message: string }

export const MAX_NOTE = 2_000

/** A ref as the person or the model writes it: `d123`, or the bare number. */
export function normalizeRef(raw: string): string | null {
  const [, digits] = /^\[?d?(\d{1,12})\]?$/i.exec(raw.trim()) ?? []
  return digits ? `d${digits}` : null
}

/** Reads `/remember`'s arguments: `list`, `forget <ref>`, or the note to keep. */
export function parseRememberArgs(raw: string): RememberRequest {
  const whole = raw.trim()
  if (!whole) {
    return {
      kind: 'usage',
      message: 'Usage: /remember <note> keeps a note for this project; /remember list; /remember forget <ref>',
    }
  }
  const [, word = '', tail = ''] = /^(\S+)\s*([\s\S]*)$/.exec(whole) ?? []
  const verb = word.toLowerCase()
  const rest = tail.trim()
  if (verb === 'list' && !rest) {
    return { kind: 'list' }
  }
  if (verb === 'forget') {
    const ref = normalizeRef(rest)
    if (ref) {
      return { kind: 'forget', ref }
    }
  }
  return { kind: 'add', text: whole.slice(0, MAX_NOTE) }
}

/** Where a tool or command looks: this session's project, every project, or one named. */
export type Scope = { kind: 'this' } | { kind: 'all' } | { kind: 'named'; name: string }

/** A tool's `scope` as the model wrote it; this project when absent or unclear. */
export function parseScope(value: unknown): Scope {
  const said = typeof value === 'string' ? value.trim() : ''
  const lower = said.toLowerCase().replace(/\s+/g, ' ')
  if (!lower || ['this project', 'this', 'current', 'current project', 'here', 'project'].includes(lower)) {
    return { kind: 'this' }
  }
  if (['all projects', 'all', 'everywhere', 'any', 'any project', 'every project', 'global'].includes(lower)) {
    return { kind: 'all' }
  }
  return { kind: 'named', name: said.slice(0, 300) }
}

const clampLimit = (value: unknown, fallback: number): number => {
  const n = number(value, fallback)
  return Math.round(Math.max(1, Math.min(MAX_LIMIT, n)))
}

/** The kinds a tool named that the engine knows, from a list or a comma-separated string. */
export function parseKinds(value: unknown): string[] {
  const named = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const known = new Set<string>(KINDS)
  const aliases: Record<string, string> = { prs: 'pr', pull: 'pr', decisions: 'decision', commands: 'command', files: 'file' }
  const kinds = named
    .filter((one): one is string => typeof one === 'string')
    .map(one => one.trim().toLowerCase())
    .map(one => aliases[one] ?? (one.endsWith('s') && known.has(one.slice(0, -1)) ? one.slice(0, -1) : one))
    .filter(one => known.has(one))
  return [...new Set(kinds)]
}

/** `7d`, `2026-09-01` and the like, passed to the engine as given; null when absent. */
export function parseSince(value: unknown): string | null {
  const said = typeof value === 'string' ? value.trim() : ''
  return said && said.length <= 40 && /^[\w:.+-]+$/.test(said) ? said : null
}

export type SearchInput = { query: string; scope: Scope; kinds: string[]; since: string | null; limit: number }
export type ExpandInput = { ref: string }
export type RecapInput = { scope: Scope; count: number }
export type ListInput = { kind: ListKind; query: string; scope: Scope; since: string | null; limit: number }

type Input = Readonly<Record<string, unknown>>

export function searchInput(e: Input, maxResults: number): SearchInput | { error: string } {
  const query = typeof e.query === 'string' ? e.query.trim() : ''
  if (!query) {
    return { error: 'recall: search needs a query: the words, "phrases", PR numbers or names to look for.' }
  }
  return {
    query: query.slice(0, MAX_QUERY),
    scope: parseScope(e.scope),
    kinds: parseKinds(e.kinds),
    since: parseSince(e.since),
    limit: clampLimit(e.limit, maxResults),
  }
}

export function expandInput(e: Input): ExpandInput | { error: string } {
  const ref = typeof e.ref === 'string' ? normalizeRef(e.ref) : typeof e.ref === 'number' ? normalizeRef(String(e.ref)) : null
  return ref ? { ref } : { error: 'recall: expand needs the ref of a hit, as search printed it: d123.' }
}

export function recapInput(e: Input): RecapInput {
  return { scope: parseScope(e.scope), count: Math.round(Math.max(1, Math.min(MAX_RECAP, number(e.count, 1)))) }
}

export function listInput(e: Input, maxResults: number): ListInput | { error: string } {
  const kind = LIST_KINDS.find(one => one === (typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : ''))
  if (!kind) {
    return { error: `recall: list needs a kind: ${LIST_KINDS.join(', ')}.` }
  }
  return {
    kind,
    query: typeof e.query === 'string' ? e.query.trim().slice(0, MAX_QUERY) : '',
    scope: parseScope(e.scope),
    since: parseSince(e.since),
    limit: clampLimit(e.limit, Math.max(maxResults, 15)),
  }
}

/** How searches treat routine (scheduled) sessions. */
export const routinesOf = (config: Config): 'include' | 'exclude' => (config.includeRoutines ? 'include' : 'exclude')

/** The engine's command line: python, the script the plugin ships, the index, then the command. */
export function engineArgv(config: Config, pluginRoot: string, db: string, args: readonly string[]): string[] {
  return [config.python, `${pluginRoot.replace(/\/+$/, '')}/engine/recall.py`, '--db', db, ...args]
}

/** `update`: `maxSeconds` stops it early (the next run resumes), `progress` streams JSON lines to stderr, `rebuild` re-reads every file. */
export function updateArgs(
  config: Config,
  options: { maxSeconds?: number; progress?: boolean; rebuild?: boolean } = {},
): string[] {
  return [
    'update',
    '--sources',
    config.sources.join(','),
    ...(config.includeSubagents ? ['--subagents'] : []),
    ...(options.maxSeconds ? ['--max-seconds', String(Math.round(options.maxSeconds))] : []),
    ...(options.progress ? ['--progress'] : []),
    ...(options.rebuild ? ['--rebuild'] : []),
  ]
}

/**
 * A free-text option for the engine's argparse: `--name value`, or `--name=value` when the value
 * itself starts with `-` (argparse would otherwise read `-x` or `--force` as an option).
 */
export function freeText(name: string, value: string): string[] {
  return value.startsWith('-') ? [`${name}=${value}`] : [name, value]
}

export type SearchSpec = {
  query: string
  /** A project's path, key or name, or `all`. */
  project: string
  boost: string | null
  exclude: string | null
  kinds: readonly string[]
  since: string | null
  limit: number
  routines: 'include' | 'exclude' | 'only'
}

export function searchArgs(spec: SearchSpec): string[] {
  return [
    'search',
    ...freeText('--query', spec.query),
    '--project',
    spec.project,
    ...(spec.boost ? ['--boost-project', spec.boost] : []),
    ...(spec.exclude ? ['--exclude-session', spec.exclude] : []),
    ...(spec.kinds.length > 0 ? ['--kinds', spec.kinds.join(',')] : []),
    ...(spec.since ? ['--since', spec.since] : []),
    '--limit',
    String(spec.limit),
    '--routines',
    spec.routines,
  ]
}

export function expandArgs(ref: string, around = 4, maxChars = 6_000): string[] {
  return ['expand', '--ref', ref, '--before', String(around), '--after', String(around), '--max-chars', String(maxChars)]
}

/** `recap`: the last `count` sessions of a project (every project when null) but `exclude`, routines left out; or one `session`. */
export type RecapSpec = { project: string | null; exclude: string | null; count: number; session?: string }

export function recapArgs(spec: RecapSpec): string[] {
  if (spec.session) {
    return ['recap', '--session', spec.session]
  }
  return [
    'recap',
    ...(spec.project ? ['--project', spec.project] : []),
    ...(spec.exclude ? ['--exclude-session', spec.exclude] : []),
    '--count',
    String(spec.count),
    '--routines',
    'exclude',
  ]
}

export type ListSpec = {
  kind: string
  query: string
  /** A project's path, key or name, or `all`. */
  project: string
  since: string | null
  limit: number
}

export function listArgs(spec: ListSpec): string[] {
  return [
    'list',
    '--kind',
    spec.kind,
    ...(spec.query ? freeText('--query', spec.query) : []),
    '--project',
    spec.project,
    ...(spec.since ? ['--since', spec.since] : []),
    '--limit',
    String(spec.limit),
  ]
}

export function noteArgs(action: 'add' | 'list' | 'forget', value: string, project: string | null): string[] {
  if (action === 'add') {
    return ['note', 'add', ...freeText('--text', value), ...(project ? ['--project', project] : [])]
  }
  if (action === 'list') {
    return ['note', 'list', ...(project ? ['--project', project] : []), '--limit', '50']
  }
  return ['note', 'forget', '--ref', value]
}

export function timelineArgs(project: string, days: number, routines: 'include' | 'exclude', limit = 60): string[] {
  return ['timeline', '--project', project, '--since', `${days}d`, '--limit', String(limit), '--routines', routines]
}

export function forgetArgs(target: RecallForgetTarget): string[] {
  if (target.kind === 'session') {
    return ['forget', '--session', target.id]
  }
  if (target.kind === 'project') {
    return ['forget', '--project', target.name]
  }
  return ['forget', '--before', target.date]
}
