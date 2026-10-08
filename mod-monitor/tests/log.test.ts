import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_FILE_BYTES,
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
} from '../hooks/log'
import type { Entry } from '../hooks/log'
import { DAY, NOW, counts, event } from './fixtures'

describe('day files', () => {
  test('a day is named by its local date, and the file by the session', () => {
    const d = new Date(NOW)
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(dayOf(NOW)).toBe(local)
    expect(dayOf(startOfDay(NOW))).toBe(local)
    expect(dayOf(startOfDay(NOW) - 1)).toBe(dayOf(NOW - DAY))
    expect(isDayName(local)).toBe(true)
    expect(isDayName('notes')).toBe(false)
    expect(sessionFileName('feedface-0000-4000-8000-000000000001')).toBe('feedface.jsonl')
    expect(sessionFileName('../../x')).toBe('x.jsonl')
    expect(monitorRoot('/Users/me/')).toBe('/Users/me/.claude/mods/monitor')
    expect(sessionPath('/Users/me', '2026-10-07', 'feedface-1')).toBe('/Users/me/.claude/mods/monitor/2026-10-07/feedface.jsonl')
  })

  test('retention picks dated folders older than the window, and nothing else', () => {
    const names = [dayOf(NOW), dayOf(NOW - 30 * DAY), dayOf(NOW - 31 * DAY), dayOf(NOW - 400 * DAY), 'notes', 'report-latest.md']
    expect(expiredDays(names, NOW, 30)).toEqual([dayOf(NOW - 31 * DAY), dayOf(NOW - 400 * DAY)])
    expect(expiredDays(names, NOW, 365)).toEqual([dayOf(NOW - 400 * DAY)])
  })

  test('lines read back; torn and foreign lines are skipped', () => {
    const toast = event('recall', NOW, { kind: 'toast', text: 'hi' })
    const tally = counts('recall', NOW, { toasts: 1 })
    const text = `${JSON.stringify(toast)}\n{"t":"event","ts":1\nnot json\n{"t":"other","ts":1,"plugin":"x"}\n\n${JSON.stringify(tally)}\n`
    expect(parseLines(text)).toEqual([toast, tally])
  })

  test('a file over the limit sheds its oldest events first, keeping what was seen and the counts', () => {
    const big = 'x'.repeat(1000)
    const entries: Entry[] = [
      { line: event('recall', NOW, { kind: 'seen', via: 'trace' }), json: null },
      ...Array.from({ length: 4000 }, (_, i): Entry => ({ line: event('recall', NOW + i, { kind: 'toast', text: big }), json: null })),
      { line: counts('recall', NOW + 5000, { toasts: 4000 }), json: null },
    ]
    const kept = trimEntries(entries)
    expect(serialize(kept).length).toBeLessThanOrEqual(MAX_FILE_BYTES)
    expect(kept[0]?.line).toMatchObject({ kind: 'seen' })
    expect(kept[kept.length - 1]?.line).toMatchObject({ t: 'counts' })
    const firstToast = kept.find(entry => entry.line.t === 'event' && entry.line.kind === 'toast')
    expect(firstToast?.line.ts).toBeGreaterThan(NOW + 1000)
    const small = entries.slice(0, 3)
    expect(trimEntries(small)).toEqual(small)
  })
})

describe('ranges', () => {
  test('hours and days, with a fallback', () => {
    expect(rangeOf('24h', '7d')).toEqual({ label: '24h', ms: DAY })
    expect(rangeOf(' 30D ', '7d')).toEqual({ label: '30d', ms: 30 * DAY })
    expect(rangeOf(undefined, '7d')).toEqual({ label: '7d', ms: 7 * DAY })
    expect(rangeOf('', '7d')).toEqual({ label: '7d', ms: 7 * DAY })
    expect(rangeOf('week', '7d')).toBeNull()
    expect(rangeOf('0d', '7d')).toBeNull()
    expect(rangeOf('400d', '7d')).toBeNull()
  })

  test('the day folders a range touches', () => {
    expect(daysBetween(NOW - 2 * DAY, NOW)).toEqual([dayOf(NOW - 2 * DAY), dayOf(NOW - DAY), dayOf(NOW)])
    expect(daysBetween(NOW - 60_000, NOW)).toEqual([dayOf(NOW)])
    expect(daysBetween(NOW + DAY, NOW)).toEqual([dayOf(NOW)])
  })
})
