/**
 * effort-router: sends git housekeeping replies ("merged", "#219 merged", "commit and push", "push it")
 * at low effort and deep asks ("review", "audit", "why does ...") at max, by rewriting the effort of
 * each model request (`turn.step`). Approvals and replies that start new work ("yes", "continue",
 * "merged, go ahead with #214") keep the session's own effort. The prompt itself passes through
 * unchanged; no model call is made.
 *
 * The prompt cache. Claude Code sends effort as the request's top-level `output_config.effort`
 * (this build has no per-message effort beta), and the API renders effort into the prompt: changing
 * it between requests invalidates the cached messages (on some models the system prompt and tools
 * too), so the next request writes the whole conversation to the cache again at the write price
 * instead of reading it at a tenth of the input price. On a large conversation one switch can cost
 * more than low effort saves on a short reply, and switching down and back up costs it twice. So:
 *
 * - The effort is chosen once per turn, at its first request, and every later request of the turn
 *   (each tool round) carries the same effort: never a switch mid-turn.
 * - A switch is made at once when it is cheap or asked for: the context is small (`freeSwitchTokens`),
 *   the cache has lapsed (idle past `cacheTtlMinutes`; Claude Code caches the main thread for an hour
 *   on a subscription, five minutes with an API key), the model or the session's own /effort changed,
 *   compaction or /clear rewrote the history, `/route deep|routine` forced it, or the turn wants MORE
 *   effort (quality never waits for the cache).
 * - Less effort over a warm, large cache waits until `stickyTurns` turns in a row have wanted it
 *   (hysteresis): one "push it" between two real tasks is not worth two cache rewrites.
 *
 * The model guard (`avoidModel` → `fallbackModel`) rewrites every request the same way, main loop and
 * subagents alike, so the cache is rebuilt once for the new model and then reused.
 *
 * The budget cap (`budgetCapAt` → `budgetCapEffort`). usage-meter writes a machine-wide summary of the
 * last 5 hours to ~/.claude/usage-meter/summary.json; once its `pct` (of the last learned limit)
 * reaches `budgetCapAt`, every turn's effort is capped at `budgetCapEffort`, deep asks included: the
 * point is not to hit the wall. The summary is read at a turn's first request, one reading serving
 * 30 s; a missing or stale file (over 10 minutes old) or a null `pct` is no budget information. The
 * cap only lowers what a turn wants, so it goes through the same cache discipline: over a warm, large
 * cache it waits for `stickyTurns` turns like any lowering, and a turn's effort never changes midway.
 *
 * Subagents (`subagentEffort`) run at that effort when it is set, the budget cap applying to them too
 * (the lower of the two); each subagent turn's effort is decided at its first request and kept.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import type { RouteBudget, RouteState } from '../types'
import {
  BUDGET_MEMO_MS,
  EMPTY_STATE,
  SUMMARY_PATH,
  agentDone,
  cleared,
  compilePatterns,
  describeBudgetChange,
  describeRoute,
  guardModel,
  isLevel,
  noteBudget,
  parseSummary,
  planAgentStep,
  planStep,
  resolveModel,
  responded,
  started,
  submitted,
} from './route'
import type { BudgetChange, Level, Patterns, Planned, Settings } from './route'

type Engine = EngineInterface

const router = atom({ plugin: 'effort-router', key: 'router' } as const, EMPTY_STATE)

/** Prompts the person wrote: typed, through Remote Control, a host's own turn, a scheduled routine, a Slack ping. */
const PERSONAL = new Set<string>(['composer', 'bridge', 'sdk', 'scheduled-trigger', 'slack-ping'])

const isPersonal = (origin: PromptOrigin): boolean =>
  PERSONAL.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const USAGE = 'Usage: /route (status) | /route on | /route off | /route deep | /route routine (forces the next prompt)'

type Config = {
  enabled: boolean
  settings: Settings
  patterns: Patterns
  errors: string[]
  avoid: RegExp | null
  fallbackModel: string
}

