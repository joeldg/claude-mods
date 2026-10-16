import { expect, test } from 'claude-code/testing'

import {
  buildSummary,
  capEstimate,
  describeUsage,
  effectiveOf,
  formatAgo,
  formatClock,
  formatDay,
  formatHours,
  formatTokens,
  hitMessage,
  isSameSummary,
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
} from '../hooks/meter'
import type { ApiReading, Hit, Summary, TurnLine, UsageSettings } from '../types'

const LA = 'America/Los_Angeles'
const MINUTE = 60_000
const HOUR = 3_600_000
const WINDOW = 5 * HOUR
/** 2026-09-10 22:58:29.977Z: when a real hit was logged, its message `You've hit your session limit · resets 5:30pm (America/Los_Angeles)`. */
const HIT_AT = Date.UTC(2026, 8, 10, 22, 58, 29, 977)
/** 2026-09-11 00:30Z, 5:30pm PDT: the reset the API stamped on that row (quotaLimits.resetsAt 1789086600). */
const RESET = 1_789_086_600_000
const SETTINGS: UsageSettings = { windowHours: 5, refreshSeconds: 30, warnAt: 80 }

/** A turn worth 13,000 effective tokens unless changed. */
const line = (ts: number, changes: Partial<TurnLine> = {}): TurnLine => ({ ts, in: 1000, cr: 50_000, cw: 3000, out: 200, sub: false, ...changes })
const hit = (effectiveAtHit: number, changes: Partial<Hit> = {}): Hit => ({ at: HIT_AT, resetAt: RESET, effectiveAtHit, zone: LA, ...changes })
const summary = (changes: Partial<Summary> = {}): Summary => ({
  ts: HIT_AT,
  windowMs: WINDOW,
  sessions: 1,
  tokens: { input: 1000, cacheRead: 50_000, cacheWrite: 3000, output: 200 },
  effective: 13_000,
  capEstimate: null,
  pct: null,
  lastHitAt: null,
  nextResetAt: null,
  ...changes,
})

test('effectiveOf weighs the four counts: input + 0.1 cache read + 2 cache write + 5 output, whole', () => {
  expect(effectiveOf({ in: 1000, cr: 50_000, cw: 3000, out: 200 })).toBe(13_000)
  expect(effectiveOf({ in: 0, cr: 0, cw: 0, out: 0 })).toBe(0)
  expect(effectiveOf({ in: 1, cr: 5, cw: 0, out: 0 })).toBe(2)
})

test('turnLine and parseTurns round-trip a file; a bad line is skipped', () => {
  const api = line(HIT_AT + MINUTE, { sub: true, u: 58.5, r: RESET })
  const text = `${turnLine(line(HIT_AT))}\n${turnLine(api)}\n`
  expect(text).toBe(
    `{"ts":${HIT_AT},"in":1000,"cr":50000,"cw":3000,"out":200,"sub":false}\n` +
      `{"ts":${HIT_AT + MINUTE},"in":1000,"cr":50000,"cw":3000,"out":200,"sub":true,"u":58.5,"r":${RESET}}\n`,
  )
  expect(parseTurns(text)).toEqual([line(HIT_AT), api])
  expect(parseTurns(`not json\n${turnLine(line(1))}\n{"ts":"x","in":1}\n[1,2]\n\n{"ts":2,"in":1,"cr":2,"cw":3,"out":4}\n`)).toEqual([
    line(1),
    { ts: 2, in: 1, cr: 2, cw: 3, out: 4, sub: false },
  ])
  expect(parseTurns('')).toEqual([])
})

test('pruneTurns keeps the turns after `since`, the boundary dropped', () => {
  const turns = [line(0), line(10), line(11), line(20)]
  expect(pruneTurns(turns, 10)).toEqual([line(11), line(20)])
  expect(pruneTurns(turns, 30)).toEqual([])
})

