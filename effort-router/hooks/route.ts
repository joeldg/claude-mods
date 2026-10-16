import type { ModelEffort, ModelUsage } from 'claude-code'

import type { RouteAgentTurn, RouteBudget, RouteCache, RouteClass, RouteCounts, RoutePending, RouteState, RouteTurn } from '../types'

export type Level = ModelEffort

export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const isLevel = (value: unknown): value is Level =>
  typeof value === 'string' && (LEVELS as readonly string[]).includes(value)

export const rank = (level: Level): number => LEVELS.indexOf(level)

/** A prompt longer than this is never routine, whatever it starts with. */
export const ROUTINE_MAX_CHARS = 120
/** How many words may follow the routine phrases ("both are merged now" leaves one), none of them new work. */
export const ROUTINE_MAX_EXTRA_WORDS = 6

/**
 * Routine replies are git housekeeping, matched at the start of the prompt: "merged", "#123 merged",
 * "both are merged", "commit and push", "commit it", "push it", "open a PR", "close it". Approvals and
 * resumptions ("yes", "go ahead", "continue", "keep going") are not: they start real work.
 */
export const DEFAULT_ROUTINE = String.raw`merged|(?:pr\s*)?#\d+\s+(?:is\s+|was\s+|got\s+)?merged|(?:all\s+|both\s+|everything\s+)?(?:is\s+|are\s+)?merged|commit(?:\s+and)?\s+push|commit(?:\s+it)?|push(?:\s+it)?|open\s+(?:a\s+)?pr|close\s+(?:it|the\s+issue)`

/** Words that ask for deep thought, anywhere in the prompt (word starts: "audit" covers "auditing"). */
export const DEFAULT_DEEP = String.raw`\b(?:audit|review|plan(?:s|ned|ning)?\b|architect|design|deep[\s-]*dive|assess|investigat|root[\s-]*cause|research|why\s+(?:is|does|did)\b|figure\s+out|what(?:['’]s|\s+is)\s+wrong)`

export type Patterns = {
  /** Anchored at the start; one routine phrase. */
  routine: RegExp
  /** Unanchored; any deep wording. */
  deep: RegExp
}

export type PatternSet = { patterns: Patterns; errors: string[] }

const leading = (source: string): RegExp => new RegExp(String.raw`^(?:${source})(?![A-Za-z0-9_])`, 'i')
const anywhere = (source: string): RegExp => new RegExp(source, 'i')

const compileOne = (
  source: string,
  fallback: string,
  make: (source: string) => RegExp,
  name: string,
  errors: string[],
): RegExp => {
  const trimmed = source.trim()
  if (trimmed !== '') {
    try {
      return make(trimmed)
    } catch (error) {
      errors.push(`${name} is not a valid regular expression (${error instanceof Error ? error.message : String(error)}); the built-in one is used.`)
    }
  }
  return make(fallback)
}

/** The routine and deep patterns from settings; an empty or broken one falls back to the built-in. */
export function compilePatterns(routineSource: string, deepSource: string): PatternSet {
  const errors: string[] = []
  return {
    patterns: {
      routine: compileOne(routineSource, DEFAULT_ROUTINE, leading, 'routinePattern', errors),
      deep: compileOne(deepSource, DEFAULT_DEEP, anywhere, 'deepPattern', errors),
    },
    errors,
  }
}

