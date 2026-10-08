import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CountsLine, EventLine, MonitorBackup, SeenVia, SlowStat, TokenUsage } from '../types'
import { aggregate, failuresText, paneView, reportText } from './aggregate'
import type { PaneView, RowMark, SessionFile } from './aggregate'
import {
  dayOf,
  daysBetween,
  expiredDays,
  isDayName,
  monitorRoot,
  parseLines,
  rangeOf,
  serialize,
  sessionFileName,
  sessionPath,
  startOfDay,
  trimEntries,
} from './log'
import type { Entry } from './log'
import { basename, commandKey, dirCategory, firstLine, homeRelative, keep } from './mask'
import { deepestRejected, didRun, failureOf, isWatched, p95, roundMs, sample } from './trace'
import type { Failure, Link, Reservoir } from './trace'

type Engine = EngineInterface

const SELF = 'mod-monitor'
const PANE = 'mods'
const TITLE = 'Mods'
/** Drawing a pane or the band is slow from here (or from `slowMs` when that is lower). */
const RENDER_SLOW_MS = 250
/** A process that runs longer than this is logged as slow. */
const PROC_SLOW_MS = 20_000
/** This many process failures of one mod within the window is one toast. */
const PROC_BURST = 5
const PROC_WINDOW_MS = 10 * 60_000
/** Repeats of one thing (a toast, a failure, a status change) within this long fold into one line. */
const FOLD_MS = 60_000
/** Event lines one mod may add between two writes; past it, things are only counted. */
const LINES_PER_WINDOW = 200
/** How often an open pane is drawn again while its figures change. */
const LIVE_MS = 2_000
const HELP = [
  '/mods — the Mods pane: each mod, its health, what it did today; Details per mod',
  '/mods report [24h|7d|30d] — what each mod did over the range (default 7d); also written to ~/.claude/mods/monitor/report-latest.md',
  '/mods failures [24h|7d|30d] — only hook failures and process errors (default 7d)',
  '/mods help — this list',
].join('\n')

const tick = atom({ plugin: 'mod-monitor', key: 'tick' } as const, 0)
const expanded = atom({ plugin: 'mod-monitor', key: 'expanded' } as const, [])
const EMPTY_BACKUP: MonitorBackup = {
  sessionId: null,
  mods: [],
  commands: [],
  tools: [],
  alerted: [],
  procAlerted: [],
  failures: [],
  statuses: [],
  noted: [],
}
const backup = atom({ plugin: 'mod-monitor', key: 'backup' } as const, EMPTY_BACKUP)

type Config = {
  alerts: boolean
  slowMs: number
  renderSlowMs: number
  watchRender: boolean
  watchCommands: boolean
  retentionDays: number
  flushMs: number
}

/** A mod seen this session: how, and whether it ever ran beneath the monitor. */
type Mod = { name: string; via: Set<SeenVia>; covered: boolean; tier?: string; version?: string; provenance?: string }

/** What a mod did since the last write. */
type Delta = {
  runs: Record<string, number>
  procs: number
  procFails: number
  writes: number
  toasts: number
  models: number
  fails: number
  cmds: number
  tools: number
  slow: Record<string, { n: number; max: number }>
}

const DEFAULTS: Config = {
  alerts: true,
  slowMs: 1500,
  renderSlowMs: RENDER_SLOW_MS,
  watchRender: true,
  watchCommands: true,
  retentionDays: 30,
  flushMs: 60_000,
}

let config: Config = DEFAULTS
let home: string | null = null
let sessionId: string | null = null
/** `$.clock.now()` less `Date.now()`, so a hot path reads the time without a call on `$`. */
let clockOffset = 0
let expected: string[] = []
let mods = new Map<string, Mod>()
let commandOwner = new Map<string, string>()
let toolOwner = new Map<string, string>()
let deltas = new Map<string, Delta>()
let reservoirs = new Map<string, Reservoir>()
let alerted = new Set<string>()
let procAlerted = new Set<string>()
let failureCounts = new Map<string, number>()
let procFailTimes = new Map<string, number[]>()
let statuses = new Map<string, string>()
/** Things logged once per session: a mod's write folders and registrations. */
let noted = new Set<string>()
/** The line a repeat folds into, by what it is, while its minute lasts. */
let folding = new Map<string, { entry: Entry; until: number }>()
let windowLines = new Map<string, number>()
/** The day this session's buffer belongs to, and the buffer: every line of its file. */
let day: string | null = null
let entries: Entry[] = []
let isDirty = false
/** Today's lines of the other sessions, read when the pane opens and as it stays open. */
let others: SessionFile[] = []
let othersDay: string | null = null
let isPaneOpen = false
let hasChanged = false
let starting: Promise<void> | null = null
let flushTimer: { cancel: () => void } | null = null
let liveTimer: { cancel: () => void } | null = null
let writing: Promise<void> = Promise.resolve()
/** The session a /clear ended: its id is never written to again. */
let endedSession: string | null = null

const now = () => Date.now() + clockOffset

function safely(work: () => void): void {
  try {
    work()
  } catch {
    // The monitor never changes what it watches, its own trouble included.
  }
}

async function debug($: Engine, line: string) {
  try {
    await $.ui.log(`mod-monitor: ${line}`, { to: 'debug' })
  } catch {
    // The debug log is best effort.
  }
}