const DEFAULT_SETTINGS: Settings = {
  routineEffort: 'low',
  deepEffort: 'max',
  guard: { stickyTurns: 2, freeSwitchTokens: 30_000, cacheTtlMs: 60 * 60_000 },
  budgetCapAt: 80,
  budgetCapEffort: 'high',
  subagentEffort: null,
}

let config: Config = {
  enabled: true,
  settings: DEFAULT_SETTINGS,
  patterns: compilePatterns('', '').patterns,
  errors: [],
  avoid: null,
  fallbackModel: 'opus',
}

const numberIn = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const modelGuardLine = (): string | null =>
  config.avoid === null ? null : `models matching /${config.avoid.source}/i run on ${resolveModel(config.fallbackModel, '')}`

/** The model a request goes to; the first rewrite of each kind is announced once. */
async function guardedModel($: Engine, model: string): Promise<string> {
  if (config.avoid === null || !config.avoid.test(model)) {
    return model
  }
  const target = guardModel(model, config.avoid, config.fallbackModel)
  const key = `${model}→${target}`
  let isFirst = false
  await update($, router, state => {
    isFirst = !state.rewrites.includes(key)
    return isFirst ? { ...state, rewrites: [...state.rewrites, key] } : state
  })
  if (isFirst) {
    $.ui.toast(
      target === model
        ? `effort-router: ${model} matches avoidModel, but so does the fallback "${config.fallbackModel}"; requests stay on ${model}.`
        : `effort-router: requests for ${model} go to ${target} (avoidModel).`,
    )
  }
  return target
}

/** The context's size when the mod first sees a request (it may have loaded mid-session); 0 if unknown. */
async function contextNow($: Engine): Promise<number> {
  try {
    const usage = await $.session.usage()
    return usage.context.tokens ?? 0
  } catch {
    return 0
  }
}

/** usage-meter's summary of the last 5 hours, machine-wide; null when there is none to read. */
async function readSummary($: Engine): Promise<string | null> {
  try {
    const home = await $.env.get('HOME')
    return home ? await $.fs.read(`${home}/${SUMMARY_PATH}`) : null
  } catch {
    return null
  }
}

/**
 * Brings the budget reading up to date once the memo has run out, and logs the cap engaging or
 * releasing. Never throws: without a fresh reading the turn runs on the last one.
 */
async function refreshBudget($: Engine, now: number, known: RouteState): Promise<void> {
  if (config.settings.budgetCapAt <= 0) {
    return
  }
  const memo = known.budget ?? null
  if (memo !== null && now - memo.checkedAt < BUDGET_MEMO_MS) {
    return
  }
  try {
    const reading = parseSummary(await readSummary($), now)
    const noted: { change: BudgetChange; budget: RouteBudget | null } = { change: null, budget: null }
    await update($, router, state => {
      const next = noteBudget(state, reading, now, config.settings.budgetCapAt)
      noted.change = next.change
      noted.budget = next.state.budget
      return next.state
    })
    if (noted.change !== null && noted.budget !== null) {
      $.ui.log(describeBudgetChange(noted.change, noted.budget, config.settings), { to: 'debug' })
    }
  } catch (error) {
    reportFailure($, 'reading the budget', error, 'so the turn runs on the last reading')
  }
}

/** The effort this main-loop request is sent at: decided at the turn's first request, then kept. */
async function chooseEffort($: Engine, e: TurnStepInput, model: string, base: Level): Promise<Level> {
  const before = await read($, router)
  if (before.turn !== null && before.turn.id === e.turnId && before.turn.effort !== null) {
    return before.turn.effort
  }
  const now = await $.clock.now()
  if (before.isOn || (before.turn !== null && before.turn.id === e.turnId && before.turn.isForced)) {
    await refreshBudget($, now, before)
  }
  const contextTokens = before.cache === null ? await contextNow($) : 0
  const plan: { planned: Planned | null } = { planned: null }
  await update($, router, state => {
    plan.planned = planStep(state, { turnId: e.turnId, model, base, messageCount: e.messageCount, now, contextTokens }, config.settings)
    return plan.planned.state
  })
  if (plan.planned === null) {
    return base
  }
  if (plan.planned.isNew) {
    $.ui.status(plan.planned.status)
  }
  return plan.planned.effort
}