/** Punctuation and quoting between and around routine phrases. */
const FILLER = /^[\s,.;:!?…—–\-"'`*_()[\]>]+/

const wordCount = (text: string): number => text.split(/\s+/).filter(word => /[A-Za-z0-9]/.test(word)).length

/** The routine phrases a prompt opens with ("merged, commit and push") and what follows them. */
export function leadingRoutine(text: string, routine: RegExp): { phrases: string[]; rest: string } | null {
  let rest = text.replace(FILLER, '')
  const phrases: string[] = []
  for (let i = 0; i < 8; i++) {
    const found = routine.exec(rest)
    if (!found || found[0] === '') {
      break
    }
    phrases.push(found[0])
    rest = rest.slice(found[0].length).replace(FILLER, '')
  }
  return phrases.length > 0 ? { phrases, rest } : null
}

/**
 * Words after the routine phrases that start new work ("merged, go ahead with #214", "push it and fix
 * the lint"): such a prompt is not routine, whatever it opens with.
 */
export const NEW_WORK =
  /\b(?:start|begin|work\s+on|take|tackle|fix|implement|build|add|write|create|make|proceed|move\s+on|run|deploy|refactor|update|change|rename|remove|delete|investigate|look|check|debug|test|handle|address|file|install|download|train|generate|render|print|go\s+(?:ahead\s+)?(?:with|on)|continue|keep\s+going|do\b|try)\b|\b(?:with|on|to)\s+#?[A-Za-z]*-?\d/i

export type Classified = { cls: RouteClass; why: string }

/**
 * Routine: at most 120 characters, opening with routine phrases and little else. Deep: deep wording
 * anywhere. Both at once ("commit and push, then review the diff") is no opinion: the session's own effort.
 */
export function classify(text: string, patterns: Patterns): Classified {
  const trimmed = text.trim()
  const lead = leadingRoutine(trimmed, patterns.routine)
  const isRoutine =
    lead !== null &&
    trimmed.length <= ROUTINE_MAX_CHARS &&
    wordCount(lead.rest) <= ROUTINE_MAX_EXTRA_WORDS &&
    !NEW_WORK.test(lead.rest)
  const deep = patterns.deep.exec(trimmed)
  if (isRoutine && deep) {
    return { cls: 'neutral', why: `both routine ("${lead.phrases.join(', ')}") and deep ("${deep[0]}")` }
  }
  if (isRoutine) {
    return { cls: 'routine', why: `starts with "${lead.phrases.join(', ')}"` }
  }
  if (deep) {
    return { cls: 'deep', why: `mentions "${deep[0]}"` }
  }
  if (lead !== null) {
    return { cls: 'neutral', why: trimmed.length > ROUTINE_MAX_CHARS ? 'too long to be routine' : 'more than a routine reply' }
  }
  return { cls: 'neutral', why: 'no routine or deep wording' }
}

export type Guard = {
  /** Turns in a row a lower effort must be wanted before it is sent over a warm, large cache. */
  stickyTurns: number
  /** Below this many context tokens a switch costs little: it is made at once. */
  freeSwitchTokens: number
  /** Idle longer than this and the cache has lapsed: a switch costs nothing extra. */
  cacheTtlMs: number
}

export type Why = 'same' | 'forced' | 'off' | 'model' | 'base' | 'history' | 'cold' | 'small' | 'up' | 'streak' | 'hold'

export type Ask = {
  want: Level
  /** The model this request names (after the model guard). */
  model: string
  /** The session's own effort, as the engine offers it on this request. */
  base: Level
  messageCount: number
  now: number
  isForced: boolean
}

export type Decision = { effort: Level; why: Why; lowerStreak: number }

/**
 * The effort a new turn is sent at, given what the prompt cache was written with.
 *
 * Claude Code sends effort as the request's top-level `output_config.effort`, and the API renders it
 * into the prompt: a change invalidates the cached messages (on some models the system prompt and
 * tools too), so the next request re-writes the whole conversation at the cache-write price. So a
 * switch is made at once only when it is cheap or asked for: the person forced it, the model or the
 * session's own effort changed (the cache is cold for it anyway), the history shrank (compaction,
 * /clear), the cache has lapsed (idle past its TTL), the context is small, or the turn wants MORE
 * effort (quality never waits). A turn wanting LESS effort over a warm, large cache is held at the
 * current effort until `stickyTurns` turns in a row have wanted less.
 */
export function decide(cache: RouteCache, ask: Ask, guard: Guard): Decision {
  const switchTo = (why: Why): Decision => ({ effort: ask.want, why, lowerStreak: 0 })
  if (ask.want === cache.applied) {
    return switchTo('same')
  }
  if (ask.isForced) {
    return switchTo('forced')
  }
  if (ask.model !== cache.model) {
    return switchTo('model')
  }
  if (ask.base !== cache.base) {
    return switchTo('base')
  }
  if (ask.messageCount < cache.messageCount) {
    return switchTo('history')
  }
  if (cache.lastAt !== null && ask.now - cache.lastAt > guard.cacheTtlMs) {
    return switchTo('cold')
  }
  if (cache.contextTokens < guard.freeSwitchTokens) {
    return switchTo('small')
  }
  if (rank(ask.want) > rank(cache.applied)) {
    return switchTo('up')
  }
  const lowerStreak = cache.lowerStreak + 1
  if (lowerStreak >= Math.max(1, guard.stickyTurns)) {
    return switchTo('streak')
  }
  return { effort: cache.applied, why: 'hold', lowerStreak }
}

export const EMPTY_COUNTS: RouteCounts = { routine: 0, deep: 0, neutral: 0, switches: 0, holds: 0 }

export const EMPTY_STATE: RouteState = {
  isOn: true,
  forced: null,
  pending: null,
  turn: null,
  cache: null,
  counts: EMPTY_COUNTS,
  rewrites: [],
  budget: null,
  agents: {},
}

/** A prompt was submitted: classify it (or take the class /route forced) for the turn it starts. */
export function submitted(state: RouteState, text: string, isPersonal: boolean, patterns: Patterns): RouteState {
  if (!isPersonal) {
    return { ...state, pending: { cls: 'neutral', why: 'not typed by you', isForced: false, text } }
  }
  if (state.forced !== null) {
    return { ...state, forced: null, pending: { cls: state.forced, why: 'forced with /route', isForced: true, text } }
  }
  return { ...state, pending: { ...classify(text, patterns), isForced: false, text } }
}

/** A main-loop turn started: it takes the pending prompt's class. */
export function started(state: RouteState, turnId: string, text: string, patterns: Patterns): RouteState {
  const pending: RoutePending =
    state.pending ??
    (text.trim() === ''
      ? { cls: 'neutral', why: 'no prompt', isForced: false, text: '' }
      : { ...classify(text, patterns), isForced: false, text })
  const turn: RouteTurn = { ...pending, id: turnId, effort: null, want: null, decision: null, streak: 0, cappedAt: null }
  return { ...state, pending: null, turn }
}

export type Settings = {
  routineEffort: Level
  deepEffort: Level
  guard: Guard
  /** Percent of the 5-hour limit used at which every effort is capped; 0 turns the cap off. */
  budgetCapAt: number
  /** The most effort any request gets while the cap is in force. */
  budgetCapEffort: Level
  /** The effort subagent requests run at; null leaves them at the session's own. */
  subagentEffort: Level | null
}

/** Where usage-meter writes its machine-wide summary of the last 5 hours, under the home folder. */
export const SUMMARY_PATH = '.claude/usage-meter/summary.json'
/** How long one reading of the summary serves. */
export const BUDGET_MEMO_MS = 30_000
/** A summary older than this says nothing about now. */
export const BUDGET_STALE_MS = 10 * 60_000

/** What usage-meter's summary says: the percent of the 5-hour limit used, or why there is no information. */
export type BudgetReading = { pct: number | null; note: string }

const NO_SUMMARY: BudgetReading = { pct: null, note: 'no usage-meter summary' }

/**
 * usage-meter's summary (`{ ts, pct, ... }`) read as budget information: its `pct` when the file parses
 * and its `ts` is at most 10 minutes old; none when the file is missing, unreadable or stale, or `pct`
 * is null (no limit has been hit yet, so none is learned).
 */
export function parseSummary(text: string | null, now: number): BudgetReading {
  if (text === null) {
    return NO_SUMMARY
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return NO_SUMMARY
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NO_SUMMARY
  }
  const { ts, pct } = parsed as { ts?: unknown; pct?: unknown }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return NO_SUMMARY
  }
  if (now - ts > BUDGET_STALE_MS) {
    return { pct: null, note: `summary is ${Math.round((now - ts) / 60_000)} min old` }
  }
  if (pct === null) {
    return { pct: null, note: 'no limit learned yet' }
  }
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return NO_SUMMARY
  }
  return { pct, note: '' }
}