function toast($: Engine, text: string) {
  try {
    $.ui.toast(text, { timeoutMs: 8_000 })
  } catch {
    // A toast that cannot show is no reason to fail the hook that raised it.
  }
}

async function syncClock($: Engine) {
  try {
    clockOffset = (await $.clock.now()) - Date.now()
  } catch {
    // Keep the last offset.
  }
}

// ---------------------------------------------------------------------------
// Recording: synchronous, in memory, never a call on `$` but an alert's toast.

function deltaOf(plugin: string): Delta {
  let delta = deltas.get(plugin)
  if (!delta) {
    delta = { runs: {}, procs: 0, procFails: 0, writes: 0, toasts: 0, models: 0, fails: 0, cmds: 0, tools: 0, slow: {} }
    deltas.set(plugin, delta)
  }
  hasChanged = true
  return delta
}

function reservoirOf(plugin: string, event: string): Reservoir {
  const key = `${plugin}\u0000${event}`
  let reservoir = reservoirs.get(key)
  if (!reservoir) {
    reservoir = { seen: 0, values: [] }
    reservoirs.set(key, reservoir)
  }
  return reservoir
}

function push(line: EventLine | CountsLine): Entry {
  const entry: Entry = { line, json: null }
  entries.push(entry)
  isDirty = true
  hasChanged = true
  return entry
}

/**
 * Adds an event line, or folds it into the open line of the same `foldKey`
 * (its `n` and `last` grow, `merge` takes what the newer one says).
 */
function logEvent(line: EventLine, foldKey?: string, merge?: (open: EventLine, newer: EventLine) => void) {
  if (foldKey) {
    const open = folding.get(foldKey)
    if (open && open.until >= line.ts) {
      const held = open.entry.line as EventLine
      held.n = (held.n ?? 1) + 1
      held.last = line.ts
      merge?.(held, line)
      open.entry.json = null
      isDirty = true
      hasChanged = true
      return
    }
  }
  if (line.kind !== 'seen') {
    const count = windowLines.get(line.plugin) ?? 0
    if (count >= LINES_PER_WINDOW) {
      return
    }
    windowLines.set(line.plugin, count + 1)
  }
  const entry = push(line)
  if (foldKey) {
    folding.set(foldKey, { entry, until: line.ts + FOLD_MS })
  }
}

function seenLine(mod: Mod, via: SeenVia, at: number): EventLine {
  return {
    t: 'event',
    ts: at,
    plugin: mod.name,
    kind: 'seen',
    via,
    ...(mod.tier ? { tier: mod.tier } : {}),
    ...(mod.version ? { version: keep(mod.version, 40) } : {}),
    ...(mod.provenance ? { provenance: keep(mod.provenance, 120) } : {}),
  }
}

type Admission = { tier?: string; version?: string; provenance?: string }

/** Marks a mod loaded; the first sign of it this session is logged. */
function noteSeen(plugin: string, via: SeenVia, at: number, admission?: Admission): Mod {
  let mod = mods.get(plugin)
  if (!mod) {
    mod = { name: plugin, via: new Set(), covered: false, ...admission }
    mods.set(plugin, mod)
    mod.via.add(via)
    logEvent(seenLine(mod, via, at))
    return mod
  }
  if (admission) {
    Object.assign(mod, admission)
  }
  mod.via.add(via)
  return mod
}

function recordFailure($: Engine, plugin: string, event: string, failure: Failure, ms: number, reason: string | undefined, at: number) {
  deltaOf(plugin).fails += 1
  const count = (failureCounts.get(plugin) ?? 0) + 1
  failureCounts.set(plugin, count)
  logEvent(
    {
      t: 'event',
      ts: at,
      plugin,
      kind: 'failure',
      event,
      outcome: failure.outcome,
      ms: roundMs(ms),
      what: failure.what,
      ...(reason ? { reason: keep(reason, 160) } : {}),
    },
    `failure|${plugin}|${event}|${failure.outcome}`,
    (open, newer) => {
      if (open.kind === 'failure' && newer.kind === 'failure') {
        open.ms = Math.max(open.ms, newer.ms)
        if (newer.reason) {
          open.reason = newer.reason
        }
      }
    },
  )
  if (config.alerts && !alerted.has(plugin)) {
    alerted.add(plugin)
    toast($, `mod-monitor: ${plugin}'s ${event} hook ${failure.what} (${count}×) — /mods for details`)
  }
}

function recordSlow(plugin: string, event: string, ms: number, at: number) {
  const stat = (deltaOf(plugin).slow[event] ??= { n: 0, max: 0 })
  stat.n += 1
  stat.max = Math.max(stat.max, ms)
  logEvent({ t: 'event', ts: at, plugin, kind: 'slow', event, ms: roundMs(ms) }, `slow|${plugin}|${event}`, (open, newer) => {
    if (open.kind === 'slow' && newer.kind === 'slow') {
      open.ms = Math.max(open.ms, newer.ms)
    }
  })
}

/** The dispatch a trace belongs to: its event, whether it was a drawing, and when it settled. */
type Dispatch = { event: string; isRender: boolean; at: number }

