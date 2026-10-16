import type { ApiReading, Hit, SessionUsageRow, Summary, TurnLine, UsageSettings, WindowTotals } from '../types'

export const HOUR_MS = 3_600_000
/** A reading of the API's own five-hour window counts as current for this long. */
export const API_FRESH_MS = 15 * 60_000
/** How many hits hits.json keeps. */
export const KEPT_HITS = 20

/**
 * What a token of each kind counts toward the session limit, as near as
 * Anthropic's usage explainer puts it: cache reads are cheap, cache writes
 * and output dear. An estimate of what the limit meters, not its formula.
 */
export const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 5 } as const

type Counts = { in: number; cr: number; cw: number; out: number }

/** The effective tokens of one turn or one total, whole. */
export const effectiveOf = (t: Counts): number =>
  Math.round(t.in * WEIGHTS.input + t.cr * WEIGHTS.cacheRead + t.cw * WEIGHTS.cacheWrite + t.out * WEIGHTS.output)

/** One turn as its JSON line. */
export const turnLine = (turn: TurnLine): string => JSON.stringify(turn)

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The turns a file holds, one JSON object per line; a line that is not one is skipped. */
export const parseTurns = (text: string): TurnLine[] => {
  const turns: TurnLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const o = value as Record<string, unknown>
    if (!isCount(o.ts) || !isCount(o.in) || !isCount(o.cr) || !isCount(o.cw) || !isCount(o.out)) {
      continue
    }
    const turn: TurnLine = { ts: o.ts, in: o.in, cr: o.cr, cw: o.cw, out: o.out, sub: o.sub === true }
    if (isCount(o.u)) {
      turn.u = o.u
    }
    if (isCount(o.r)) {
      turn.r = o.r
    }
    turns.push(turn)
  }
  return turns
}

/** The turns after `since`; one at the boundary is out. */
export const pruneTurns = (turns: readonly TurnLine[], since: number): TurnLine[] => turns.filter(turn => turn.ts > since)

/** Every session's turns inside the window, summed: the figures the status line, summary.json and /meter draw on. */
export type Window = {
  totals: WindowTotals
  effective: number
  /** Each session with a turn in the window, the heaviest first. */
  sessions: SessionUsageRow[]
  /** The newest reading of the API's own five-hour window among them; null when none carried one. */
  api: ApiReading | null
}

/** Adds up the turns inside the window ending at `now`, file by file, and finds the newest API reading. */
export const sumWindow = (files: readonly { id: string; turns: readonly TurnLine[] }[], now: number, windowMs: number): Window => {
  const since = now - windowMs
  const totals: WindowTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const sessions: SessionUsageRow[] = []
  let api: ApiReading | null = null
  for (const file of files) {
    const inside = pruneTurns(file.turns, since)
    if (inside.length === 0) {
      continue
    }
    const own: Counts = { in: 0, cr: 0, cw: 0, out: 0 }
    let subTurns = 0
    for (const turn of inside) {
      own.in += turn.in
      own.cr += turn.cr
      own.cw += turn.cw
      own.out += turn.out
      if (turn.sub) {
        subTurns += 1
      }
      if (turn.u !== undefined && (api === null || turn.ts > api.ts)) {
        api = { ts: turn.ts, percentUsed: turn.u, resetsAt: turn.r ?? null, sessionId: file.id }
      }
    }
    totals.input += own.in
    totals.cacheRead += own.cr
    totals.cacheWrite += own.cw
    totals.output += own.out
    sessions.push({ id: file.id, turns: inside.length, subTurns, effective: effectiveOf(own) })
  }
  sessions.sort((a, b) => b.effective - a.effective || a.id.localeCompare(b.id))
  const effective = effectiveOf({ in: totals.input, cr: totals.cacheRead, cw: totals.cacheWrite, out: totals.output })
  return { totals, effective, sessions, api }
}

/**
 * The limit message as the API's error row reads it:
 * `You've hit your session limit · resets 10:30pm (America/Los_Angeles)`,
 * also with a bullet, with `Resets at`, or with no zone.
 */
const LIMIT = /hit your (?:session|usage) limit.*?\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i

/** The clock time and zone a limit message names; null when the text is not one, or names no time. */
export const parseLimit = (text: string): { hour: number; minute: number; zone: string | null } | null => {
  const match = LIMIT.exec(text)
  if (!match) {
    return null
  }
  const h12 = Number(match[1])
  const minute = Number(match[2] ?? '0')
  const half = (match[3] ?? '').toLowerCase()
  if (h12 < 1 || h12 > 12 || minute > 59) {
    return null
  }
  const zone = match[4]?.trim() || null
  return { hour: (h12 % 12) + (half === 'pm' ? 12 : 0), minute, zone }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** A time's parts in a zone, by part type; null when Intl refuses the zone. */
const partsIn = (ms: number, zone: string, options: Intl.DateTimeFormatOptions): Map<string, string> | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).formatToParts(new Date(ms))
    return new Map(parts.map(part => [part.type, part.value]))
  } catch {
    return null
  }
}

