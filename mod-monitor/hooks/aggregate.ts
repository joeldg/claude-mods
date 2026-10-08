/**
 * Folding day-file lines into one summary per mod, and the three ways it is
 * shown: the pane's rows, `/mods report` and `/mods failures`. Pure.
 */

import type { CountsLine, EventLine, FailureOutcome, Line, TokenUsage } from '../types'
import { clockOf, stampOf } from './log'
import { ageText, clip, countText, msText } from './mask'

/** One session's lines from one day folder (or this session's, live). */
export type SessionFile = { session: string; day: string; lines: readonly Line[] }

export type FailureGroup = {
  event: string
  outcome: FailureOutcome
  what: string
  n: number
  lastTs: number
  lastReason?: string
  maxMs: number
}

export type ProcGroup = { cmd: string; n: number; lastTs: number; lastExit: number | null; lastErr?: string }

export type SlowGroup = { event: string; n: number; max: number; p95: number }

export type ModSummary = {
  name: string
  /** Sessions it was loaded in (a `seen` line in that session's file). */
  sessions: Set<string>
  runs: Record<string, number>
  runsTotal: number
  /** Runs on events other than a session's start and end, which every loaded mod gets. */
  activeRuns: number
  toasts: number
  toastTexts: Map<string, number>
  cmds: number
  commands: Map<string, { n: number; bare: number }>
  tools: number
  procs: number
  procFails: number
  /** Error lines the mod logged itself. */
  logErrors: number
  procGroups: Map<string, ProcGroup>
  writes: number
  models: number
  modelNames: Map<string, number>
  /** Model calls that came back with no answer, by outcome. */
  modelMisses: Map<string, number>
  tokens: TokenUsage
  fails: number
  failureGroups: Map<string, FailureGroup>
  slow: Map<string, SlowGroup>
  /** Everything it did, as logged (not `seen`). */
  events: EventLine[]
  /** When it last did anything; 0 when it never did. */
  lastActivity: number
}

/** The events every loaded mod's hooks run on, which say nothing about it being in use. */
const STARTUP = new Set(['session.start', 'session.end'])

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function blank(name: string): ModSummary {
  return {
    name,
    sessions: new Set(),
    runs: {},
    runsTotal: 0,
    activeRuns: 0,
    toasts: 0,
    toastTexts: new Map(),
    cmds: 0,
    commands: new Map(),
    tools: 0,
    procs: 0,
    procFails: 0,
    logErrors: 0,
    procGroups: new Map(),
    writes: 0,
    models: 0,
    modelNames: new Map(),
    modelMisses: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    fails: 0,
    failureGroups: new Map(),
    slow: new Map(),
    events: [],
    lastActivity: 0,
  }
}

function addCounts(mod: ModSummary, line: CountsLine) {
  let active = false
  for (const [event, value] of Object.entries(line.runs ?? {})) {
    const n = num(value)
    mod.runs[event] = (mod.runs[event] ?? 0) + n
    mod.runsTotal += n
    if (!STARTUP.has(event) && n > 0) {
      mod.activeRuns += n
      active = true
    }
  }
  const procs = num(line.procs)
  const procFails = num(line.procFails)
  const writes = num(line.writes)
  const toasts = num(line.toasts)
  const models = num(line.models)
  const fails = num(line.fails)
  const cmds = num(line.cmds)
  const tools = num(line.tools)
  mod.procs += procs
  mod.procFails += procFails
  mod.logErrors += num(line.logErrors)
  mod.writes += writes
  mod.toasts += toasts
  mod.models += models
  mod.fails += fails
  mod.cmds += cmds
  mod.tools += tools
  for (const [event, stat] of Object.entries(line.slow ?? {})) {
    const known = mod.slow.get(event)
    const n = num(stat?.n)
    const max = num(stat?.max)
    const p95 = num(stat?.p95)
    mod.slow.set(event, {
      event,
      n: (known?.n ?? 0) + n,
      max: Math.max(known?.max ?? 0, max),
      // A rough figure: the highest p95 any window reported.
      p95: Math.max(known?.p95 ?? 0, p95),
    })
  }
  if (active || procs + writes + toasts + models + fails + cmds + tools > 0) {
    mod.lastActivity = Math.max(mod.lastActivity, line.ts)
  }
}