/** One link beneath the monitor: the mod is loaded and covered; its run, its time and its failure are noted. */
function recordLink($: Engine, link: Link, isDeepestRejected: boolean, { event, isRender, at }: Dispatch) {
  const mod = noteSeen(link.plugin, 'trace', at)
  mod.covered = true
  if (!didRun(link)) {
    return
  }
  const ms = Number.isFinite(link.ms) ? link.ms : 0
  const isSlow = ms > (isRender ? config.renderSlowMs : config.slowMs)
  if (!isRender) {
    const delta = deltaOf(link.plugin)
    delta.runs[event] = (delta.runs[event] ?? 0) + 1
  }
  // Drawing keeps only its slow times; every other event, all of them.
  if (!isRender || isSlow) {
    sample(reservoirOf(link.plugin, event), ms)
  }
  if (isSlow) {
    recordSlow(link.plugin, event, ms, at)
  }
  const failure = failureOf(link, isDeepestRejected)
  if (failure) {
    recordFailure($, link.plugin, event, failure, ms, link.reason, at)
  }
}

/**
 * What one dispatch's trace says about the mods beneath the monitor: each
 * one's run (drawing is never counted), its time, and its failure.
 */
function recordTrace($: Engine, event: string, trace: readonly Link[], isRender: boolean) {
  if (trace.length === 0) {
    return
  }
  const dispatch: Dispatch = { event, isRender, at: now() }
  const deepest = deepestRejected(trace)
  trace.forEach((link, i) => {
    if (isWatched(link, SELF)) {
      recordLink($, link, i === deepest, dispatch)
    }
  })
}

/**
 * Runs the chain beneath (`run`, the hook's own `next(e)`), reads what its
 * trace says, and answers exactly what the chain answered: a result as it
 * came, a rejection as it came.
 */
async function watch<R>(
  $: Engine,
  event: string,
  next: { readonly trace: readonly Link[] },
  run: () => Promise<R>,
  isRender = false,
  after?: () => void,
): Promise<R> {
  let result: R
  try {
    result = await run()
  } catch (error) {
    safely(() => recordTrace($, event, next.trace, isRender))
    if (after) {
      safely(after)
    }
    throw error
  }
  safely(() => recordTrace($, event, next.trace, isRender))
  if (after) {
    safely(after)
  }
  return result
}

/** Times a `$` call another plugin made and hands its outcome to `record`, then answers exactly what came back. */
async function observe<R>(run: () => Promise<R>, record: (result: R | undefined, error: unknown, ms: number) => void): Promise<R> {
  const started = Date.now()
  let result: R
  try {
    result = await run()
  } catch (error) {
    safely(() => record(undefined, error, Date.now() - started))
    throw error
  }
  safely(() => record(result, undefined, Date.now() - started))
  return result
}

/** The plugin behind a `$` call, when it is one the monitor reports on; marks it loaded. */
function callerOf(origin: { readonly plugin: string; readonly tier: string }): string | null {
  if (!isWatched(origin, SELF) || origin.plugin === 'client') {
    return null
  }
  noteSeen(origin.plugin, 'origin', now())
  return origin.plugin
}

function onToast(plugin: string, text: string) {
  deltaOf(plugin).toasts += 1
  const shown = keep(text, 160)
  logEvent({ t: 'event', ts: now(), plugin, kind: 'toast', text: shown }, `toast|${plugin}|${shown}`)
}

function onStatus(plugin: string, text: string | undefined) {
  const shown = text === undefined ? '' : keep(text, 120)
  if (statuses.get(plugin) === shown) {
    return
  }
  statuses.set(plugin, shown)
  hasChanged = true
  logEvent({ t: 'event', ts: now(), plugin, kind: 'status', text: shown }, `status|${plugin}`, (open, newer) => {
    if (open.kind === 'status' && newer.kind === 'status') {
      open.text = newer.text
    }
  })
}

/** Why a process failure is expected and not worth counting, or null: git probing a folder that is no repository. */
export function expectedFailure(text: string): string | null {
  return /not a git repository/i.test(text) ? 'not in a git repository' : null
}

type ProcOutcome = { value?: { exitCode: number; stderr: string }; deny?: string } | undefined

function onProcess($: Engine, plugin: string, argv: readonly string[], outcome: ProcOutcome, error: unknown, ms: number) {
  const delta = deltaOf(plugin)
  delta.procs += 1
  const at = now()
  const cmd = commandKey(argv)
  if (ms > PROC_SLOW_MS) {
    logEvent({ t: 'event', ts: at, plugin, kind: 'proc-slow', cmd, ms: Math.round(ms) })
  }
  const exit = outcome?.value ? outcome.value.exitCode : null
  if (exit === 0) {
    return
  }
  const why = outcome?.deny ?? (error !== undefined ? String(error) : (outcome?.value?.stderr ?? ''))
  const expected = expectedFailure(why)
  if (expected) {
    // A probe that fails by design (git asked about a folder that is no repository): logged, never counted.
    logEvent({ t: 'event', ts: at, plugin, kind: 'proc-expected', cmd, exit, why: expected }, `procx|${plugin}|${cmd}|${expected}`)
    return
  }
  delta.procFails += 1
  const err = keep(firstLine(why), 160)
  logEvent(
    { t: 'event', ts: at, plugin, kind: 'proc-fail', cmd, exit, ms: Math.round(ms), ...(err ? { err } : {}) },
    `proc|${plugin}|${cmd}|${exit}`,
    (open, newer) => {
      if (open.kind === 'proc-fail' && newer.kind === 'proc-fail' && newer.err) {
        open.err = newer.err
      }
    },
  )
  const times = (procFailTimes.get(plugin) ?? []).filter(time => at - time < PROC_WINDOW_MS)
  times.push(at)
  procFailTimes.set(plugin, times.slice(-50))
  if (times.length >= PROC_BURST && config.alerts && !procAlerted.has(plugin)) {
    procAlerted.add(plugin)
    const last = exit === null ? cmd : `${cmd}, exit ${exit}`
    toast($, `mod-monitor: ${plugin}'s processes failed ${times.length}× in 10 min (last: ${last}) — /mods for details`)
  }
}

