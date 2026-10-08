/**
 * The day files: where they live, how a line is written and read back, which
 * folders retention removes, and the ranges a report covers. Pure.
 */

import type { CountsLine, EventLine, Line } from '../types'

export const DAY_MS = 86_400_000

/** The monitor's folder under the home folder; nothing outside it is ever removed. */
export function monitorRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/mods/monitor`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The local day of a time: `2026-10-08`. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight of the day a time falls on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The local time of day: `14:03`. */
export function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `10-07 14:03`: a time within the last weeks, as a report names it. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockOf(ms)}`
}

const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/

/** Whether a folder name is a day folder the monitor made. */
export function isDayName(name: string): boolean {
  return DAY_NAME.test(name)
}

/** A session's file name: the first 8 characters of its id, letters and digits only. */
export function sessionFileName(sessionId: string): string {
  const short = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8)
  return `${short || 'session'}.jsonl`
}

export function sessionPath(home: string, day: string, sessionId: string): string {
  return `${monitorRoot(home)}/${day}/${sessionFileName(sessionId)}`
}

/** The day folders (by name) that retention removes: day folders older than `retentionDays` days. */
export function expiredDays(names: readonly string[], now: number, retentionDays: number): string[] {
  const oldestKept = dayOf(now - Math.max(1, retentionDays) * DAY_MS)
  return names.filter(name => isDayName(name) && name < oldestKept)
}

/** One line of a file, read back; anything else is skipped. */
function asLine(value: unknown): Line | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const line = value as Record<string, unknown>
  if (typeof line.plugin !== 'string' || typeof line.ts !== 'number') {
    return null
  }
  if (line.t === 'event' && typeof line.kind === 'string') {
    return line as EventLine
  }
  if (line.t === 'counts' && typeof line.runs === 'object' && line.runs !== null) {
    return line as CountsLine
  }
  return null
}

/** The lines of a JSONL file; a line that does not parse is skipped. */
export function parseLines(text: string): Line[] {
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) {
      continue
    }
    try {
      const line = asLine(JSON.parse(raw))
      if (line) {
        lines.push(line)
      }
    } catch {
      // A torn or foreign line: skipped.
    }
  }
  return lines
}

/** A line held in memory with its JSON, kept until the line changes (a repeat folded into it). */
export type Entry = { line: Line; json: string | null }

export function jsonOf(entry: Entry): string {
  entry.json ??= JSON.stringify(entry.line)
  return entry.json
}

/** The whole file: one JSON line per entry. */
export function serialize(entries: readonly Entry[]): string {
  return entries.length === 0 ? '' : `${entries.map(jsonOf).join('\n')}\n`
}

/** What `$.fs.write` takes at most is 4 MiB; a file is trimmed well before. */
export const MAX_FILE_BYTES = 3_500_000
export const TRIMMED_FILE_BYTES = 3_000_000

/**
 * Keeps a file under `maxBytes`: when it is over, the oldest event lines go
 * first (the `seen` lines and the counts stay), then the oldest counts, until
 * it is under `targetBytes`. Returns the entries kept.
 */
export function trimEntries(entries: readonly Entry[], maxBytes = MAX_FILE_BYTES, targetBytes = TRIMMED_FILE_BYTES): Entry[] {
  let bytes = entries.reduce((sum, entry) => sum + jsonOf(entry).length + 1, 0)
  if (bytes <= maxBytes) {
    return [...entries]
  }
  const drop = new Set<Entry>()
  const passes: ((entry: Entry) => boolean)[] = [
    entry => entry.line.t === 'event' && entry.line.kind !== 'seen',
    entry => entry.line.t === 'counts',
  ]
  for (const isDroppable of passes) {
    for (const entry of entries) {
      if (bytes <= targetBytes) {
        break
      }
      if (!drop.has(entry) && isDroppable(entry)) {
        drop.add(entry)
        bytes -= jsonOf(entry).length + 1
      }
    }
  }
  return entries.filter(entry => !drop.has(entry))
}

/** A report's range: `24h`, `7d`, `30d` (any whole number of hours or days, up to a year). */
export type Range = { label: string; ms: number }

export function rangeOf(arg: string | undefined, fallback: string): Range | null {
  const text = (arg ?? '').trim().toLowerCase() || fallback
  const match = /^(\d{1,4})\s*(h|d)$/.exec(text)
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  const ms = amount * (match[2] === 'h' ? 3_600_000 : DAY_MS)
  if (amount < 1 || ms > 366 * DAY_MS) {
    return null
  }
  return { label: `${amount}${match[2]}`, ms }
}

/** The day folders a range touches, oldest first: from the day `since` falls on to today. */
export function daysBetween(since: number, now: number): string[] {
  const days: string[] = []
  const last = dayOf(now)
  // Step by half a day so a day of 23 or 25 hours (a clock change) is never skipped.
  for (let at = since; ; at += DAY_MS / 2) {
    const day = dayOf(Math.min(at, now))
    if (days[days.length - 1] !== day) {
      days.push(day)
    }
    if (day === last || at >= now) {
      break
    }
  }
  return days
}