export type BudgetChange = 'engaged' | 'released' | null

/** A fresh reading of the summary: kept for the memo, the cap engaging or releasing as it crosses `capAt`. */
export function noteBudget(state: RouteState, reading: BudgetReading, now: number, capAt: number): { state: RouteState; change: BudgetChange } {
  const was = state.budget?.isCapping ?? false
  const isCapping = capAt > 0 && reading.pct !== null && reading.pct >= capAt
  const budget: RouteBudget = { checkedAt: now, pct: reading.pct, note: reading.note, isCapping }
  return { state: { ...state, budget }, change: isCapping === was ? null : isCapping ? 'engaged' : 'released' }
}

/** The percent used while the cap is in force; null when it is not (cap off, no information, under the threshold). */
export function cappingPct(state: RouteState, settings: Settings): number | null {
  const budget = state.budget ?? null
  return settings.budgetCapAt > 0 && budget !== null && budget.isCapping ? budget.pct : null
}

/** The effort a turn or subagent wants, lowered to the cap while the budget is in force; a want at or below it is left alone. */
function capped(want: Level, state: RouteState, settings: Settings): { want: Level; cappedAt: number | null } {
  const pct = cappingPct(state, settings)
  return pct !== null && rank(want) > rank(settings.budgetCapEffort) ? { want: settings.budgetCapEffort, cappedAt: pct } : { want, cappedAt: null }
}