type ModelOutcome =
  | {
      value?:
        | { isAnswered: true; usage: ModelUsageLike }
        | { isAnswered: false; reason: string; status?: number | null; error?: string; usage?: ModelUsageLike }
      deny?: string
    }
  | undefined

type ModelUsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function onModel(plugin: string, model: string, outcome: ModelOutcome, error: unknown, ms: number) {
  deltaOf(plugin).models += 1
  const value = outcome?.value
  let said: string
  if (outcome?.deny !== undefined) {
    said = 'refused'
  } else if (error !== undefined || !value) {
    said = 'failed'
  } else if (value.isAnswered) {
    said = 'answered'
  } else {
    said = [value.reason, value.status ?? '', value.error ?? ''].filter(part => part !== '').join(' ')
  }
  const raw = value?.usage
  const usage: TokenUsage | undefined = raw
    ? {
        in: raw.input_tokens || 0,
        out: raw.output_tokens || 0,
        cacheRead: raw.cache_read_input_tokens || 0,
        cacheWrite: raw.cache_creation_input_tokens || 0,
      }
    : undefined
  logEvent({
    t: 'event',
    ts: now(),
    plugin,
    kind: 'model',
    model: keep(model, 60),
    outcome: keep(said, 60),
    ms: Math.round(ms),
    ...(usage ? { usage } : {}),
  })
}

function onWrite(plugin: string, path: string) {
  deltaOf(plugin).writes += 1
  const dir = dirCategory(path, home)
  const key = `write|${plugin}|${dir}`
  if (!noted.has(key)) {
    noted.add(key)
    logEvent({ t: 'event', ts: now(), plugin, kind: 'write', dir })
  }
}

function onRegister(plugin: string, what: 'command' | 'tool', name: string, full: string | undefined) {
  noteSeen(plugin, what === 'command' ? 'command.register' : 'tool.register', now())
  if (what === 'command') {
    commandOwner.set(name, plugin)
  } else {
    toolOwner.set(full ?? `mcp__${plugin}__${name}`, plugin)
    toolOwner.set(`mcp__${plugin}__${name}`, plugin)
  }
  const key = `register|${plugin}|${what}|${name}`
  if (!noted.has(key)) {
    noted.add(key)
    logEvent({ t: 'event', ts: now(), plugin, kind: 'register', what, name: keep(name, 64) })
  }
}

/** A slash command's run, credited to the mod it belongs to: its registrar, else the link that answered it. */
function onCommand(command: string, args: string, by: string, trace: readonly Link[]) {
  let owner = commandOwner.get(command)
  const last = trace[trace.length - 1]
  if (!owner && last && isWatched(last, SELF) && last.outcome === 'returned') {
    owner = last.plugin
  }
  if (!owner || owner === SELF) {
    return
  }
  deltaOf(owner).cmds += 1
  logEvent({ t: 'event', ts: now(), plugin: owner, kind: 'command', command: keep(command, 64), hasArgs: args.trim() !== '', by })
}

/** A call of a tool a mod registered (`mcp__<mod>__<name>`). */
function onToolCall(tool: string) {
  let owner = toolOwner.get(tool)
  if (!owner) {
    const match = /^mcp__(.+?)__/.exec(tool)
    owner = match?.[1] && mods.has(match[1]) ? match[1] : undefined
  }
  if (owner && owner !== SELF) {
    deltaOf(owner).tools += 1
  }
}

// ---------------------------------------------------------------------------
// The day file: written whole from memory, every `flushSeconds` and at the end.

function isEmpty(delta: Delta): boolean {
  return (
    Object.keys(delta.runs).length === 0 &&
    Object.keys(delta.slow).length === 0 &&
    delta.procs + delta.procFails + delta.writes + delta.toasts + delta.models + delta.fails + delta.cmds + delta.tools === 0
  )
}

function countsLine(plugin: string, delta: Delta, at: number): CountsLine {
  const slow: Record<string, SlowStat> = {}
  for (const [event, stat] of Object.entries(delta.slow)) {
    slow[event] = { n: stat.n, max: roundMs(stat.max), p95: roundMs(p95(reservoirOf(plugin, event).values)) }
  }
  return {
    t: 'counts',
    ts: at,
    plugin,
    runs: { ...delta.runs },
    procs: delta.procs,
    procFails: delta.procFails,
    writes: delta.writes,
    toasts: delta.toasts,
    models: delta.models,
    slow,
    fails: delta.fails,
    cmds: delta.cmds,
    tools: delta.tools,
  }
}

/** The counts since the last write, as the lines the next write will add (the pane reads them live). */
function pendingCounts(at: number): CountsLine[] {
  return [...deltas.entries()].filter(([, delta]) => !isEmpty(delta)).map(([plugin, delta]) => countsLine(plugin, delta, at))
}