/** The effort a subagent's request is sent at: decided at its turn's first request, then kept. */
async function chooseAgentEffort($: Engine, agentId: string, turnId: string, base: Level): Promise<Level> {
  const before = await read($, router)
  const pinned = (before.agents ?? {})[agentId]
  if (pinned !== undefined && pinned.turnId === turnId) {
    return pinned.effort
  }
  if (before.isOn) {
    await refreshBudget($, await $.clock.now(), before)
  }
  const plan = { effort: base }
  await update($, router, state => {
    const planned = planAgentStep(state, { agentId, turnId, effort: base }, config.settings)
    plan.effort = planned.effort
    return planned.state
  })
  return plan.effort
}

/** Remembers how large the cached conversation is now, and when it was last written. */
async function noteResponse($: Engine, messageCount: number, model: string, result: TurnStepResult) {
  try {
    const now = await $.clock.now()
    await update($, router, state => responded(state, { model, messageCount, now, usage: result.usage }))
  } catch {
    // The next turn decides from what was known before; nothing to undo.
  }
}

/** A failure in effort-router's own code, logged (to the debug log) for mod-monitor to count. */
function reportFailure($: Engine, what: string, error: unknown, consequence = 'so the request went out unchanged') {
  const message = error instanceof Error ? error.message : String(error)
  $.ui.log(`effort-router: ${what} failed, ${consequence}: ${message.slice(0, 200)}`, { to: 'debug' })
}

/**
 * The request as it goes out: the model after the guard, and the effort chosen for the main loop's
 * turn or the subagent's. Routing must never cost a request: if choosing fails, the request goes out
 * exactly as it came, and the failure is logged where mod-monitor reads it (the response stream is not
 * a hook it can watch). `isRouted` says the main loop's response should be noted for the cache.
 */
async function routeRequest($: Engine, e: TurnStepInput): Promise<{ routed: TurnStepInput; model: string; isRouted: boolean }> {
  try {
    const model = await guardedModel($, e.model)
    if (!isLevel(e.effort)) {
      // A model without effort levels has none to route.
      return { routed: model === e.model ? e : { ...e, model }, model, isRouted: false }
    }
    if (e.agentId !== undefined) {
      const effort = await chooseAgentEffort($, e.agentId, e.turnId, e.effort)
      return { routed: effort === e.effort && model === e.model ? e : { ...e, model, effort }, model, isRouted: false }
    }
    const effort = await chooseEffort($, e, model, e.effort)
    return { routed: effort === e.effort && model === e.model ? e : { ...e, model, effort }, model, isRouted: true }
  } catch (error) {
    reportFailure($, 'choosing the effort', error)
    return { routed: e, model: e.model, isRouted: false }
  }
}

/** A subagent's turn ended: the effort pinned for it is dropped. */
async function forgetAgent($: Engine, agentId: string): Promise<void> {
  try {
    await update($, router, state => agentDone(state, agentId))
  } catch (error) {
    reportFailure($, 'forgetting a subagent turn', error, 'so its effort stays pinned until its next turn')
  }
}