function addEvent(mod: ModSummary, line: EventLine, session: string) {
  const n = Math.max(1, num(line.n) || 1)
  const at = Math.max(line.ts, num(line.last))
  switch (line.kind) {
    case 'seen':
      mod.sessions.add(session)
      return
    case 'failure': {
      const key = `${line.event}|${line.outcome}`
      const known = mod.failureGroups.get(key)
      const isLater = !known || at >= known.lastTs
      mod.failureGroups.set(key, {
        event: line.event,
        outcome: line.outcome,
        what: line.what,
        n: (known?.n ?? 0) + n,
        lastTs: Math.max(known?.lastTs ?? 0, at),
        lastReason: isLater ? (line.reason ?? known?.lastReason) : known?.lastReason,
        maxMs: Math.max(known?.maxMs ?? 0, num(line.ms)),
      })
      break
    }
    case 'toast':
      mod.toastTexts.set(line.text, (mod.toastTexts.get(line.text) ?? 0) + n)
      break
    case 'proc-fail': {
      const known = mod.procGroups.get(line.cmd)
      const isLater = !known || at >= known.lastTs
      mod.procGroups.set(line.cmd, {
        cmd: line.cmd,
        n: (known?.n ?? 0) + n,
        lastTs: Math.max(known?.lastTs ?? 0, at),
        lastExit: isLater ? line.exit : (known?.lastExit ?? null),
        lastErr: isLater ? (line.err ?? known?.lastErr) : known?.lastErr,
      })
      break
    }
    case 'model':
      mod.modelNames.set(line.model, (mod.modelNames.get(line.model) ?? 0) + 1)
      if (line.outcome !== 'answered') {
        mod.modelMisses.set(line.outcome, (mod.modelMisses.get(line.outcome) ?? 0) + 1)
      }
      if (line.usage) {
        mod.tokens.in += num(line.usage.in)
        mod.tokens.out += num(line.usage.out)
        mod.tokens.cacheRead += num(line.usage.cacheRead)
        mod.tokens.cacheWrite += num(line.usage.cacheWrite)
      }
      break
    case 'command': {
      const known = mod.commands.get(line.command) ?? { n: 0, bare: 0 }
      mod.commands.set(line.command, { n: known.n + n, bare: known.bare + (line.hasArgs ? 0 : n) })
      break
    }
    default:
      break
  }
  mod.events.push(line)
  if (line.kind !== 'register') {
    mod.lastActivity = Math.max(mod.lastActivity, at)
  }
}

/** One summary per mod named in the files, from `since` on. */
export function aggregate(files: readonly SessionFile[], since = -Infinity): Map<string, ModSummary> {
  const mods = new Map<string, ModSummary>()
  for (const file of files) {
    for (const line of file.lines) {
      if (line.ts < since && num(line.t === 'event' ? line.last : 0) < since) {
        continue
      }
      let mod = mods.get(line.plugin)
      if (!mod) {
        mod = blank(line.plugin)
        mods.set(line.plugin, mod)
      }
      if (line.t === 'counts') {
        addCounts(mod, line)
      } else {
        addEvent(mod, line, file.session)
      }
    }
  }
  return mods
}

/** Whether a mod did anything at all (beyond being loaded). */
export function isActive(mod: ModSummary | undefined): boolean {
  return mod !== undefined && mod.lastActivity > 0
}

const times = (n: number) => (n > 1 ? ` ×${countText(n)}` : '')

/** One logged event as the pane's Details and the reports say it. */
export function eventText(line: EventLine): string {
  const n = times(num(line.n))
  switch (line.kind) {
    case 'seen':
      return `loaded (${line.via}${line.version ? `, v${line.version}` : ''})`
    case 'failure':
      return `✗ ${line.event} hook ${line.what}${line.reason ? `: ${line.reason}` : ''} (${msText(line.ms)})${n}`
    case 'slow':
      return `slow ${line.event} hook: ${msText(line.ms)}${n}`
    case 'toast':
      return `toast: ${line.text}${n}`
    case 'status':
      return `status: ${line.text || '(cleared)'}${n}`
    case 'proc-fail':
      return `✗ ${line.cmd}: ${line.exit === null ? 'did not run' : `exit ${line.exit}`}${line.err ? ` — ${line.err}` : ''}${n}`
    case 'proc-slow':
      return `slow process ${line.cmd}: ${msText(line.ms)}`
    case 'proc-expected':
      return `· ${line.cmd}: ${line.why} (expected)${n}`
    case 'log':
      return `${line.isError ? '✗ logged' : 'logged'}: ${line.text}${n}`
    case 'model': {
      const usage = line.usage
      const tokens = usage ? `, ${countText(usage.in + usage.cacheRead + usage.cacheWrite)} in / ${countText(usage.out)} out` : ''
      return `model ${line.model}: ${line.outcome}${tokens}`
    }
    case 'write':
      return `wrote to ${line.dir}`
    case 'command':
      return `/${line.command}${line.hasArgs ? ' …' : ''}${line.by === 'composer' ? '' : ` (from ${line.by})`}${n}`
    case 'register':
      return `registered ${line.what === 'command' ? `/${line.name}` : `tool ${line.name}`}`
  }
}

