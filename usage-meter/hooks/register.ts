import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Hit, Summary, TurnLine, UsageAlerts, UsageSettings } from '../types'
import {
  HOUR_MS,
  KEPT_HITS,
  buildSummary,
  describeUsage,
  hitMessage,
  isSameSummary,
  localZone,
  nextClockTime,
  parseHits,
  parseLimit,
  parseTurns,
  pruneTurns,
  shareOf,
  statusLine,
  sumWindow,
  turnLine,
  warnMessage,
  withHit,
} from './meter'
import type { Window } from './meter'

type Engine = EngineInterface

const ALERTS = { plugin: 'usage-meter', key: 'alerts' } as const
const FRESH_ALERTS: UsageAlerts = { isWarned: false, toastedResets: [] }
const TOOL = 'mcp__usage-meter__usage_status'
const COMMAND = 'meter'
/** How often this session's turns file is rewritten without the lines older than the window. */
const PRUNE_EVERY_MS = HOUR_MS
/** How many reset times this session remembers having toasted. */
const KEPT_RESETS = 20
/** The API's limit error as its own row of the conversation reads, and nothing but it. */
const LIMIT_ROW = /^\s*You(?:'|’)ve hit your (?:session|usage) limit\b/i
const LIMIT_ROW_MAX = 240

const DEFAULTS: UsageSettings = { windowHours: 5, refreshSeconds: 30, warnAt: 80 }

const TOOL_DESCRIPTION =
  "The plan's rolling five-hour usage across every Claude Code session on this Mac: effective tokens in the window, " +
  "the share of the limit used (the API's own reading when fresh, else the estimate against the last limit hit), when the window resets, " +
  'each session’s share and the limit hits seen. ' +
  'Check it before fanning out subagents or starting optional work when the budget is tight; it reads the shared files and makes no model call.'

const COMMAND_DESCRIPTION =
  "The plan's five-hour usage across every session: effective tokens, the share of the limit, the reset, each session's share, the limit hits, the weights"

type Paths = { turns: string; hits: string; summary: string }

/**
 * One activation's memory, made in `register` and handed to every function
 * beside `$`: a reload starts it over, while the files and `$.state` carry on.
 */
type Memory = {
  settings: UsageSettings
  windowMs: number
  refreshMs: number
  /** The zone this process runs in, for the clock times shown. */
  zone: string | null
  /** Where the files are; undefined until HOME is read, null when it is unset. */
  paths: Paths | null | undefined
  sessionId: string | null
  /** This session's turns as its file holds them; null until read back. */
  own: TurnLine[] | null
  prunedAt: number
  ticker: { cancel: () => void } | null
  shownStatus: string | undefined
  lastSummary: Summary | null
  /** Serializes the writes of this session's file: subagents end turns side by side. */
  writing: Promise<void>
  refreshing: Promise<void> | null
}

/** A number option: finite and at least `least`, else the default. */
const numberOption = (value: unknown, fallback: number, least: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= least ? value : fallback

/** One turn's line as the API counted it, a subagent's flagged. */
const turnOf = (usage: TurnUsage, isSub: boolean, now: number): TurnLine => ({
  ts: now,
  in: usage.input_tokens,
  cr: usage.cache_read_input_tokens,
  cw: usage.cache_creation_input_tokens,
  out: usage.output_tokens,
  sub: isSub,
})

/** One reading of the window: what the status line, the summary and the warning are drawn from. */
type Figures = { summary: Summary; window: Window; now: number }

async function debug($: Engine, line: string) {
  try {
    await $.ui.log(`usage-meter: ${line}`, { to: 'debug' })
  } catch {
    // The debug log is best effort.
  }
}

async function where($: Engine, m: Memory): Promise<Paths | null> {
  if (m.paths === undefined) {
    const home = await $.env.get('HOME')
    if (home) {
      const dir = `${home}/.claude/usage-meter`
      m.paths = { turns: `${dir}/turns`, hits: `${dir}/hits.json`, summary: `${dir}/summary.json` }
    } else {
      m.paths = null
      await debug($, 'HOME is not set: nothing is counted')
    }
  }
  return m.paths
}

async function whoAmI($: Engine, m: Memory): Promise<string> {
  m.sessionId ??= await $.session.id().catch(() => `session-${Math.random().toString(36).slice(2, 10)}`)
  return m.sessionId
}

const readText = ($: Engine, path: string): Promise<string | null> => $.fs.read(path).catch(() => null)

/** Every session's turns inside the window: a file idle for longer than the window holds none and is not read. */
async function readWindow($: Engine, m: Memory, p: Paths, now: number): Promise<Window> {
  const entries = await $.fs.list(p.turns).catch(() => [])
  const since = now - m.windowMs
  const files = await Promise.all(
    entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') && (entry.mtimeMs === 0 || entry.mtimeMs > since))
      .map(async entry => ({ id: entry.name.slice(0, -'.jsonl'.length), turns: parseTurns((await readText($, `${p.turns}/${entry.name}`)) ?? '') })),
  )
  return sumWindow(files, now, m.windowMs)
}

const readHits = async ($: Engine, p: Paths): Promise<Hit[]> => parseHits(await readText($, p.hits))

function showStatus($: Engine, m: Memory, line: string | undefined) {
  if (line !== m.shownStatus) {
    m.shownStatus = line
    $.ui.status(line)
  }
}

async function alerts($: Engine): Promise<UsageAlerts> {
  const { value } = await $.state.get(ALERTS)
  return value ?? FRESH_ALERTS
}

/** One toast when the share first crosses the threshold; armed again once it is back below. */
async function warn($: Engine, m: Memory, { summary, window, now }: Figures) {
  const share = shareOf(summary, window.api, now)
  if (share === null) {
    return
  }
  const known = await alerts($)
  if (share.pct >= m.settings.warnAt) {
    if (!known.isWarned) {
      await $.state.set(ALERTS, { ...known, isWarned: true })
      $.ui.toast(warnMessage(share, summary, window.api, now, m.windowMs, m.zone), { timeoutMs: 12_000 })
    }
  } else if (known.isWarned) {
    await $.state.set(ALERTS, { ...known, isWarned: false })
  }
}

/** Sums the window again: summary.json when the figures changed, the status line, the warning. */
async function doRefresh($: Engine, m: Memory) {
  const p = await where($, m)
  if (p === null) {
    return
  }
  const now = await $.clock.now()
  const window = await readWindow($, m, p, now)
  const hits = await readHits($, p)
  const summary = buildSummary(window, hits, now, m.windowMs)
  if (!isSameSummary(m.lastSummary, summary)) {
    m.lastSummary = summary
    await $.fs.write(p.summary, `${JSON.stringify(summary)}\n`)
  }
  showStatus($, m, statusLine(summary, window.api, now, m.windowMs, m.zone))
  await warn($, m, { summary, window, now })
}

/** One refresh at a time: a caller while one runs gets that one. */
function refresh($: Engine, m: Memory): Promise<void> {
  m.refreshing ??= doRefresh($, m)
    .catch(error => debug($, `could not sum the window: ${String(error)}`))
    .finally(() => {
      m.refreshing = null
    })
  return m.refreshing
}

function ensureTicker($: Engine, m: Memory) {
  if (m.paths && !m.ticker) {
    m.ticker = $.clock.every(m.refreshMs, () => void refresh($, m))
  }
}

function stopTicker(m: Memory) {
  m.ticker?.cancel()
  m.ticker = null
}

/** The API's reading of its own five-hour window, when the last response carried one. */
async function apiReading($: Engine): Promise<{ u: number; r?: number } | null> {
  try {
    const usage = await $.session.usage()
    const five = usage.rateLimits.find(limit => limit.kind === 'five_hour')
    if (!five || !Number.isFinite(five.percentUsed)) {
      return null
    }
    const resetsAt = five.resetsAt === undefined ? NaN : Date.parse(five.resetsAt)
    return Number.isFinite(resetsAt) ? { u: five.percentUsed, r: resetsAt } : { u: five.percentUsed }
  } catch {
    return null
  }
}

/** Adds one turn to this session's file: read back once after a load, written whole, pruned about hourly. */
async function record($: Engine, m: Memory, turn: TurnLine) {
  const p = await where($, m)
  if (p === null) {
    return
  }
  const api = await apiReading($)
  if (api !== null) {
    turn.u = api.u
    if (api.r !== undefined) {
      turn.r = api.r
    }
  }
  const job = m.writing.then(async () => {
    const path = `${p.turns}/${await whoAmI($, m)}.jsonl`
    const loaded = m.own ?? parseTurns((await readText($, path)) ?? '')
    loaded.push(turn)
    const isPruneDue = turn.ts - m.prunedAt >= PRUNE_EVERY_MS
    const kept = isPruneDue ? pruneTurns(loaded, turn.ts - m.windowMs) : loaded
    if (isPruneDue) {
      m.prunedAt = turn.ts
    }
    m.own = kept
    await $.fs.write(path, `${kept.map(turnLine).join('\n')}\n`)
  })
  m.writing = job.catch(() => undefined)
  await job
}

/** A session-limit error: one hit per reset time, counted machine-wide once, told to this session once. */
async function onLimit($: Engine, m: Memory, text: string, now: number) {
  const parsed = parseLimit(text)
  if (parsed === null) {
    return
  }
  const p = await where($, m)
  if (p === null) {
    return
  }
  const resetAt = nextClockTime(now, parsed.hour, parsed.minute, parsed.zone)
  const known = await alerts($)
  if (known.toastedResets.includes(resetAt)) {
    return
  }
  // The hit is this window's warning: no warn toast beside it.
  await $.state.set(ALERTS, { isWarned: true, toastedResets: [...known.toastedResets, resetAt].slice(-KEPT_RESETS) })
  const window = await readWindow($, m, p, now)
  const hit: Hit = { at: now, resetAt, effectiveAtHit: window.effective, zone: parsed.zone }
  const { hits, isNew } = withHit(await readHits($, p), hit, KEPT_HITS)
  if (isNew) {
    await $.fs.write(p.hits, `${JSON.stringify(hits)}\n`)
  }
  $.ui.toast(hitMessage(resetAt, window.effective, m.windowMs, parsed.zone ?? m.zone), { timeoutMs: 15_000 })
  await refresh($, m)
}

/** What /meter and the usage_status tool print. */
async function describe($: Engine, m: Memory): Promise<string> {
  const p = await where($, m)
  if (p === null) {
    return 'usage-meter: HOME is not set, so there is nowhere to keep the turns.'
  }
  const now = await $.clock.now()
  const window = await readWindow($, m, p, now)
  const hits = await readHits($, p)
  return describeUsage(window, buildSummary(window, hits, now, m.windowMs), hits, m.settings, now, await whoAmI($, m), m.zone)
}

export const register: Register = (on, options) => {
  const settings: UsageSettings = {
    windowHours: numberOption(options.windowHours, DEFAULTS.windowHours, 0.1),
    refreshSeconds: numberOption(options.refreshSeconds, DEFAULTS.refreshSeconds, 5),
    warnAt: numberOption(options.warnAt, DEFAULTS.warnAt, 1),
  }
  const m: Memory = {
    settings,
    windowMs: Math.round(settings.windowHours * HOUR_MS),
    refreshMs: Math.round(settings.refreshSeconds * 1000),
    zone: localZone(),
    paths: undefined,
    sessionId: null,
    own: null,
    prunedAt: -Infinity,
    ticker: null,
    shownStatus: undefined,
    lastSummary: null,
    writing: Promise.resolve(),
    refreshing: null,
  }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: COMMAND, description: COMMAND_DESCRIPTION, immediate: true })
      .catch(error => debug($, `the /${COMMAND} command did not register: ${String(error)}`))
    await $.tool
      .register({ name: 'usage_status', description: TOOL_DESCRIPTION, inputSchema: { type: 'object', properties: {} }, isDeferred: false })
      .catch(error => debug($, `the usage_status tool did not register: ${String(error)}`))
    await refresh($, m)
    ensureTicker($, m)
    return next(e)
  })

  // Every turn's cost, a subagent's too; a turn that died on the limit is a hit.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      const now = await $.clock.now()
      if (e.usage !== undefined) {
        await record($, m, turnOf(e.usage, e.agentId !== undefined, now))
      }
      if (e.reason === 'error') {
        await onLimit($, m, e.answer, now)
      }
      ensureTicker($, m)
      await refresh($, m)
    } catch (error) {
      await debug($, `could not count the turn: ${String(error)}`)
    }
    return done
  })

  // The API's limit error is stored as an assistant row holding nothing but its message.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    try {
      const block = e.message.content[0]
      const text = e.message.type === 'assistant' && e.message.content.length === 1 && block?.type === 'text' ? block.text : undefined
      if (typeof text === 'string' && text.length <= LIMIT_ROW_MAX && LIMIT_ROW.test(text)) {
        await onLimit($, m, text, await $.clock.now())
      }
    } catch (error) {
      await debug($, `could not read the row: ${String(error)}`)
    }
    return kept
  })

  // The same error as the classic hook classifies it.
  on('classic.StopFailure', async ($, e, next) => {
    try {
      if (e.error === 'rate_limit') {
        await onLimit($, m, e.error_details ?? e.last_assistant_message ?? '', await $.clock.now())
      }
    } catch (error) {
      await debug($, `could not read the failure: ${String(error)}`)
    }
    return next(e)
  })

  on('tool.check', { tool: TOOL }, async ($, e, next) => {
    const verdict = await next(e)
    // The tool only reads the shared files: it never needs to ask, though a deny in settings stands.
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'usage-meter: reads the shared usage files' }
  })

  on('tool.call', { tool: TOOL }, async $ => ({ result: await describe($, m) }))

  on('command.run', { command: COMMAND }, async $ => ({ text: await describe($, m) }))

  on('session.end', async ($, e, next) => {
    stopTicker(m)
    showStatus($, m, undefined)
    // A /clear goes on in this process as another conversation: its id and its file are read afresh.
    m.sessionId = null
    m.own = null
    m.prunedAt = -Infinity
    m.lastSummary = null
    return next(e)
  })
}