test('sumWindow adds every session inside the window, drops the rest, and finds the newest API reading', () => {
  const now = HIT_AT
  const files = [
    { id: 'sess-a', turns: [line(now - WINDOW), line(now - 4 * HOUR), line(now - MINUTE, { sub: true, in: 500, cr: 20_000, cw: 1000, out: 100 })] },
    { id: 'sess-b', turns: [line(now - 2 * HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400, u: 40, r: RESET }), line(now - HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400, u: 58.5 })] },
    { id: 'sess-c', turns: [line(now - 6 * HOUR, { u: 90, r: RESET - HOUR })] },
  ]
  const window = sumWindow(files, now, WINDOW)
  expect(window.totals).toEqual({ input: 5500, cacheRead: 110_000, cacheWrite: 6000, output: 1100 })
  expect(window.effective).toBe(34_000)
  expect(window.sessions).toEqual([
    { id: 'sess-a', turns: 2, subTurns: 1, effective: 18_000 },
    { id: 'sess-b', turns: 2, subTurns: 0, effective: 16_000 },
  ])
  expect(window.api).toEqual({ ts: now - HOUR, percentUsed: 58.5, resetsAt: null, sessionId: 'sess-b' })
  expect(sumWindow([], now, WINDOW)).toEqual({ totals: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, effective: 0, sessions: [], api: null })
})

test('parseLimit reads the clock time and the zone out of the limit message, in its spellings', () => {
  expect(parseLimit("You've hit your session limit · resets 5:30pm (America/Los_Angeles)")).toEqual({ hour: 17, minute: 30, zone: LA })
  expect(parseLimit("You've hit your session limit • resets 10:30am (America/Los_Angeles)")).toEqual({ hour: 10, minute: 30, zone: LA })
  expect(parseLimit("You've hit your session limit · resets 12:20am (America/Los_Angeles)")).toEqual({ hour: 0, minute: 20, zone: LA })
  expect(parseLimit("You've hit your usage limit. Resets at 3pm.")).toEqual({ hour: 15, minute: 0, zone: null })
  expect(parseLimit('API Error: 429 You have hit your usage limit · resets 12pm')).toEqual({ hour: 12, minute: 0, zone: null })
  expect(parseLimit('Rate limit reached for requests')).toBeNull()
  expect(parseLimit("You've hit your weekly limit · resets Oct 20, 10:30am (America/Los_Angeles)")).toBeNull()
  expect(parseLimit("You've hit your session limit")).toBeNull()
})

test('nextClockTime is the next occurrence of the clock time in the zone, DST and day rollover included', () => {
  expect(nextClockTime(HIT_AT, 17, 30, LA)).toBe(RESET)
  // A real hit at 2026-09-11 04:46:34Z, `resets 10:30pm`: the API stamped 1789104600.
  expect(nextClockTime(Date.UTC(2026, 8, 11, 4, 46, 34, 883), 22, 30, LA)).toBe(1_789_104_600_000)
  // 10:40pm PDT, `resets 10:30pm`: tomorrow's.
  expect(nextClockTime(Date.UTC(2026, 8, 11, 5, 40), 22, 30, LA)).toBe(Date.UTC(2026, 8, 12, 5, 30))
  // Exactly the clock time is not after now: tomorrow's.
  expect(nextClockTime(RESET, 17, 30, LA)).toBe(RESET + 24 * HOUR)
  expect(nextClockTime(RESET, 1, 0, 'UTC')).toBe(RESET + 30 * MINUTE)
  // Across the end of daylight time (2026-11-01 09:00Z): midnight PDT to 10am PST is eleven hours, not ten.
  expect(nextClockTime(Date.UTC(2026, 10, 1, 7, 0), 10, 0, LA)).toBe(Date.UTC(2026, 10, 1, 18, 0))
  // No zone, or one Intl does not know: the local zone.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  expect(nextClockTime(HIT_AT, 17, 30, null)).toBe(nextClockTime(HIT_AT, 17, 30, local))
  expect(nextClockTime(HIT_AT, 17, 30, 'Not/AZone')).toBe(nextClockTime(HIT_AT, 17, 30, local))
})