/** The debug-log line when the budget cap engages or releases. */
export function describeBudgetChange(change: 'engaged' | 'released', budget: RouteBudget, settings: Settings): string {
  const used =
    budget.pct === null ? `no budget information (${budget.note})` : `${Math.round(budget.pct)}% of the 5-hour limit used (cap at ${settings.budgetCapAt}%)`
  return change === 'engaged'
    ? `effort-router: budget cap engaged: ${used}; turns run at ${settings.budgetCapEffort} or less`
    : `effort-router: budget cap released: ${used}`
}

/** What a subagent's request carries. */
export type AgentFacts = { agentId: string; turnId: string; effort: Level }

/**
 * The effort a subagent's request is sent at: `subagentEffort` when set, else its own, lowered to the
 * budget cap while it is in force. Decided at the first request of the agent's turn and kept for the
 * turn (routing off included), so a subagent never switches midway either.
 */
export function planAgentStep(state: RouteState, facts: AgentFacts, settings: Settings): { state: RouteState; effort: Level } {
  const agents = state.agents ?? {}
  const pinned = agents[facts.agentId]
  if (pinned !== undefined && pinned.turnId === facts.turnId) {
    return { state, effort: pinned.effort }
  }
  const want = state.isOn ? capped(settings.subagentEffort ?? facts.effort, state, settings).want : facts.effort
  const pin: RouteAgentTurn = { turnId: facts.turnId, effort: want }
  return { state: { ...state, agents: { ...agents, [facts.agentId]: pin } }, effort: want }
}

/** A subagent's turn ended: the effort pinned for it is dropped. */
export function agentDone(state: RouteState, agentId: string): RouteState {
  const agents = state.agents ?? {}
  if (!(agentId in agents)) {
    return state
  }
  const rest = { ...agents }
  delete rest[agentId]
  return { ...state, agents: rest }
}

/** What a main-loop request carries, as the engine is about to send it. */
export type StepFacts = {
  turnId: string
  /** The model it names, after the model guard. */
  model: string
  /** The session's own effort. */
  base: Level
  messageCount: number
  now: number
  /** The context's size, used only when nothing was seen before (the mod loaded mid-session). */
  contextTokens: number
}

export type Planned = { state: RouteState; effort: Level; isNew: boolean; status: string | undefined }

/**
 * What the status line says while a turn runs; undefined when the turn runs as the session would.
 * `cappedAt` is the budget percent that lowered the turn's want, when the cap did.
 */
export function statusText(cls: RouteClass, decision: Decision, isForced: boolean, stickyTurns: number, cappedAt: number | null = null): string | undefined {
  const budget = cappedAt === null ? null : `budget ${Math.round(cappedAt)}%`
  if (decision.why === 'hold') {
    const lead = budget !== null ? `${budget}, ` : cls === 'neutral' ? '' : `${cls}, `
    return `effort: ${decision.effort} (${lead}held for the prompt cache ${decision.lowerStreak}/${stickyTurns})`
  }
  if (budget !== null) {
    return `effort: ${decision.effort} (${budget})`
  }
  if (cls === 'neutral' || decision.why === 'off') {
    return undefined
  }
  return `effort: ${decision.effort} (${cls}${isForced ? ', forced' : ''})`
}

/**
 * The effort a main-loop request is sent at. The turn's first request decides; every later
 * request of the same turn carries the same effort, so a turn never switches midway.
 */