/** The wall clock in a zone at `ms`. */
const wallIn = (ms: number, zone: string): Wall | null => {
  const parts = partsIn(ms, zone, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (parts === null) {
    return null
  }
  const n = (type: string): number => Number(parts.get(type))
  const wall: Wall = { year: n('year'), month: n('month'), day: n('day'), hour: n('hour') % 24, minute: n('minute'), second: n('second') }
  return Object.values(wall).every(Number.isFinite) ? wall : null
}

/** A wall clock read as if it were UTC. */
const asUtc = (wall: Wall): number => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)

/** The zone's offset from UTC at `ms`, in milliseconds east. */
const offsetIn = (ms: number, zone: string): number | null => {
  const wall = wallIn(ms, zone)
  return wall === null ? null : asUtc(wall) - Math.floor(ms / 1000) * 1000
}

/** The zone this process runs in, as Intl resolves it; null when it cannot say. */
export const localZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

const zonesToTry = (zone: string | null): string[] => [zone, localZone()].filter((z): z is string => z !== null)

/** The next occurrence of a clock time by the process's own clock, when Intl knows no zone at all. */
const nextClockTimeLocal = (now: number, hour: number, minute: number): number => {
  const d = new Date(now)
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime()
  return today > now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime()
}

/**
 * The next occurrence after `now` of a clock time in a zone: today's if it is
 * still ahead, else tomorrow's, the offset re-read at the target so a change of
 * daylight time between now and then is honoured. The local zone stands in
 * for a zone Intl does not know, or none.
 */
export const nextClockTime = (now: number, hour: number, minute: number, zone: string | null): number => {
  for (const z of zonesToTry(zone)) {
    const wall = wallIn(now, z)
    const offset = offsetIn(now, z)
    if (wall === null || offset === null) {
      continue
    }
    let target = Date.UTC(wall.year, wall.month - 1, wall.day, hour, minute, 0)
    if (target <= asUtc(wall)) {
      target += 24 * HOUR_MS
    }
    let at = target - offset
    const later = offsetIn(at, z)
    if (later !== null && later !== offset) {
      at = target - later
    }
    return at
  }
  return nextClockTimeLocal(now, hour, minute)
}

/** `5:30pm`, the way the limit message says it, in the zone (the local zone when it is unknown). */
export const formatClock = (ms: number, zone: string | null): string => {
  for (const z of zonesToTry(zone)) {
    const parts = partsIn(ms, z, { hour: 'numeric', minute: '2-digit', hour12: true })
    if (parts !== null) {
      return `${parts.get('hour')}:${parts.get('minute')}${(parts.get('dayPeriod') ?? '').toLowerCase()}`
    }
  }
  const d = new Date(ms)
  const hour = d.getHours()
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(d.getMinutes()).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
}

/** `Sep 10 3:58pm`. */
export const formatDay = (ms: number, zone: string | null): string => {
  for (const z of zonesToTry(zone)) {
    const parts = partsIn(ms, z, { month: 'short', day: 'numeric' })
    if (parts !== null) {
      return `${parts.get('month')} ${parts.get('day')} ${formatClock(ms, z)}`
    }
  }
  return `${new Date(ms).toDateString().slice(4, 10).trim()} ${formatClock(ms, zone)}`
}

/** `5s ago`, `2m ago`, `1h05m ago`. */
export const formatAgo = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`
}

/** A token count at a glance: `12.4M`, `812K`, `950`. */
export const formatTokens = (n: number): string =>
  n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`