test('formatClock, formatDay and formatAgo say times the way the limit message does', () => {
  expect(formatClock(RESET, LA)).toBe('5:30pm')
  expect(formatClock(Date.UTC(2026, 8, 11, 5, 30), LA)).toBe('10:30pm')
  expect(formatClock(RESET, 'UTC')).toBe('12:30am')
  expect(formatClock(RESET, 'Not/AZone')).toBe(formatClock(RESET, Intl.DateTimeFormat().resolvedOptions().timeZone))
  expect(formatDay(HIT_AT, LA)).toBe('Sep 10 3:58pm')
  expect(formatAgo(5_000)).toBe('5s ago')
  expect(formatAgo(2 * MINUTE + 5_000)).toBe('2m ago')
  expect(formatAgo(65 * MINUTE)).toBe('1h05m ago')
})

test('formatTokens and formatHours are short: 12.4M, 812K, 950; 5h, 2.5h, 30m', () => {
  expect(formatTokens(12_400_000)).toBe('12.4M')
  expect(formatTokens(999_500)).toBe('1.0M')
  expect(formatTokens(812_000)).toBe('812K')
  expect(formatTokens(13_000)).toBe('13K')
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(0)).toBe('0')
  expect(formatHours(5 * HOUR)).toBe('5h')
  expect(formatHours(2.5 * HOUR)).toBe('2.5h')
  expect(formatHours(30 * MINUTE)).toBe('30m')
})

test('capEstimate is the median effective of the last three hits, null without one', () => {
  expect(capEstimate([])).toBeNull()
  expect(capEstimate([hit(10_000_000)])).toBe(10_000_000)
  expect(capEstimate([hit(10_000_000), hit(20_000_000)])).toBe(15_000_000)
  expect(capEstimate([hit(10_000_000), hit(12_000_000), hit(20_000_000)])).toBe(12_000_000)
  expect(capEstimate([hit(1_000_000), hit(10_000_000), hit(20_000_000), hit(12_000_000)])).toBe(12_000_000)
})

test('withHit adds a hit once per reset time and keeps the last twenty; parseHits is tolerant', () => {
  const first = hit(14_100_000)
  expect(withHit([], first, 20)).toEqual({ hits: [first], isNew: true })
  const again = hit(13_000_000, { at: HIT_AT + 20 * MINUTE })
  expect(withHit([first], again, 20)).toEqual({ hits: [first], isNew: false })
  const many = Array.from({ length: 20 }, (_, i) => hit(1_000_000 + i, { resetAt: RESET - (20 - i) * 5 * HOUR }))
  const kept = withHit(many, first, 20)
  expect(kept.isNew).toBe(true)
  expect(kept.hits).toHaveLength(20)
  expect(kept.hits[0]).toEqual(many[1])
  expect(kept.hits[19]).toEqual(first)
  expect(parseHits(null)).toEqual([])
  expect(parseHits('nonsense')).toEqual([])
  expect(parseHits('{"hits":1}')).toEqual([])
  expect(parseHits(`[${JSON.stringify(first)}, {"at":1}, 3]\n`)).toEqual([first])
  expect(parseHits(JSON.stringify([{ at: 1, resetAt: 2, effectiveAtHit: 3 }]))).toEqual([{ at: 1, resetAt: 2, effectiveAtHit: 3, zone: null }])
})