/** The newest event of the kinds given. */
function newest(mod: ModSummary, kinds: readonly string[]): EventLine | undefined {
  let best: EventLine | undefined
  for (const line of mod.events) {
    if (kinds.includes(line.kind) && (!best || Math.max(line.ts, num(line.last)) >= Math.max(best.ts, num(best.last)))) {
      best = line
    }
  }
  return best
}

/** What a mod last did, in a few words: its last toast or command, else its last other sign of life. */
export function lastNote(mod: ModSummary): string {
  const line = newest(mod, ['toast', 'command']) ?? newest(mod, ['failure', 'proc-fail', 'status', 'model', 'slow', 'write'])
  return line ? eventText(line) : ''
}

// ---------------------------------------------------------------------------
// The pane.

export type RowMark = '✓' | '⚠' | '✗' | '·'

export type PaneRow = {
  name: string
  mark: RowMark
  /** `2m ago · toast: …`, or what is known when it did nothing. */
  last: string
  /** Today's counts, the ones that are not zero. */
  counts: string
  /** Its events today, newest first, 20 at most. */
  details: string[]
}

export type PaneView = { header: string; rows: PaneRow[]; coverage: string; folder: string }

export type PaneInput = {
  now: number
  /** The mods the plugin folders name (the monitor left out); empty when none are named. */
  expected: readonly string[]
  /** The mods seen this session. */
  loaded: ReadonlySet<string>
  /** The mods seen beneath the monitor in a trace this session. */
  covered: ReadonlySet<string>
  /** The mods whose processes failed 5 times in the last 10 minutes. */
  procBursts: ReadonlySet<string>
  /** Today's summaries, every session's. */
  today: ReadonlyMap<string, ModSummary>
  /** Where today's logs are, as shown. */
  folder: string
}

export const DETAILS_MAX = 20

/** The health mark: ✗ expected but not seen this session, ⚠ failing, ✓ active, · seen but idle today. */
export function markOf(name: string, input: PaneInput): RowMark {
  const mod = input.today.get(name)
  if (!input.loaded.has(name)) {
    return input.expected.includes(name) ? '✗' : mod && mod.fails > 0 ? '⚠' : '·'
  }
  if ((mod && (mod.fails > 0 || mod.failureGroups.size > 0)) || input.procBursts.has(name)) {
    return '⚠'
  }
  return isActive(mod) ? '✓' : '·'
}

