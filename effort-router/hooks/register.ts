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
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import {
  EMPTY_STATE,
  cleared,
  compilePatterns,
  describeRoute,
  guardModel,
  isLevel,
  planStep,
  resolveModel,
  responded,
  started,
  submitted,
} from './route'
import type { Level, Patterns, Planned, Settings } from './route'

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

/** The effort this main-loop request is sent at: decided at the turn's first request, then kept. */
async function chooseEffort($: Engine, e: TurnStepInput, model: string, base: Level): Promise<Level> {
  const before = await read($, router)
  if (before.turn !== null && before.turn.id === e.turnId && before.turn.effort !== null) {
    return before.turn.effort
  }
  const now = await $.clock.now()
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
function reportFailure($: Engine, what: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  $.ui.log(`effort-router: ${what} failed, so the request went out unchanged: ${message.slice(0, 200)}`, { to: 'debug' })
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

  on('command.run', { command: 'route' }, async ($, e) => {
    if (!config.enabled) {
      return { text: 'effort-router is turned off in its settings (enabled: false); requests are left as they are.' }
    }
    const verb = e.args.trim().toLowerCase()
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
    const state = await read($, router)
    return { text: describeRoute(state, { settings: config.settings, modelGuard: modelGuardLine(), errors: config.errors }) }
  })

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
    await update($, router, state => started(state, e.turnId, e.text, config.patterns))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Routing must never cost a request: if choosing fails, the request goes out exactly as it came, and
    // the failure is logged where mod-monitor reads it (this stream is not a hook it can watch).
    let routed = e
    let model = e.model
    let isRouted = false
    try {
      model = await guardedModel($, e.model)
      if (e.agentId !== undefined || !isLevel(e.effort)) {
        // A subagent keeps its own effort; a model without effort levels has none to route.
        routed = model === e.model ? e : { ...e, model }
      } else {
        const effort = await chooseEffort($, e, model, e.effort)
        routed = effort === e.effort && model === e.model ? e : { ...e, model, effort }
        isRouted = true
      }
    } catch (error) {
      routed = e
      model = e.model
      isRouted = false
      reportFailure($, 'choosing the effort', error)
    }
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