export function planStep(state: RouteState, facts: StepFacts, settings: Settings): Planned {
  const current = state.turn
  if (current !== null && current.id === facts.turnId && current.effort !== null) {
    return { state, effort: current.effort, isNew: false, status: undefined }
  }
  const turn: RouteTurn =
    current !== null && current.id === facts.turnId
      ? current
      : { id: facts.turnId, cls: 'neutral', why: 'its prompt was not seen', isForced: false, text: '', effort: null, want: null, decision: null, streak: 0, cappedAt: null }
  const cache: RouteCache = state.cache ?? {
    applied: facts.base,
    model: facts.model,
    base: facts.base,
    messageCount: facts.messageCount,
    contextTokens: facts.contextTokens,
    lastAt: null,
    lowerStreak: 0,
  }
  const isRouted = state.isOn || turn.isForced
  const asked: Level = !isRouted || turn.cls === 'neutral' ? facts.base : turn.cls === 'routine' ? settings.routineEffort : settings.deepEffort
  // The budget cap lowers what any routed turn wants, deep asks included; the cache guard below treats it as any lowering.
  const { want, cappedAt } = isRouted ? capped(asked, state, settings) : { want: asked, cappedAt: null }
  const decision: Decision = isRouted
    ? decide(cache, { want, model: facts.model, base: facts.base, messageCount: facts.messageCount, now: facts.now, isForced: turn.isForced }, settings.guard)
    : { effort: want, why: 'off', lowerStreak: 0 }
  const counts: RouteCounts = {
    ...state.counts,
    [turn.cls]: state.counts[turn.cls] + 1,
    switches: state.counts.switches + (decision.effort === cache.applied ? 0 : 1),
    holds: state.counts.holds + (decision.why === 'hold' ? 1 : 0),
  }
  return {
    state: {
      ...state,
      turn: { ...turn, effort: decision.effort, want, decision: decision.why, streak: decision.lowerStreak, cappedAt },
      cache: {
        ...cache,
        applied: decision.effort,
        model: facts.model,
        base: facts.base,
        messageCount: facts.messageCount,
        lowerStreak: decision.lowerStreak,
      },
      counts,
    },
    effort: decision.effort,
    isNew: true,
    status: statusText(turn.cls, decision, turn.isForced, Math.max(1, settings.guard.stickyTurns), cappedAt),
  }
}

/** Prompt tokens a response was answered over plus its output: what the next request re-sends. */
export const contextOf = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens

/** A main-loop response arrived: remember how big the cached prefix now is, and when it was written. */
export function responded(
  state: RouteState,
  facts: { model: string; messageCount: number; now: number; usage: ModelUsage | null },
): RouteState {
  if (state.cache === null) {
    return state
  }
  const cache: RouteCache =
    facts.usage === null
      ? { ...state.cache, model: facts.model, messageCount: facts.messageCount }
      : { ...state.cache, model: facts.model, messageCount: facts.messageCount, contextTokens: contextOf(facts.usage), lastAt: facts.now }
  return { ...state, cache }
}

/** /clear: a new conversation whose first request writes a fresh cache, so the next switch is free. */
export function cleared(state: RouteState): RouteState {
  return {
    ...state,
    pending: null,
    turn: null,
    counts: EMPTY_COUNTS,
    cache: state.cache === null ? null : { ...state.cache, messageCount: 0, contextTokens: 0, lastAt: null, lowerStreak: 0 },
    agents: {},
  }
}

/** Current model ids for the family aliases, so a rewrite never depends on the engine resolving an alias. */
export const MODEL_IDS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
}

/**
 * The model id a fallback names: a family alias becomes its current id, spelled with the provider
 * prefix the engine's own id carries (`us.anthropic.`); anything else is taken as written.
 */
export function resolveModel(fallback: string, current: string): string {
  const name = fallback.trim()
  const id = MODEL_IDS[name.toLowerCase()]
  if (id === undefined) {
    return name
  }
  const at = current.indexOf('claude-')
  return (at > 0 ? current.slice(0, at) : '') + id
}