function emitCounts(at: number) {
  for (const line of pendingCounts(at)) {
    push(line)
  }
  deltas = new Map()
}

/** Starts this session's file over (a new day, or a new session after /clear): every loaded mod is seen in it again. */
function startBuffer(at: number) {
  entries = []
  folding = new Map()
  windowLines = new Map()
  isDirty = false
  for (const mod of mods.values()) {
    push(seenLine(mod, [...mod.via][0] ?? 'origin', at))
  }
}

/** Keeps the buffer under the file limit, written or not; a line trimmed away takes no more repeats. */
function trimBuffer() {
  const kept = trimEntries(entries)
  if (kept.length !== entries.length) {
    const still = new Set(kept)
    for (const [key, open] of folding) {
      if (!still.has(open.entry)) {
        folding.delete(key)
      }
    }
  }
  entries = kept
}

async function writeFile($: Engine, which: string) {
  trimBuffer()
  if (!home || !sessionId || !isDirty) {
    return
  }
  const text = serialize(entries)
  isDirty = false
  try {
    await $.fs.write(sessionPath(home, which, sessionId), text)
  } catch (error) {
    isDirty = true
    await debug($, `could not write the log: ${String(error)}`)
  }
}

function backupOf(): MonitorBackup {
  return {
    sessionId,
    mods: [...mods.values()].map(mod => ({
      name: mod.name,
      via: [...mod.via],
      covered: mod.covered,
      ...(mod.tier ? { tier: mod.tier } : {}),
      ...(mod.version ? { version: mod.version } : {}),
      ...(mod.provenance ? { provenance: mod.provenance } : {}),
    })),
    commands: [...commandOwner.entries()],
    tools: [...toolOwner.entries()],
    alerted: [...alerted],
    procAlerted: [...procAlerted],
    failures: [...failureCounts.entries()],
    statuses: [...statuses.entries()],
    noted: [...noted],
  }
}

function restoreFrom(saved: MonitorBackup) {
  for (const one of saved.mods) {
    const mod = mods.get(one.name) ?? { name: one.name, via: new Set<SeenVia>(), covered: false }
    for (const via of one.via) {
      mod.via.add(via)
    }
    mod.covered ||= one.covered
    mod.tier ??= one.tier
    mod.version ??= one.version
    mod.provenance ??= one.provenance
    mods.set(one.name, mod)
  }
  for (const [name, plugin] of saved.commands) {
    if (!commandOwner.has(name)) {
      commandOwner.set(name, plugin)
    }
  }
  for (const [name, plugin] of saved.tools) {
    if (!toolOwner.has(name)) {
      toolOwner.set(name, plugin)
    }
  }
  saved.alerted.forEach(name => alerted.add(name))
  saved.procAlerted.forEach(name => procAlerted.add(name))
  for (const [name, count] of saved.failures) {
    failureCounts.set(name, Math.max(count, failureCounts.get(name) ?? 0))
  }
  for (const [name, text] of saved.statuses) {
    if (!statuses.has(name)) {
      statuses.set(name, text)
    }
  }
  saved.noted.forEach(key => noted.add(key))
}

async function flushNow($: Engine, isFinal: boolean) {
  await ensureStarted($)
  if (!isFinal) {
    await syncClock($)
  }
  const at = now()
  const today = dayOf(at)
  day ??= today
  emitCounts(at)
  if (!sessionId) {
    const id = await $.session.id().catch(() => null)
    // Right after a /clear the old id may still answer: its file is complete, never overwritten.
    sessionId = id && id !== endedSession ? id : null
  }
  if (today !== day) {
    await writeFile($, day)
    day = today
    startBuffer(at)
  }
  for (const [key, open] of folding) {
    if (open.until < at) {
      folding.delete(key)
    }
  }
  windowLines = new Map()
  await writeFile($, day)
  if (isFinal) {
    return
  }
  try {
    await update($, backup, () => backupOf())
  } catch (error) {
    await debug($, `could not keep the inventory: ${String(error)}`)
  }
  if (isPaneOpen) {
    await readOthers($, today)
    await bump($)
  }
}

/** Writes this session's file; flushes run one at a time. */
function flush($: Engine, isFinal = false): Promise<void> {
  const run = writing.then(() => flushNow($, isFinal))
  writing = run.catch(() => undefined)
  return run.catch(error => debug($, `flush failed: ${String(error)}`))
}

// ---------------------------------------------------------------------------
// Start: who is expected, what a reload left, and retention.

/** The mods the plugin folders name, by their manifests' names (the folder's name when it has none). */
async function loadExpected($: Engine): Promise<string[]> {
  const raw = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS').catch(() => undefined)) ?? ''
  const dirs = raw
    .split(':')
    .map(dir => dir.trim())
    .filter(Boolean)
    .map(dir => (home && (dir === '~' || dir.startsWith('~/')) ? `${home}${dir.slice(1)}` : dir).replace(/\/+$/, ''))
  const names = await Promise.all(
    dirs.map(async dir => {
      try {
        const manifest: unknown = JSON.parse(await $.fs.read(`${dir}/.claude-plugin/plugin.json`))
        const name = (manifest as { name?: unknown } | null)?.name
        return typeof name === 'string' && name ? name : basename(dir)
      } catch {
        return basename(dir)
      }
    }),
  )
  return names.filter((name, i) => name && name !== SELF && names.indexOf(name) === i)
}