test('buildSummary is the contract, field for field and in order; isSameSummary ignores ts', () => {
  const now = HIT_AT + MINUTE
  const window = sumWindow([{ id: 'sess-a', turns: [line(HIT_AT)] }], now, WINDOW)
  const bare = buildSummary(window, [], now, WINDOW)
  expect(bare).toEqual(summary({ ts: now }))
  expect(Object.keys(bare)).toEqual(['ts', 'windowMs', 'sessions', 'tokens', 'effective', 'capEstimate', 'pct', 'lastHitAt', 'nextResetAt'])
  expect(Object.keys(bare.tokens)).toEqual(['input', 'cacheRead', 'cacheWrite', 'output'])

  const hits = [hit(20_000, { at: HIT_AT - 10 * HOUR, resetAt: RESET - 10 * HOUR }), hit(16_000)]
  expect(buildSummary(window, hits, now, WINDOW)).toEqual(summary({ ts: now, capEstimate: 18_000, pct: 72, lastHitAt: HIT_AT, nextResetAt: RESET }))
  // A reset already past is no next reset.
  expect(buildSummary(window, hits, RESET, WINDOW).nextResetAt).toBeNull()
  expect(isSameSummary(null, bare)).toBe(false)
  expect(isSameSummary(bare, { ...bare, ts: now + MINUTE })).toBe(true)
  expect(isSameSummary(bare, { ...bare, effective: 1 })).toBe(false)
  expect(isSameSummary(bare, { ...bare, tokens: { ...bare.tokens, output: 1 } })).toBe(false)
})

test('shareOf prefers a fresh API reading, then the estimate against the last limit', () => {
  const api: ApiReading = { ts: HIT_AT, percentUsed: 58.5, resetsAt: RESET, sessionId: 'sess-b' }
  expect(shareOf(summary(), null, HIT_AT)).toBeNull()
  expect(shareOf(summary({ capEstimate: 20_000, pct: 65 }), null, HIT_AT)).toEqual({ pct: 65, source: 'estimate' })
  expect(shareOf(summary({ capEstimate: 20_000, pct: 65 }), api, HIT_AT + 15 * MINUTE)).toEqual({ pct: 59, source: 'api' })
  // Older than fifteen minutes, or past its own reset, the reading is stale.
  expect(shareOf(summary({ capEstimate: 20_000, pct: 65 }), api, HIT_AT + 16 * MINUTE)).toEqual({ pct: 65, source: 'estimate' })
  expect(shareOf(summary(), { ...api, ts: RESET - MINUTE }, RESET)).toBeNull()
})

test('statusLine: the effective total, then the share when known, then the reset when ahead', () => {
  const now = HIT_AT
  expect(statusLine(summary({ effective: 12_400_000 }), null, now, WINDOW, LA)).toBe('usage 5h: 12.4M eff')
  expect(statusLine(summary({ effective: 12_400_000, capEstimate: 20_300_000, pct: 61 }), null, now, WINDOW, LA)).toBe('usage 5h: 12.4M eff · 61% of last limit')
  expect(statusLine(summary({ effective: 12_400_000, capEstimate: 20_300_000, pct: 61, lastHitAt: HIT_AT - HOUR, nextResetAt: RESET }), null, now, WINDOW, LA)).toBe(
    'usage 5h: 12.4M eff · 61% of last limit · resets 5:30pm',
  )
  expect(statusLine(summary({ effective: 12_400_000, capEstimate: 20_300_000, pct: 61, nextResetAt: RESET }), null, RESET, WINDOW, LA)).toBe('usage 5h: 12.4M eff · 61% of last limit')
  const api: ApiReading = { ts: now - MINUTE, percentUsed: 58.5, resetsAt: RESET, sessionId: 'sess-b' }
  expect(statusLine(summary({ effective: 12_400_000, capEstimate: 20_300_000, pct: 61 }), api, now, WINDOW, LA)).toBe('usage 5h: 12.4M eff · 59% used · resets 5:30pm')
  // No hit yet: the API's reset time still shows, even once its percentage is stale.
  expect(statusLine(summary({ effective: 13_000 }), api, now + 20 * MINUTE, WINDOW, LA)).toBe('usage 5h: 13K eff · resets 5:30pm')
  expect(statusLine(summary({ effective: 0 }), null, now, 2.5 * HOUR, LA)).toBe('usage 2.5h: 0 eff')
})