/** /route: the status, on or off for the session, or forcing the next prompt deep or routine. */
async function runRoute($: Engine, args: string): Promise<{ text: string }> {
  if (!config.enabled) {
    return { text: 'effort-router is turned off in its settings (enabled: false); requests are left as they are.' }
  }
  const verb = args.trim().toLowerCase()
  if (verb === 'off') {
    await update($, router, state => ({ ...state, isOn: false }))
    return { text: "Effort routing is off for this session: turns run at the session's own effort. /route on turns it back on." }
  }
  if (verb === 'on') {
    await update($, router, state => ({ ...state, isOn: true }))
    return { text: 'Effort routing is on.' }
  }
  if (verb === 'deep' || verb === 'routine') {
    const forced: 'deep' | 'routine' = verb
    await update($, router, state => ({ ...state, forced }))
    const effort = forced === 'deep' ? config.settings.deepEffort : config.settings.routineEffort
    return { text: `Your next prompt runs at ${effort} (${forced}), whatever it says.` }
  }
  if (verb !== '' && verb !== 'status') {
    return { text: USAGE }
  }
  let state = await read($, router)
  if (state.isOn && config.settings.budgetCapAt > 0) {
    // Shows the budget as it stands now, not as the last turn saw it.
    try {
      await refreshBudget($, await $.clock.now(), state)
      state = await read($, router)
    } catch (error) {
      reportFailure($, 'reading the budget', error, 'so /route shows the last reading')
    }
  }
  return { text: describeRoute(state, { settings: config.settings, modelGuard: modelGuardLine(), errors: config.errors }) }
}

export const register: Register = (on, options) => {
  const compiled = compilePatterns(textOf(options.routinePattern), textOf(options.deepPattern))
  const errors = [...compiled.errors]
  let avoid: RegExp | null = null
  const avoidSource = textOf(options.avoidModel).trim()
  if (avoidSource !== '') {
    try {
      avoid = new RegExp(avoidSource, 'i')
    } catch (error) {
      errors.push(`avoidModel is not a valid regular expression (${error instanceof Error ? error.message : String(error)}); the model guard is off.`)
    }
  }
  config = {
    enabled: options.enabled !== false,
    settings: {
      routineEffort: isLevel(options.routineEffort) ? options.routineEffort : 'low',
      deepEffort: isLevel(options.deepEffort) ? options.deepEffort : 'max',
      guard: {
        stickyTurns: Math.round(numberIn(options.stickyTurns, 2, 1, 20)),
        freeSwitchTokens: numberIn(options.freeSwitchTokens, 30_000, 0, 10_000_000),
        cacheTtlMs: numberIn(options.cacheTtlMinutes, 60, 0, 24 * 60) * 60_000,
      },
      budgetCapAt: numberIn(options.budgetCapAt, 80, 0, 100),
      budgetCapEffort: isLevel(options.budgetCapEffort) ? options.budgetCapEffort : 'high',
      subagentEffort: isLevel(options.subagentEffort) ? options.subagentEffort : null,
    },
    patterns: compiled.patterns,
    errors,
    avoid,
    fallbackModel: textOf(options.fallbackModel).trim() || 'opus',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Effort routing: status, on/off for this session, or force the next prompt deep or routine',
      argumentHint: '[on | off | deep | routine]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'route' }, ($, e) => runRoute($, e.args))

  if (!config.enabled) {
    return
  }

  // Classifies the prompt for the turn it starts; the prompt itself goes on unchanged.
  on('prompt.submit', async ($, e, next) => {
    try {
      const isMine = isPersonal(e.origin)
      await update($, router, state => submitted(state, e.text, isMine, config.patterns))
    } catch {
      // Unclassified: the turn runs at the session's own effort.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's turn: its prompt is not the person's, and the main turn keeps its own record.
      return next(e)
    }
    await update($, router, state => started(state, e.turnId, e.text, config.patterns))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const { routed, model, isRouted } = await routeRequest($, e)
    const result = yield* next(routed)
    if (isRouted) {
      try {
        await noteResponse($, e.messageCount, model, result)
      } catch (error) {
        reportFailure($, 'noting the response', error)
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      $.ui.status(undefined)
    } else {
      await forgetAgent($, e.agentId)
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, router, cleared)
    }
    return next(e)
  })
}