/** Removes day folders past `retentionDays`, and only those: dated folders directly inside the monitor's folder. */
async function prune($: Engine) {
  if (!home || !home.startsWith('/')) {
    return
  }
  const root = monitorRoot(home)
  const listed = await $.fs.list(root).catch(() => [])
  const days = listed.filter(entry => entry.kind === 'dir' && !entry.isLink).map(entry => entry.name)
  for (const name of expiredDays(days, now(), config.retentionDays)) {
    const dir = `${root}/${name}`
    if (!isDayName(name) || !dir.startsWith(`${root}/`) || dir.includes('/../')) {
      continue
    }
    const out = await $.process.run(['/bin/rm', '-rf', '--', dir], { timeoutMs: 30_000 }).catch(() => null)
    if (!out || out.exitCode !== 0) {
      await debug($, `could not remove ${homeRelative(dir, home)}`)
    }
  }
}

async function readHome($: Engine) {
  home ??= (await $.env.get('HOME').catch(() => undefined)) || null
}

async function start($: Engine) {
  try {
    await readHome($)
    sessionId ??= await $.session.id().catch(() => null)
    const saved = await read($, backup).catch(() => EMPTY_BACKUP)
    if (saved.sessionId && saved.sessionId === sessionId) {
      restoreFrom(saved)
    }
    expected = await loadExpected($)
    if (home && sessionId) {
      day ??= dayOf(now())
      // A reload of the monitor: this session's file already holds its earlier lines.
      const before = await $.fs.read(sessionPath(home, day, sessionId)).catch(() => null)
      if (before) {
        entries = [...parseLines(before).map(line => ({ line, json: null })), ...entries]
      }
    }
    isPaneOpen ||= await $.ui
      .panes()
      .then(panes => panes.some(pane => pane.id === PANE))
      .catch(() => false)
    if (isPaneOpen) {
      startLive($)
    }
    void prune($)
  } catch (error) {
    await debug($, `could not start: ${String(error)}`)
  }
}

function ensureStarted($: Engine): Promise<void> {
  starting ??= start($)
  return starting
}

function ensureTimer($: Engine) {
  try {
    flushTimer ??= $.clock.every(config.flushMs, () => void flush($))
  } catch {
    // No timer: the log is still written at the end and by /mods report.
  }
}

/** A /clear: the old session's file is complete; the next lines go to the new session's. */
function newSession(ended: string, at: number) {
  endedSession = ended
  sessionId = null
  deltas = new Map()
  reservoirs = new Map()
  alerted = new Set()
  procAlerted = new Set()
  failureCounts = new Map()
  procFailTimes = new Map()
  statuses = new Map()
  noted = new Set()
  day = dayOf(at)
  startBuffer(at)
}

// ---------------------------------------------------------------------------
// The pane and the commands.

async function bump($: Engine) {
  hasChanged = false
  try {
    await update($, tick, n => n + 1)
  } catch {
    // Nothing reads it yet.
  }
}

function startLive($: Engine) {
  try {
    liveTimer ??= $.clock.every(LIVE_MS, () => {
      if (!isPaneOpen) {
        liveTimer?.cancel()
        liveTimer = null
      } else if (hasChanged) {
        void bump($)
      }
    })
  } catch {
    // The pane still redraws at each flush.
  }
}

/** One day's session files, every session's (this one's left out when asked). */
async function readDay($: Engine, which: string, skip?: string): Promise<SessionFile[]> {
  if (!home) {
    return []
  }
  const dir = `${monitorRoot(home)}/${which}`
  const listed = await $.fs.list(dir).catch(() => [])
  const files = listed.filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.name !== skip)
  const found = await Promise.all(
    files.map(async (entry): Promise<SessionFile | null> => {
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => null)
      return text === null ? null : { session: entry.name.replace(/\.jsonl$/, ''), day: which, lines: parseLines(text) }
    }),
  )
  return found.filter((file): file is SessionFile => file !== null)
}

async function readOthers($: Engine, today: string) {
  others = await readDay($, today, sessionId ? sessionFileName(sessionId) : undefined)
  othersDay = today
}

function procBursts(at: number): Set<string> {
  const bursting = new Set<string>()
  for (const [plugin, times] of procFailTimes) {
    if (times.filter(time => at - time < PROC_WINDOW_MS).length >= PROC_BURST) {
      bursting.add(plugin)
    }
  }
  return bursting
}

function loadedNames(): Set<string> {
  return new Set([...mods.keys()].filter(name => name !== SELF))
}

/** The pane's figures: today's other sessions as last read, and this session live. */
function currentView(): PaneView {
  const at = now()
  const today = dayOf(at)
  const own: SessionFile = {
    session: sessionId ? sessionFileName(sessionId).replace(/\.jsonl$/, '') : 'this',
    day: today,
    lines: [...entries.map(entry => entry.line), ...pendingCounts(at)],
  }
  const files = othersDay === today ? [...others, own] : [own]
  const loaded = loadedNames()
  const covered = new Set([...mods.values()].filter(mod => mod.covered).map(mod => mod.name))
  const folder = home ? `${homeRelative(monitorRoot(home), home)}/${today}/` : 'not written: HOME is not set'
  return paneView({
    now: at,
    expected,
    loaded,
    covered,
    procBursts: procBursts(at),
    today: aggregate(files, startOfDay(at)),
    folder,
  })
}