/** Today's counts in a line, zeros left out. */
export function countsText(mod: ModSummary | undefined): string {
  if (!mod) {
    return ''
  }
  const parts: [string, number][] = [
    ['hooks', mod.runsTotal],
    ['toasts', mod.toasts],
    ['commands', mod.cmds],
    ['tool calls', mod.tools],
    ['process failures', mod.procFails],
    ['errors logged', mod.logErrors],
    ['model calls', mod.models],
  ]
  return parts
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${countText(n)}`)
    .join(' · ')
}

function rowOf(name: string, input: PaneInput): PaneRow {
  const mod = input.today.get(name)
  const mark = markOf(name, input)
  let last: string
  if (mark === '✗') {
    last = 'not seen in this session (not loaded, or silent so far)'
  } else if (mod && mod.lastActivity > 0) {
    const note = lastNote(mod)
    const age = ageText(input.now - mod.lastActivity)
    last = `${age === 'now' ? 'just now' : `${age} ago`}${note ? ` · ${note}` : ''}`
  } else {
    last = 'loaded, nothing done today'
  }
  const details = mod
    ? [...mod.events]
        .filter(line => line.kind !== 'seen')
        .sort((a, b) => Math.max(b.ts, num(b.last)) - Math.max(a.ts, num(a.last)))
        .slice(0, DETAILS_MAX)
        .map(line => `${clockOf(Math.max(line.ts, num(line.last)))}  ${eventText(line)}`)
    : []
  return { name, mark, last, counts: countsText(mod), details }
}

/** Every row the pane shows: the expected mods first, in their order, then any other mod loaded now. */
export function paneView(input: PaneInput): PaneView {
  const names = [...input.expected]
  const extra = [...input.loaded].filter(name => !names.includes(name)).sort()
  if (input.expected.length === 0) {
    for (const name of [...input.today.keys()].sort()) {
      if (!extra.includes(name)) {
        extra.push(name)
      }
    }
  }
  names.push(...extra)
  const rows = names.map(name => rowOf(name, input))
  const failing = rows.filter(row => row.mark === '⚠').length
  const loadedCount = input.expected.length > 0 ? input.expected.filter(name => input.loaded.has(name)).length : input.loaded.size
  const coveredCount = [...input.loaded].filter(name => input.covered.has(name)).length
  const loadedText =
    input.expected.length > 0 ? `${loadedCount} of ${input.expected.length} mods loaded` : `${loadedCount} mods loaded`
  const header = `${loadedText} · ${coveredCount} covered · ${failing} failing today`
  const above = [...input.loaded].filter(name => !input.covered.has(name)).sort()
  const coverage =
    input.loaded.size === 0
      ? 'No mod has been seen yet this session.'
      : above.length === 0
        ? 'Every loaded mod has run beneath the monitor.'
        : `Not seen beneath the monitor yet: ${above.join(', ')} (loaded above it, or idle). It sees failures only in the mods beneath it.`
  return { header, rows, coverage, folder: input.folder }
}

// ---------------------------------------------------------------------------
// The reports.

export type ReportInput = {
  now: number
  since: number
  /** `24h`, `7d`, `30d`. */
  range: string
  /** How many session files the range held. */
  sessions: number
  expected: readonly string[]
  mods: ReadonlyMap<string, ModSummary>
}

const top = <K>(map: ReadonlyMap<K, number>, count: number): [K, number][] =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)

/** The mods a report covers: the expected ones in order, then any other that left a line. */
function reportNames(input: ReportInput): string[] {
  const names = [...input.expected]
  for (const name of [...input.mods.keys()].sort()) {
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

const wasSeen = (mod: ModSummary | undefined) => mod !== undefined && (mod.sessions.size > 0 || mod.lastActivity > 0 || mod.runsTotal > 0)

function hookFailureLines(mod: ModSummary): string[] {
  if (mod.failureGroups.size === 0 && mod.fails === 0) {
    return []
  }
  const groups = [...mod.failureGroups.values()].sort((a, b) => b.n - a.n)
  const total = Math.max(mod.fails, groups.reduce((sum, group) => sum + group.n, 0))
  return [
    `  hook failures ${countText(total)}:`,
    ...groups.map(group => {
      const reason = group.lastReason ? ` — ${group.lastReason}` : ''
      return `    ${group.event} ${group.what} (${group.outcome}) ×${countText(group.n)}, last ${stampOf(group.lastTs)}, up to ${msText(group.maxMs)}${reason}`
    }),
  ]
}

function processFailureLines(mod: ModSummary): string[] {
  if (mod.procGroups.size === 0 && mod.procFails === 0) {
    return []
  }
  const groups = [...mod.procGroups.values()].sort((a, b) => b.n - a.n)
  const total = Math.max(mod.procFails, groups.reduce((sum, group) => sum + group.n, 0))
  return [
    `  process failures ${countText(total)}:`,
    ...groups.map(group => {
      const exit = group.lastExit === null ? 'did not run' : `exit ${group.lastExit}`
      return `    ${group.cmd} ×${countText(group.n)}, last ${stampOf(group.lastTs)} (${exit})${group.lastErr ? `: ${group.lastErr}` : ''}`
    }),
  ]
}

/** A mod's hook failures by event and outcome, then its process failures by command. */
function failureLines(mod: ModSummary): string[] {
  return [...hookFailureLines(mod), ...processFailureLines(mod)]
}

function runsLine(mod: ModSummary): string {
  const runs = Object.entries(mod.runs)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([event, n]) => `${event} ${countText(n)}`)
  return `  hook runs ${countText(mod.runsTotal)}${runs.length > 0 ? `: ${runs.join(' · ')}` : ''}`
}

function toastsLine(mod: ModSummary): string | null {
  if (mod.toasts === 0 && mod.toastTexts.size === 0) {
    return null
  }
  const shown = top(mod.toastTexts, 3).map(([text, n]) => `"${clip(text, 80)}" ×${countText(n)}`)
  return `  toasts ${countText(Math.max(mod.toasts, mod.toastTexts.size))}${shown.length > 0 ? `: ${shown.join(' · ')}` : ''}`
}

function commandsLine(mod: ModSummary): string | null {
  if (mod.commands.size === 0 && mod.cmds === 0) {
    return null
  }
  const used = [...mod.commands.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([name, use]) => `/${name} ×${countText(use.n)}${use.bare > 0 && use.bare < use.n ? ` (${countText(use.bare)} bare)` : ''}`)
  return `  commands used: ${used.length > 0 ? used.join(' · ') : countText(mod.cmds)}`
}

const countLine = (label: string, n: number): string | null => (n > 0 ? `  ${label} ${countText(n)}` : null)

function slowLine(mod: ModSummary): string | null {
  if (mod.slow.size === 0) {
    return null
  }
  const slow = [...mod.slow.values()]
    .sort((a, b) => b.max - a.max)
    .map(stat => `${stat.event} max ${msText(stat.max)}, p95 ${msText(stat.p95)} (${countText(stat.n)} slow)`)
  return `  slowest hooks: ${slow.join(' · ')}`
}

function modelsLine(mod: ModSummary): string | null {
  if (mod.models === 0 && mod.modelNames.size === 0) {
    return null
  }
  const names = top(mod.modelNames, 5).map(([name, n]) => `${name} ×${countText(n)}`)
  const misses = top(mod.modelMisses, 5).map(([outcome, n]) => `${outcome} ×${countText(n)}`)
  const t = mod.tokens
  return (
    `  model calls ${countText(Math.max(mod.models, mod.modelNames.size))}: ${names.join(' · ')}` +
    ` — ${countText(t.in)} in / ${countText(t.out)} out tokens (cache ${countText(t.cacheRead)} read / ${countText(t.cacheWrite)} written)` +
    (misses.length > 0 ? `; unanswered: ${misses.join(' · ')}` : '')
  )
}

function modSection(mod: ModSummary): string[] {
  const sessions = mod.sessions.size
  const lines: (string | null)[] = [
    `${mod.name} — loaded in ${countText(sessions)} session${sessions === 1 ? '' : 's'}`,
    runsLine(mod),
    toastsLine(mod),
    commandsLine(mod),
    countLine('tool calls', mod.tools),
    countLine('processes run', mod.procs),
    countLine('files written', mod.writes),
    ...failureLines(mod),
    slowLine(mod),
    modelsLine(mod),
  ]
  return lines.filter((line): line is string => line !== null)
}

/** `/mods report`: per mod what it did over the range, then the mods never seen. */
export function reportText(input: ReportInput): string {
  const names = reportNames(input)
  const seen = names.filter(name => wasSeen(input.mods.get(name)))
  const never = names.filter(name => !wasSeen(input.mods.get(name)))
  const failing = seen.filter(name => {
    const mod = input.mods.get(name)
    return mod !== undefined && (mod.fails > 0 || mod.failureGroups.size > 0 || mod.procFails > 0 || mod.logErrors > 0)
  })
  const lines = [
    `# Mods report: last ${input.range} (${stampOf(input.since)} to ${stampOf(input.now)})`,
    '',
    `${countText(input.sessions)} session${input.sessions === 1 ? '' : 's'} · ${seen.length} mod${seen.length === 1 ? '' : 's'} seen · ${failing.length} with failures`,
  ]
  for (const name of seen) {
    const mod = input.mods.get(name)
    if (mod) {
      lines.push('', ...modSection(mod))
    }
  }
  lines.push('', never.length > 0 ? `Never seen: ${never.join(', ')}` : 'Every expected mod was seen.')
  return `${lines.join('\n')}\n`
}

/** `/mods failures`: hook failures and process errors alone. */
export function failuresText(input: ReportInput): string {
  const lines = [`# Mod failures: last ${input.range} (${stampOf(input.since)} to ${stampOf(input.now)})`]
  let any = false
  for (const name of reportNames(input)) {
    const mod = input.mods.get(name)
    const found = mod ? failureLines(mod) : []
    if (found.length > 0) {
      any = true
      lines.push('', name, ...found)
    }
  }
  if (!any) {
    lines.push('', 'No hook failures or process errors.')
  }
  return `${lines.join('\n')}\n`
}