/** A window's length: `5h`, `2.5h`, `30m`. */
export const formatHours = (ms: number): string => {
  const hours = ms / HOUR_MS
  if (hours < 1) {
    return `${Math.round(ms / 60_000)}m`
  }
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(1))}h`
}

/** The median effective total of the last three hits: the cap as the hits have shown it. Null without a hit. */
export const capEstimate = (hits: readonly Hit[]): number | null => {
  const last = hits
    .slice(-3)
    .map(hit => hit.effectiveAtHit)
    .sort((a, b) => a - b)
  if (last.length === 0) {
    return null
  }
  const mid = Math.floor(last.length / 2)
  return last.length % 2 === 1 ? (last[mid] ?? null) : Math.round(((last[mid - 1] ?? 0) + (last[mid] ?? 0)) / 2)
}

/** The hits with one more, unless one with the same reset time is already there (the same limit, seen again); the last `keep` kept. */
export const withHit = (hits: readonly Hit[], hit: Hit, keep: number): { hits: Hit[]; isNew: boolean } =>
  hits.some(known => known.resetAt === hit.resetAt) ? { hits: [...hits], isNew: false } : { hits: [...hits, hit].slice(-keep), isNew: true }

/** The hits hits.json holds; nothing for a missing or unreadable file. */
export const parseHits = (text: string | null): Hit[] => {
  if (text === null) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const hits: Hit[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const o = item as Record<string, unknown>
    if (!isCount(o.at) || !isCount(o.resetAt) || !isCount(o.effectiveAtHit)) {
      continue
    }
    hits.push({ at: o.at, resetAt: o.resetAt, effectiveAtHit: o.effectiveAtHit, zone: typeof o.zone === 'string' && o.zone !== '' ? o.zone : null })
  }
  return hits
}

/**
 * summary.json, field for field in the contract's order. `pct` and `nextResetAt` come from the API's own five-hour
 * reading while it is fresh (the limit's real figure, known before any hit), else from the last learned limit.
 */
export const buildSummary = (window: Window, hits: readonly Hit[], now: number, windowMs: number): Summary => {
  const cap = capEstimate(hits)
  const api = isFreshReading(window.api, now) ? window.api : null
  let last: Hit | null = null
  for (const hit of hits) {
    if (last === null || hit.at >= last.at) {
      last = hit
    }
  }
  return {
    ts: now,
    windowMs,
    sessions: window.sessions.length,
    tokens: { input: window.totals.input, cacheRead: window.totals.cacheRead, cacheWrite: window.totals.cacheWrite, output: window.totals.output },
    effective: window.effective,
    capEstimate: cap,
    pct: api !== null ? Math.round(api.percentUsed) : cap !== null && cap > 0 ? Math.round((100 * window.effective) / cap) : null,
    lastHitAt: last === null ? null : last.at,
    nextResetAt:
      api !== null && api.resetsAt !== null && api.resetsAt > now ? api.resetsAt : last !== null && last.resetAt > now ? last.resetAt : null,
  }
}

/** The estimate alone: the window's effective tokens against the last learned limit, whatever pct carries. */
export const estimatePct = (summary: Summary): number | null =>
  summary.capEstimate !== null && summary.capEstimate > 0 ? Math.round((100 * summary.effective) / summary.capEstimate) : null

/** Whether two summaries say the same thing, the timestamp aside. */
export const isSameSummary = (a: Summary | null, b: Summary): boolean =>
  a !== null && JSON.stringify({ ...a, ts: 0 }) === JSON.stringify({ ...b, ts: 0 })

/** The share of the limit used, and whether the API said so or the estimate did. */
export type Share = { pct: number; source: 'api' | 'estimate' }

/** Whether a reading of the API's window is still current: recent, and its window not yet reset. */
export const isFreshReading = (api: ApiReading | null, now: number): api is ApiReading =>
  api !== null && now - api.ts <= API_FRESH_MS && (api.resetsAt === null || api.resetsAt > now)

/** The best share known: the API's own reading while fresh, else the estimate against the last limit, else nothing. */
export const shareOf = (summary: Summary, api: ApiReading | null, now: number): Share | null =>
  isFreshReading(api, now)
    ? { pct: Math.round(api.percentUsed), source: 'api' }
    : summary.pct !== null
      ? { pct: summary.pct, source: 'estimate' }
      : null

/** The next reset ahead: the last hit's, else the API's; null when neither is ahead. */
export const resetOf = (summary: Summary, api: ApiReading | null, now: number): number | null =>
  summary.nextResetAt !== null && summary.nextResetAt > now
    ? summary.nextResetAt
    : api !== null && api.resetsAt !== null && api.resetsAt > now
      ? api.resetsAt
      : null

/** `usage 5h: 12.4M eff · 61% of last limit · resets 10:30pm`: the share and the reset only when known. */
export const statusLine = (summary: Summary, api: ApiReading | null, now: number, windowMs: number, zone: string | null): string => {
  const parts = [`usage ${formatHours(windowMs)}: ${formatTokens(summary.effective)} eff`]
  const share = shareOf(summary, api, now)
  if (share !== null) {
    parts.push(share.source === 'api' ? `${share.pct}% used` : `${share.pct}% of last limit`)
  }
  const reset = resetOf(summary, api, now)
  if (reset !== null) {
    parts.push(`resets ${formatClock(reset, zone)}`)
  }
  return parts.join(' · ')
}

/** The toast when the share first crosses the threshold. */
export const warnMessage = (share: Share, summary: Summary, api: ApiReading | null, now: number, windowMs: number, zone: string | null): string => {
  const window = `in the last ${formatHours(windowMs)}`
  const head =
    share.source === 'api'
      ? `Usage at ${share.pct}% of the five-hour limit · ${formatTokens(summary.effective)} eff ${window}`
      : `Usage at ${share.pct}% of the last session limit · ${formatTokens(summary.effective)} of ${formatTokens(summary.capEstimate ?? 0)} eff ${window}`
  const reset = resetOf(summary, api, now)
  return reset === null ? head : `${head} · resets ${formatClock(reset, zone)}`
}

/** The toast at the hit itself. */
export const hitMessage = (resetAt: number, effective: number, windowMs: number, zone: string | null): string =>
  `Session limit hit · resets ${formatClock(resetAt, zone)} · ${formatTokens(effective)} eff in the last ${formatHours(windowMs)}, cap estimate updated`

const WEIGHTS_LINE =
  'Weights: eff = input + 0.1·cache read + 2·cache write + 5·output, an estimate of what the session limit meters; the API line is the limit’s own reading.'

/** What /meter and the usage_status tool print. */
export const describeUsage = (
  window: Window,
  summary: Summary,
  hits: readonly Hit[],
  settings: UsageSettings,
  now: number,
  ownId: string,
  zone: string | null,
): string => {
  const hours = formatHours(summary.windowMs)
  const t = window.totals
  const lines: string[] = [
    window.sessions.length === 0
      ? `Usage in the last ${hours}, all sessions: 0 eff (no turns counted yet)`
      : `Usage in the last ${hours}, all sessions: ${formatTokens(summary.effective)} eff · input ${formatTokens(t.input)} · cache read ${formatTokens(t.cacheRead)} · cache write ${formatTokens(t.cacheWrite)} · output ${formatTokens(t.output)}`,
  ]
  if (summary.capEstimate === null || estimatePct(summary) === null) {
    lines.push('Estimate: no limit hit seen yet, so the cap is unknown until the first')
  } else {
    const n = Math.min(3, hits.length)
    const from = n === 1 ? '1 hit' : `the median of the last ${n} hits`
    const reset = summary.nextResetAt !== null && summary.nextResetAt > now ? ` · resets ${formatClock(summary.nextResetAt, zone)}` : ''
    lines.push(`Estimate: ${estimatePct(summary)}% of the last session limit (cap ${formatTokens(summary.capEstimate)} eff from ${from})${reset}`)
  }
  const api = window.api
  if (api === null) {
    lines.push('API five-hour window: no reading yet')
  } else {
    const reset = api.resetsAt !== null && api.resetsAt > now ? ` · resets ${formatClock(api.resetsAt, zone)}` : ''
    lines.push(`API five-hour window: ${Math.round(api.percentUsed)}% used${reset} · read ${formatAgo(now - api.ts)} by session ${api.sessionId.slice(0, 8)}`)
  }
  lines.push(`Sessions in the window: ${window.sessions.length}`)
  const rows = window.sessions.map(session => ({
    id: session.id.slice(0, 8).padEnd(8),
    turns: `${session.turns} ${session.turns === 1 ? 'turn' : 'turns'}${session.subTurns > 0 ? ` (${session.subTurns} by subagents)` : ''}`,
    eff: `${formatTokens(session.effective)} eff`,
    share: `${summary.effective > 0 ? Math.round((100 * session.effective) / summary.effective) : 0}%`,
    isOwn: session.id === ownId,
  }))
  const turnsWidth = Math.max(0, ...rows.map(row => row.turns.length))
  const effWidth = Math.max(0, ...rows.map(row => row.eff.length))
  const shareWidth = Math.max(0, ...rows.map(row => row.share.length))
  for (const row of rows) {
    lines.push(`  ${row.id}  ${row.turns.padEnd(turnsWidth)}  ${row.eff.padStart(effWidth)}  ${row.share.padStart(shareWidth)}${row.isOwn ? '  ← this session' : ''}`)
  }
  if (hits.length === 0) {
    lines.push('Limit hits: none yet')
  } else {
    lines.push(`Limit hits, newest first (${hits.length} kept, ${KEPT_HITS} at most):`)
    for (const hit of [...hits].sort((a, b) => b.at - a.at)) {
      lines.push(`  ${formatDay(hit.at, zone)} · resets ${formatClock(hit.resetAt, hit.zone ?? zone)} · ${formatTokens(hit.effectiveAtHit)} eff in the window then`)
    }
  }
  lines.push(WEIGHTS_LINE, `Settings: window ${formatHours(settings.windowHours * HOUR_MS)} · refresh every ${settings.refreshSeconds}s · warn at ${settings.warnAt}%`)
  return lines.join('\n')
}