function summaryOf(view: PaneView): string {
  const lines = [view.header]
  for (const row of view.rows.filter(one => one.mark === '⚠')) {
    lines.push(`⚠ ${row.name}: ${row.last}`)
  }
  const missing = view.rows.filter(row => row.mark === '✗').map(row => row.name)
  if (missing.length > 0) {
    lines.push(`✗ not seen: ${missing.join(', ')} (not loaded, or silent so far)`)
  }
  lines.push(view.coverage)
  return lines.join('\n')
}

async function openPane($: Engine): Promise<string> {
  await ensureStarted($)
  await syncClock($)
  isPaneOpen = true
  await readOthers($, dayOf(now()))
  startLive($)
  const opened = await $.ui.open({ id: PANE, title: TITLE }).catch(() => null)
  await bump($)
  const text = summaryOf(currentView())
  return opened && !opened.isPlaced ? `${text}\n(The Mods pane is waiting for room: ${opened.reason}.)` : text
}

/** Every session's lines over a range, read from the day folders it touches. */
async function readRange($: Engine, since: number, at: number): Promise<SessionFile[]> {
  return (await Promise.all(daysBetween(since, at).map(which => readDay($, which)))).flat()
}

/** Keeps the latest report where a scheduled review (or Claude) can read it. */
async function writeLatest($: Engine, root: string, text: string): Promise<string> {
  const path = `${root}/report-latest.md`
  const shown = homeRelative(path, home)
  try {
    await $.fs.write(path, text)
    return `Written to ${shown}`
  } catch (error) {
    return `Could not write ${shown}: ${keep(String(error), 120)}`
  }
}

async function report($: Engine, arg: string | undefined, kind: 'report' | 'failures'): Promise<string> {
  const range = rangeOf(arg, '7d')
  if (!range) {
    return `mod-monitor: "${arg ?? ''}" is not a range; use 24h, 7d or 30d.`
  }
  await flush($)
  if (!home) {
    return 'mod-monitor: HOME is not set, so there are no logs to read.'
  }
  const at = now()
  const since = at - range.ms
  const files = await readRange($, since, at)
  const sessions = new Set(files.map(file => file.session)).size
  const input = { now: at, since, range: range.label, sessions, expected, mods: aggregate(files, since) }
  if (kind === 'failures') {
    return failuresText(input)
  }
  const text = reportText(input)
  return `${text}\n${await writeLatest($, monitorRoot(home), text)}`
}

async function runMods($: Engine, args: string): Promise<string> {
  const [sub = '', arg] = args.trim().split(/\s+/)
  switch (sub.toLowerCase()) {
    case '':
      return openPane($)
    case 'report':
      return report($, arg, 'report')
    case 'failures':
      return report($, arg, 'failures')
    case 'help':
      return HELP
    default:
      return `mod-monitor: no /mods ${sub}.\n${HELP}`
  }
}

const COLORS: Record<RowMark, string | undefined> = { '✓': 'green', '⚠': 'yellow', '✗': 'red', '·': undefined }