test('warnMessage and hitMessage name the share, the window and the reset', () => {
  expect(warnMessage({ pct: 83, source: 'estimate' }, summary({ effective: 10_000_000, capEstimate: 12_000_000, pct: 83 }), null, HIT_AT, WINDOW, LA)).toBe(
    'Usage at 83% of the last session limit · 10.0M of 12.0M eff in the last 5h',
  )
  expect(warnMessage({ pct: 83, source: 'estimate' }, summary({ effective: 10_000_000, capEstimate: 12_000_000, pct: 83, nextResetAt: RESET }), null, HIT_AT, WINDOW, LA)).toBe(
    'Usage at 83% of the last session limit · 10.0M of 12.0M eff in the last 5h · resets 5:30pm',
  )
  const api: ApiReading = { ts: HIT_AT, percentUsed: 85, resetsAt: RESET, sessionId: 'sess-a' }
  expect(warnMessage({ pct: 85, source: 'api' }, summary({ effective: 13_000 }), api, HIT_AT, WINDOW, LA)).toBe(
    'Usage at 85% of the five-hour limit · 13K eff in the last 5h · resets 5:30pm',
  )
  expect(hitMessage(RESET, 14_100_000, WINDOW, LA)).toBe('Session limit hit · resets 5:30pm · 14.1M eff in the last 5h, cap estimate updated')
})

test('describeUsage prints the totals, the estimate, the API reading, the sessions, the hits and the weights', () => {
  const now = HIT_AT + 2 * MINUTE
  const files = [
    { id: 'sess-a', turns: [line(HIT_AT, { u: 58.5, r: RESET }), line(HIT_AT + MINUTE, { sub: true, in: 500, cr: 20_000, cw: 1000, out: 100 })] },
    { id: 'sess-b', turns: [line(HIT_AT - HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 }), line(HIT_AT - 2 * HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 })] },
  ]
  const window = sumWindow(files, now, WINDOW)
  const hits = [hit(30_000)]
  const full = buildSummary(window, hits, now, WINDOW)
  expect(describeUsage(window, full, hits, SETTINGS, now, 'sess-a', LA)).toBe(
    [
      'Usage in the last 5h, all sessions: 34K eff · input 6K · cache read 110K · cache write 6K · output 1K',
      'Estimate: 113% of the last session limit (cap 30K eff from 1 hit) · resets 5:30pm',
      'API five-hour window: 59% used · resets 5:30pm · read 2m ago by session sess-a',
      'Sessions in the window: 2',
      '  sess-a    2 turns (1 by subagents)  18K eff  53%  ← this session',
      '  sess-b    2 turns                   16K eff  47%',
      'Limit hits, newest first (1 kept, 20 at most):',
      '  Sep 10 3:58pm · resets 5:30pm · 30K eff in the window then',
      'Weights: eff = input + 0.1·cache read + 2·cache write + 5·output, an estimate of what the session limit meters; the API line is the limit’s own reading.',
      'Settings: window 5h · refresh every 30s · warn at 80%',
    ].join('\n'),
  )
  const empty = sumWindow([], now, WINDOW)
  expect(describeUsage(empty, buildSummary(empty, [], now, WINDOW), [], SETTINGS, now, 'sess-a', LA)).toBe(
    [
      'Usage in the last 5h, all sessions: 0 eff (no turns counted yet)',
      'Estimate: no limit hit seen yet, so the cap is unknown until the first',
      'API five-hour window: no reading yet',
      'Sessions in the window: 0',
      'Limit hits: none yet',
      'Weights: eff = input + 0.1·cache read + 2·cache write + 5·output, an estimate of what the session limit meters; the API line is the limit’s own reading.',
      'Settings: window 5h · refresh every 30s · warn at 80%',
    ].join('\n'),
  )
})