/** The model a request goes to: the fallback when the engine's matches `avoid` (and the fallback does not). */
export function guardModel(model: string, avoid: RegExp | null, fallback: string): string {
  if (avoid === null || !avoid.test(model)) {
    return model
  }
  const target = resolveModel(fallback, model)
  return target === '' || avoid.test(target) ? model : target
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const WHY_WORDS: Readonly<Record<string, string>> = {
  same: 'no change',
  forced: 'forced',
  off: 'routing off',
  model: 'switched with the model',
  base: 'your own /effort changed',
  history: 'after compaction',
  cold: 'cache had lapsed',
  small: 'small context',
  up: 'more effort never waits',
  streak: 'lower effort wanted turns in a row',
  hold: 'held for the prompt cache',
}

export type Describe = {
  settings: Settings
  /** e.g. `models matching /fable/i run on claude-opus-5-5`, or null when off. */
  modelGuard: string | null
  errors: readonly string[]
}

const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** The /route line about the last turn: its class, prompt and why, and the effort it got or is held at. */
function lastTurnLine(turn: RouteTurn): string {
  const quoted = turn.text === '' ? '' : ` "${clip(turn.text, 60)}"`
  const cappedAt = turn.cappedAt ?? null
  const budget = cappedAt === null ? null : `budget ${Math.round(cappedAt)}%`
  const effort =
    turn.effort === null
      ? 'effort not chosen yet'
      : turn.decision === 'hold'
        ? `${turn.effort}, held for the prompt cache (wanted ${turn.want ?? '?'}${budget === null ? '' : `: ${budget}`})`
        : budget !== null
          ? `${turn.effort} (${budget})`
          : `${turn.effort} (${WHY_WORDS[turn.decision ?? 'same'] ?? turn.decision})`
  return `Last turn: ${turn.cls}${quoted}, ${turn.why} → ${effort}`
}

/** The /route lines about the budget cap (the last reading, the threshold and effort, whether it is in force) and subagents. */
function budgetLines(state: RouteState, settings: Settings): string[] {
  const subagents = settings.subagentEffort === null ? "Subagents: the session's own effort" : `Subagents: run at ${settings.subagentEffort}`
  if (settings.budgetCapAt <= 0) {
    return ['Budget cap: off', subagents]
  }
  const budget = state.budget ?? null
  const used = budget === null ? 'not read yet' : budget.pct === null ? `unknown (${budget.note})` : `${Math.round(budget.pct)}% of the 5-hour limit used`
  const standing = budget === null || !budget.isCapping ? 'not engaged' : state.isOn ? 'engaged' : 'not applied while routing is off'
  return [`Budget: ${used} · cap at ${settings.budgetCapAt}% → ${settings.budgetCapEffort}: ${standing}`, subagents]
}

/** What /route prints. */
export function describeRoute(state: RouteState, info: Describe): string {
  const { settings } = info
  const effortFor = (cls: 'routine' | 'deep'): Level => (cls === 'routine' ? settings.routineEffort : settings.deepEffort)
  const lines = [state.isOn ? 'effort-router: on' : 'effort-router: off for this session (/route on resumes; /route deep or routine still apply)']
  if (state.forced !== null) {
    lines.push(`Next prompt: forced ${state.forced} (${effortFor(state.forced)})`)
  }
  lines.push(state.turn === null ? 'No turn routed yet.' : lastTurnLine(state.turn))
  const c = state.counts
  lines.push(
    `This session: ${c.routine} routine, ${c.deep} deep, ${c.neutral} neutral turns · ${c.switches} effort ${c.switches === 1 ? 'switch' : 'switches'} · ${c.holds} held for the prompt cache`,
    `Routine → ${settings.routineEffort}, deep → ${settings.deepEffort}, neutral → the session's own effort.`,
    `Cache guard: a switch is made at once under ${formatTokens(settings.guard.freeSwitchTokens)} context tokens, after ${Math.round(settings.guard.cacheTtlMs / 60_000)} min idle, or toward more effort; less effort waits for ${Math.max(1, settings.guard.stickyTurns)} turns in a row.`,
  )
  if (state.cache !== null) {
    lines.push(`Prompt cache: written at ${state.cache.applied} over about ${formatTokens(state.cache.contextTokens)} tokens.`)
  }
  lines.push(info.modelGuard === null ? 'Model guard: off' : `Model guard: ${info.modelGuard}`)
  lines.push(...budgetLines(state, settings), ...info.errors)
  return lines.join('\n')
}