export const register: Register = (on, options) => {
  const slowMs = Math.max(1, Number(options.slowMs ?? DEFAULTS.slowMs) || DEFAULTS.slowMs)
  config = {
    alerts: options.alerts !== false,
    slowMs,
    renderSlowMs: Math.min(RENDER_SLOW_MS, slowMs),
    watchRender: options.watchRender !== false,
    watchCommands: options.watchCommands !== false,
    retentionDays: Math.max(1, Math.round(Number(options.retentionDays ?? DEFAULTS.retentionDays) || DEFAULTS.retentionDays)),
    flushMs: Math.min(3_600, Math.max(5, Number(options.flushSeconds ?? 60) || 60)) * 1000,
  }
  home = null
  sessionId = null
  clockOffset = 0
  expected = []
  mods = new Map()
  commandOwner = new Map()
  toolOwner = new Map()
  deltas = new Map()
  reservoirs = new Map()
  alerted = new Set()
  procAlerted = new Set()
  failureCounts = new Map()
  procFailTimes = new Map()
  statuses = new Map()
  noted = new Set()
  folding = new Map()
  windowLines = new Map()
  day = null
  entries = []
  isDirty = false
  others = []
  othersDay = null
  isPaneOpen = false
  hasChanged = false
  starting = null
  flushTimer = null
  liveTimer = null
  writing = Promise.resolve()
  endedSession = null

  // The dispatches, each by name (a glob would take turn.step's stream and per-keystroke events with it).
  // Registered first, so they stand above the monitor's own hooks on the same events.
  on('session.start', async ($, e, next) => {
    // The time and HOME first: the mods beneath may write while their session starts.
    await Promise.all([syncClock($), readHome($)])
    try {
      return await watch($, 'session.start', next, () => next(e))
    } finally {
      try {
        await $.command.register({
          name: 'mods',
          description: 'Your mods: health, failures, slow hooks and what each did today (report, failures, help)',
          argumentHint: '[report|failures [24h|7d|30d]|help]',
          immediate: true,
        })
      } catch (error) {
        await debug($, `could not register /mods: ${String(error)}`)
      }
      ensureTimer($)
      void ensureStarted($)
    }
  })

  on('session.end', async ($, e, next) => {
    // Written first: the exit's short bound is shared by every plugin's hook.
    if (next.budget.remainingMs > 500) {
      await flush($, true)
    }
    try {
      return await watch($, 'session.end', next, () => next(e))
    } finally {
      if (isDirty && next.budget.remainingMs > 200) {
        await flush($, true)
      }
      if (e.reason === 'clear') {
        safely(() => newSession(e.sessionId, now()))
      }
    }
  })

  on('prompt.submit', ($, e, next) => watch($, 'prompt.submit', next, () => next(e)))
  on('prompt.context', ($, e, next) => watch($, 'prompt.context', next, () => next(e)))
  if (config.watchCommands) {
    // Hooking every command also lists the monitor beside a mod's name on its command output.
    on('command.run', ($, e, next) =>
      watch($, 'command.run', next, () => next(e), false, () => onCommand(e.command, e.args, e.origin.kind, next.trace)),
    )
  }
  on('tool.call', ($, e, next) => watch($, 'tool.call', next, () => next(e), false, () => onToolCall(e.tool)))
  on('tool.check', ($, e, next) => watch($, 'tool.check', next, () => next(e)))
  on('turn.start', ($, e, next) => watch($, 'turn.start', next, () => next(e)))
  on('turn.complete', ($, e, next) => watch($, 'turn.complete', next, () => next(e)))
  on('session.compact', ($, e, next) => watch($, 'session.compact', next, () => next(e)))
  if (config.watchRender) {
    // Only the components mods draw; transcript rows are left alone.
    on('ui.render', { component: ['Pane', 'AbovePrompt'] }, ($, e, next) => watch($, 'ui.render', next, () => next(e), true))
  }

  // The `$` calls the mods make, by who made them. A toast, a status line and a write are
  // noted as they are raised (in the order they were made), and handed on untouched.
  on('ui.toast', ($, e, next) => {
    safely(() => {
      const plugin = callerOf(next.origin)
      if (plugin) {
        onToast(plugin, e.text)
      }
    })
    return next(e)
  })
  on('ui.status', ($, e, next) => {
    safely(() => {
      const plugin = callerOf(next.origin)
      if (plugin) {
        onStatus(plugin, e.text)
      }
    })
    return next(e)
  })
  on('process.run', ($, e, next) =>
    observe(
      () => next(e),
      (result, error, ms) => {
        const plugin = callerOf(next.origin)
        if (plugin) {
          onProcess($, plugin, e.argv, result, error, ms)
        }
      },
    ),
  )
  on('model.complete', ($, e, next) =>
    observe(
      () => next(e),
      (result, error, ms) => {
        const plugin = callerOf(next.origin)
        if (plugin) {
          onModel(plugin, e.model, result, error, ms)
        }
      },
    ),
  )
  on('fs.write', ($, e, next) => {
    safely(() => {
      const plugin = callerOf(next.origin)
      if (plugin) {
        onWrite(plugin, e.path)
      }
    })
    return next(e)
  })
  on('command.register', ($, e, next) =>
    observe(
      () => next(e),
      result => {
        const plugin = callerOf(next.origin)
        if (plugin && result?.value) {
          onRegister(plugin, 'command', e.name, result.value.command)
        }
      },
    ),
  )
  on('tool.register', ($, e, next) =>
    observe(
      () => next(e),
      result => {
        const plugin = callerOf(next.origin)
        if (plugin && result?.value) {
          onRegister(plugin, 'tool', e.name, result.value.tool)
        }
      },
    ),
  )

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    isPaneOpen = false
    others = []
    othersDay = null
    return result
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    try {
      return { text: await runMods($, e.args) }
    } catch (error) {
      return { text: `mod-monitor: ${keep(String(error), 200)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const open = await read($, expanded)
    let view: PaneView
    try {
      view = currentView()
    } catch (error) {
      return (
        <Box flexDirection="column">
          <Text color="red">mod-monitor could not draw its figures: {keep(String(error), 200)}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{view.header}</Text>
        {view.rows.length === 0 && <Text dimColor>No mod has been seen yet in this session.</Text>}
        {view.rows.map(row => {
          const isOpen = open.includes(row.name)
          return (
            <Box key={`row-${row.name}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold color={COLORS[row.mark]} dimColor={row.mark === '·'} wrap="truncate-end">
                  {row.mark} {row.name}
                </Text>
                <Button
                  key={`details-${row.name}`}
                  label={isOpen ? 'Hide' : 'Details'}
                  plain
                  dimColor
                  onPress={() =>
                    update($, expanded, list => (list.includes(row.name) ? list.filter(name => name !== row.name) : [...list, row.name]))
                  }
                />
              </Box>
              <Text dimColor wrap="truncate-end">
                {row.last}
              </Text>
              {row.counts !== '' && <Text dimColor>{row.counts}</Text>}
              {isOpen && row.details.length === 0 && <Text dimColor>Nothing logged today.</Text>}
              {isOpen &&
                row.details.map((detail, i) => (
                  <Text key={`detail-${row.name}-${i}`} wrap="truncate-end">
                    {detail}
                  </Text>
                ))}
            </Box>
          )
        })}
        <Text dimColor>{view.coverage}</Text>
        <Text dimColor>Logs: {view.folder}</Text>
      </Box>
    )
  })
}
