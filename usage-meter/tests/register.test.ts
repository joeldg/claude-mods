import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionRateLimit, ToolSpec, TurnUsage } from 'claude-code'

import type { Hit, Summary, TurnLine } from '../types'

const HOME = '/Users/me'
const DIR = `${HOME}/.claude/usage-meter`
const TURNS = `${DIR}/turns`
const HITS = `${DIR}/hits.json`
const SUMMARY = `${DIR}/summary.json`
const TOOL = 'mcp__usage-meter__usage_status'
const LA = 'America/Los_Angeles'
const MINUTE = 60_000
const HOUR = 3_600_000
const WINDOW = 5 * HOUR
/** 2026-09-10 22:58:29.977Z, 3:58pm PDT: a real hit, `resets 5:30pm (America/Los_Angeles)`. */
const HIT_AT = Date.UTC(2026, 8, 10, 22, 58, 29, 977)
/** 2026-09-11 00:30Z, 5:30pm PDT: the reset the API stamped on that row. */
const RESET = 1_789_086_600_000
/** Three hours before the hit, 12:58pm PDT. */
const START = HIT_AT - 3 * HOUR
const LIMIT = "You've hit your session limit · resets 5:30pm (America/Los_Angeles)"
const SLOW = { timeoutMs: 60_000 }

/** A main-loop turn: 13,000 effective tokens. */
const MAIN: TurnUsage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 3000, model: 'claude-opus-5-5' }
/** A subagent's turn: 5,000 effective tokens. */
const SUB: TurnUsage = { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000, model: 'claude-fable-5-1' }

type World = {
  files: Map<string, { text: string; mtimeMs: number }>
  /** Every path written, in order. */
  writes: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  tools: ToolSpec[]
  commands: string[]
  sessionId: string
  /** What `$.session.usage()` reports of the account's windows. */
  rateLimits: SessionRateLimit[]
  uuid: number
}

/** Answers the host beneath the plugin: HOME, the files, the session, the API's windows, toasts and the status line. */
const world = (on: On, clock: MockClock, env: Record<string, string> = { HOME }): World => {
  const w: World = { files: new Map(), writes: [], toasts: [], statuses: [], tools: [], commands: [], sessionId: 'sess-a', rateLimits: [], uuid: 0 }
  mock.env(on, env)
  mock.session(on)
  on('fs.read', (_$, e) => {
    const file = w.files.get(e.path)
    return file === undefined ? { deny: `ENOENT: no such file, ${e.path}` } : { value: file.text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: clock.now() })
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const dir = (e.path ?? '').replace(/\/+$/, '')
    const inside = [...w.files].filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
    if (inside.length === 0) {
      return { deny: `ENOENT: no such directory, ${e.path}` }
    }
    return { value: inside.map(([path, file]) => ({ name: path.slice(dir.length + 1), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })) }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: w.rateLimits } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__usage-meter__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return w
}

const begin = ($: Engine) => $.session.start({ cwd: '/home/dev/app', surface: 'terminal', isInteractive: true })

const turn = ($: Engine, usage: TurnUsage | undefined, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage, agentId })

const errorTurn = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't2', reason: 'error' })

/** A row of the conversation as the engine appends it: the API error's stand-in, or any other text row. */
const row = ($: Engine, w: World, text: string, type: 'assistant' | 'user' = 'assistant') =>
  $.session.append({
    message: { type, role: type, content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: type === 'assistant' ? '<synthetic>' : 'claude-opus-5-5' },
    uuid: `u${++w.uuid}`,
  })

/** A slash command as the person types it. */
const typed = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const line = (ts: number, changes: Partial<TurnLine> = {}): TurnLine => ({ ts, in: 1000, cr: 50_000, cw: 3000, out: 200, sub: false, ...changes })

/** Another session's turns file, as that session last wrote it. */
const seed = (w: World, id: string, turns: TurnLine[], mtimeMs: number) =>
  w.files.set(`${TURNS}/${id}.jsonl`, { text: turns.map(t => JSON.stringify(t)).join('\n') + '\n', mtimeMs })

const turnsOf = (w: World, id: string): TurnLine[] | undefined =>
  w.files
    .get(`${TURNS}/${id}.jsonl`)
    ?.text.trim()
    .split('\n')
    .map(l => JSON.parse(l) as TurnLine)

const hitsOf = (w: World): Hit[] | undefined => {
  const file = w.files.get(HITS)
  return file === undefined ? undefined : (JSON.parse(file.text) as Hit[])
}

const summaryOf = (w: World): Summary => JSON.parse(w.files.get(SUMMARY)?.text ?? 'null') as Summary

const writesTo = (w: World, path: string): number => w.writes.filter(p => p === path).length

test('every turn is counted into this session’s file, a subagent’s flagged, one without usage not; the status and the summary follow', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  await begin($)
  expect(w.commands).toEqual(['meter'])
  expect(w.tools).toHaveLength(1)
  expect(w.tools[0]).toMatchObject({ name: 'usage_status', isDeferred: false, inputSchema: { type: 'object', properties: {} } })
  expect(w.tools[0]?.description).toContain('before fanning out subagents')
  expect(w.statuses.at(-1)).toBe('usage 5h: 0 eff')

  await turn($, MAIN)
  await clock.advance(MINUTE)
  await turn($, SUB, 'agent_1')
  await errorTurn($, 'API Error: 500 Internal server error')
  expect(turnsOf(w, 'sess-a')).toEqual([
    { ts: START, in: 1000, cr: 50_000, cw: 3000, out: 200, sub: false },
    { ts: START + MINUTE, in: 500, cr: 20_000, cw: 1000, out: 100, sub: true },
  ])
  expect(w.statuses.at(-1)).toBe('usage 5h: 18K eff')
  const summary = summaryOf(w)
  expect(summary).toEqual({
    ts: START + MINUTE,
    windowMs: WINDOW,
    sessions: 1,
    tokens: { input: 1500, cacheRead: 70_000, cacheWrite: 4000, output: 300 },
    effective: 18_000,
    capEstimate: null,
    pct: null,
    lastHitAt: null,
    nextResetAt: null,
  })
  expect(Object.keys(summary)).toEqual(['ts', 'windowMs', 'sessions', 'tokens', 'effective', 'capEstimate', 'pct', 'lastHitAt', 'nextResetAt'])
  expect(Object.keys(summary.tokens)).toEqual(['input', 'cacheRead', 'cacheWrite', 'output'])
  expect(w.toasts).toEqual([])
})

test('the API’s five-hour reading rides on the turn line and leads the status line while fresh', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  w.rateLimits = [
    { kind: 'five_hour', percentUsed: 58.5, resetsAt: new Date(RESET).toISOString() },
    { kind: 'seven_day', percentUsed: 12 },
  ]
  await begin($)
  await turn($, MAIN)
  expect(turnsOf(w, 'sess-a')).toEqual([{ ts: START, in: 1000, cr: 50_000, cw: 3000, out: 200, sub: false, u: 58.5, r: RESET }])
  expect(w.statuses.at(-1)).toBe('usage 5h: 13K eff · 59% used · resets 5:30pm')
  // Sixteen minutes on with no turn anywhere: the percentage is stale, the reset still ahead.
  await clock.advance(16 * MINUTE)
  expect(w.statuses.at(-1)).toBe('usage 5h: 13K eff · resets 5:30pm')
  // The contract carries the estimate's fields alone.
  expect(summaryOf(w)).toMatchObject({ effective: 13_000, capEstimate: null, pct: null, nextResetAt: null })
})

test('the window sums every session’s turns and drops records older than the window', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  seed(w, 'sess-b', [line(START - 6 * HOUR), line(START - 4 * HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 }), line(START - HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 })], START - HOUR)
  // Idle for longer than the window: not even read.
  seed(w, 'sess-c', [line(START - WINDOW - MINUTE)], START - WINDOW - MINUTE)
  // A file at the boundary itself holds nothing inside the window.
  seed(w, 'sess-d', [line(START - WINDOW)], START - WINDOW + MINUTE)
  w.files.set(`${TURNS}/notes.txt`, { text: 'not a turns file', mtimeMs: START })
  await begin($)
  await turn($, MAIN)
  expect(summaryOf(w)).toEqual({
    ts: START,
    windowMs: WINDOW,
    sessions: 2,
    tokens: { input: 5000, cacheRead: 90_000, cacheWrite: 5000, output: 1000 },
    effective: 29_000,
    capEstimate: null,
    pct: null,
    lastHitAt: null,
    nextResetAt: null,
  })
  expect(w.statuses.at(-1)).toBe('usage 5h: 29K eff')
  const text = (await $.command.run(typed('meter'))).text ?? ''
  expect(text).toContain('Sessions in the window: 2')
  expect(text).toContain('sess-b')
  expect(text).not.toContain('sess-c')
  expect(text).not.toContain('sess-d')
})

test('the ticker refreshes every refreshSeconds and writes summary.json only when the figures changed', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  await begin($)
  expect(writesTo(w, SUMMARY)).toBe(1)
  await clock.advance(30_000)
  expect(writesTo(w, SUMMARY)).toBe(1)
  // Another session turns: the next tick shows it.
  seed(w, 'sess-b', [line(clock.now())], clock.now())
  await clock.advance(29_000)
  expect(w.statuses.at(-1)).toBe('usage 5h: 0 eff')
  await clock.advance(1_000)
  expect(w.statuses.at(-1)).toBe('usage 5h: 13K eff')
  expect(writesTo(w, SUMMARY)).toBe(2)
  expect(summaryOf(w)).toMatchObject({ ts: START + MINUTE, sessions: 1, effective: 13_000 })
  await clock.advance(5 * MINUTE)
  expect(writesTo(w, SUMMARY)).toBe(2)
})

test('a limit message learns a hit and the cap, toasts once whichever hook hears it, and the summary carries the hit', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: HIT_AT })
  const w = world(on, clock)
  seed(w, 'sess-b', [line(HIT_AT - HOUR, { in: 14_100_000, cr: 0, cw: 0, out: 0 })], HIT_AT - HOUR)
  await begin($)
  expect(w.statuses.at(-1)).toBe('usage 5h: 14.1M eff')

  await row($, w, LIMIT)
  expect(hitsOf(w)).toEqual([{ at: HIT_AT, resetAt: RESET, effectiveAtHit: 14_100_000, zone: LA }])
  expect(w.toasts).toEqual(['Session limit hit · resets 5:30pm · 14.1M eff in the last 5h, cap estimate updated'])
  expect(summaryOf(w)).toMatchObject({ ts: HIT_AT, effective: 14_100_000, capEstimate: 14_100_000, pct: 100, lastHitAt: HIT_AT, nextResetAt: RESET })
  expect(w.statuses.at(-1)).toBe('usage 5h: 14.1M eff · 100% of last limit · resets 5:30pm')

  // The same hit by the classic hook and by the turn's end: counted once.
  await $.classic.StopFailure({ error: 'rate_limit', error_details: LIMIT })
  await errorTurn($, LIMIT)
  await row($, w, LIMIT)
  expect(hitsOf(w)).toHaveLength(1)
  expect(w.toasts).toHaveLength(1)

  // Past the reset the next reset is gone; the rolling estimate still holds the window's turns.
  await clock.advance(RESET - HIT_AT + MINUTE)
  expect(w.statuses.at(-1)).toBe('usage 5h: 14.1M eff · 100% of last limit')
  expect(summaryOf(w)).toMatchObject({ lastHitAt: HIT_AT, nextResetAt: null })

  // The next window's hit is a new one, and the cap is the median of both.
  seed(w, 'sess-b', [line(HIT_AT - HOUR, { in: 14_100_000, cr: 0, cw: 0, out: 0 }), line(clock.now() - MINUTE, { in: 10_000_000, cr: 0, cw: 0, out: 0 })], clock.now() - MINUTE)
  await clock.advance(30_000)
  await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your session limit · resets 10:30pm (America/Los_Angeles)" })
  expect(hitsOf(w)).toHaveLength(2)
  expect(hitsOf(w)?.[1]).toMatchObject({ resetAt: Date.UTC(2026, 8, 11, 5, 30), effectiveAtHit: 24_100_000, zone: LA })
  expect(w.toasts).toHaveLength(2)
  expect(summaryOf(w)).toMatchObject({ capEstimate: 19_100_000, pct: 126, nextResetAt: Date.UTC(2026, 8, 11, 5, 30) })
})

test('a hit another session already counted is not recorded twice, but this session is still told', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: HIT_AT })
  const w = world(on, clock)
  const earlier: Hit = { at: HIT_AT - 10 * MINUTE, resetAt: RESET, effectiveAtHit: 13_000_000, zone: LA }
  w.files.set(HITS, { text: `${JSON.stringify([earlier])}\n`, mtimeMs: HIT_AT - 10 * MINUTE })
  await begin($)
  await turn($, MAIN)
  await row($, w, LIMIT)
  expect(hitsOf(w)).toEqual([earlier])
  expect(w.toasts).toEqual(['Session limit hit · resets 5:30pm · 13K eff in the last 5h, cap estimate updated'])
  expect(summaryOf(w)).toMatchObject({ capEstimate: 13_000_000, pct: 0, lastHitAt: HIT_AT - 10 * MINUTE, nextResetAt: RESET })
})

test('a limit message quoted inside an answer, or in a user row, or without a reset time, is no hit', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: HIT_AT })
  const w = world(on, clock)
  await begin($)
  await row($, w, `The transcript shows the error \`${LIMIT}\` after the last tool call.`)
  await row($, w, LIMIT, 'user')
  await row($, w, "You've hit your session limit")
  await $.classic.StopFailure({ error: 'rate_limit', error_details: 'Rate limit reached for requests' })
  await $.classic.StopFailure({ error: 'server_error', error_details: LIMIT })
  expect(hitsOf(w)).toBeUndefined()
  expect(w.toasts).toEqual([])
})

test('the warn toast fires once when the share first crosses warnAt and arms again once it falls below', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  const old = (effectiveAtHit: number, i: number): Hit => ({ at: START - (i + 1) * 6 * HOUR, resetAt: START - (i + 1) * 6 * HOUR + HOUR, effectiveAtHit, zone: LA })
  w.files.set(HITS, { text: `${JSON.stringify([old(10_000_000, 2), old(20_000_000, 1), old(12_000_000, 0)])}\n`, mtimeMs: START - 5 * HOUR })
  seed(w, 'sess-b', [line(START - HOUR, { in: 9_000_000, cr: 0, cw: 0, out: 0 })], START - HOUR)
  await begin($)
  expect(w.statuses.at(-1)).toBe('usage 5h: 9.0M eff · 75% of last limit')
  expect(w.toasts).toEqual([])

  await turn($, { ...MAIN, input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 })
  expect(w.statuses.at(-1)).toBe('usage 5h: 10.0M eff · 83% of last limit')
  expect(w.toasts).toEqual(['Usage at 83% of the last session limit · 10.0M of 12.0M eff in the last 5h'])
  await turn($, { ...MAIN, input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 })
  expect(w.toasts).toHaveLength(1)

  // Four hours on the other session's turn has left the window: below the threshold, armed again.
  await clock.advance(4 * HOUR + MINUTE)
  expect(w.statuses.at(-1)).toBe('usage 5h: 1.1M eff · 9% of last limit')
  expect(w.toasts).toHaveLength(1)
  seed(w, 'sess-b', [line(clock.now(), { in: 11_000_000, cr: 0, cw: 0, out: 0 })], clock.now())
  await clock.advance(30_000)
  expect(w.statuses.at(-1)).toBe('usage 5h: 12.1M eff · 101% of last limit')
  expect(w.toasts).toEqual([
    'Usage at 83% of the last session limit · 10.0M of 12.0M eff in the last 5h',
    'Usage at 101% of the last session limit · 12.1M of 12.0M eff in the last 5h',
  ])
})

test('a fresh API reading over warnAt warns too, once, and a hit stands in for the warning', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: HIT_AT - HOUR })
  const w = world(on, clock)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 85, resetsAt: new Date(RESET).toISOString() }]
  await begin($)
  await turn($, MAIN)
  expect(w.toasts).toEqual(['Usage at 85% of the five-hour limit · 13K eff in the last 5h · resets 5:30pm'])
  await turn($, MAIN)
  expect(w.toasts).toHaveLength(1)
  // The hit itself is the next word: no warn toast beside it.
  await clock.advance(HOUR)
  await row($, w, LIMIT)
  expect(w.toasts).toEqual([
    'Usage at 85% of the five-hour limit · 13K eff in the last 5h · resets 5:30pm',
    'Session limit hit · resets 5:30pm · 26K eff in the last 5h, cap estimate updated',
  ])
})

test('about once an hour this session’s file is rewritten without the lines older than the window', { options: { windowHours: 1 }, ...SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  await begin($)
  await turn($, MAIN)
  await clock.advance(30 * MINUTE)
  await turn($, SUB)
  expect(turnsOf(w, 'sess-a')).toHaveLength(2)
  // 61 minutes in: the first line is past the one-hour window, and the hourly rewrite is due.
  await clock.advance(31 * MINUTE)
  await turn($, MAIN)
  expect(turnsOf(w, 'sess-a')).toEqual([
    { ts: START + 30 * MINUTE, in: 500, cr: 20_000, cw: 1000, out: 100, sub: false },
    { ts: START + 61 * MINUTE, in: 1000, cr: 50_000, cw: 3000, out: 200, sub: false },
  ])
  expect(w.statuses.at(-1)).toBe('usage 1h: 18K eff')
  expect(summaryOf(w)).toMatchObject({ windowMs: HOUR, effective: 18_000 })
})

test('a reload reads this session’s file back before adding to it', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  seed(w, 'sess-a', [line(START - MINUTE)], START - MINUTE)
  await begin($)
  await turn($, SUB)
  expect(turnsOf(w, 'sess-a')).toEqual([line(START - MINUTE), { ts: START, in: 500, cr: 20_000, cw: 1000, out: 100, sub: false }])
})

test('/meter prints the totals, the estimate, the API reading, the sessions, the hits and the weights; usage_status answers the same without a prompt', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: HIT_AT })
  const w = world(on, clock)
  seed(w, 'sess-b', [line(HIT_AT - 2 * HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 }), line(HIT_AT - HOUR, { in: 2000, cr: 20_000, cw: 1000, out: 400 })], HIT_AT - HOUR)
  w.files.set(HITS, { text: `${JSON.stringify([{ at: HIT_AT - HOUR, resetAt: RESET, effectiveAtHit: 30_000, zone: LA }])}\n`, mtimeMs: HIT_AT - HOUR })
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 58.5, resetsAt: new Date(RESET).toISOString() }]
  await begin($)
  await turn($, MAIN)
  w.rateLimits = []
  await clock.advance(MINUTE)
  await turn($, SUB, 'agent_1')
  await clock.advance(MINUTE)
  const expected = [
    'Usage in the last 5h, all sessions: 34K eff · input 6K · cache read 110K · cache write 6K · output 1K',
    'Estimate: 113% of the last session limit (cap 30K eff from 1 hit) · resets 5:30pm',
    'API five-hour window: 59% used · resets 5:30pm · read 2m ago by session sess-a',
    'Sessions in the window: 2',
    '  sess-a    2 turns (1 by subagents)  18K eff  53%  ← this session',
    '  sess-b    2 turns                   16K eff  47%',
    'Limit hits, newest first (1 kept, 20 at most):',
    '  Sep 10 2:58pm · resets 5:30pm · 30K eff in the window then',
    'Weights: eff = input + 0.1·cache read + 2·cache write + 5·output, an estimate of what the session limit meters; the API line is the limit’s own reading.',
    'Settings: window 5h · refresh every 30s · warn at 80%',
  ].join('\n')
  expect((await $.command.run(typed('meter'))).text).toBe(expected)
  expect(await $.tool.check({ tool: TOOL, input: {} })).toMatchObject({ decision: 'allow' })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
  expect(String((await $.tool.call({ tool: TOOL })).result)).toBe(expected)
  // The API's fresh reading leads: no warning from the estimate, and the status line shows the reading.
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBe('usage 5h: 34K eff · 59% used · resets 5:30pm')
})

test('windowHours, refreshSeconds and warnAt set the window, the pace and the threshold', { options: { windowHours: 2, refreshSeconds: 10, warnAt: 50 }, ...SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  w.files.set(HITS, { text: `${JSON.stringify([{ at: START - 3 * HOUR, resetAt: START - 2 * HOUR, effectiveAtHit: 20_000, zone: LA }])}\n`, mtimeMs: START - 3 * HOUR })
  seed(w, 'sess-b', [line(START - 3 * HOUR), line(START - 90 * MINUTE)], START - 90 * MINUTE)
  await begin($)
  expect(w.statuses.at(-1)).toBe('usage 2h: 13K eff · 65% of last limit')
  expect(w.toasts).toEqual(['Usage at 65% of the last session limit · 13K of 20K eff in the last 2h'])
  expect(summaryOf(w)).toMatchObject({ windowMs: 2 * HOUR, sessions: 1, effective: 13_000, capEstimate: 20_000, pct: 65 })
  seed(w, 'sess-c', [line(clock.now())], clock.now())
  await clock.advance(10_000)
  expect(w.statuses.at(-1)).toBe('usage 2h: 26K eff · 130% of last limit')
  expect((await $.command.run(typed('meter'))).text).toContain('Settings: window 2h · refresh every 10s · warn at 50%')
})

test('the session’s end stops the ticker and clears the status; the files stay for the other sessions', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock)
  await begin($)
  await turn($, MAIN)
  expect(w.statuses.at(-1)).toBe('usage 5h: 13K eff')
  await $.session.end({ reason: 'other', sessionId: 'sess-a', resume: { id: 'sess-a' } })
  expect(w.statuses.at(-1)).toBeUndefined()
  const shown = w.statuses.length
  const written = w.writes.length
  await clock.advance(5 * MINUTE)
  expect(w.statuses).toHaveLength(shown)
  expect(w.writes).toHaveLength(written)
  expect(turnsOf(w, 'sess-a')).toHaveLength(1)
})

test('without HOME nothing is written and nothing shown', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, clock, {})
  await begin($)
  await turn($, MAIN)
  await clock.advance(MINUTE)
  expect(w.writes).toEqual([])
  expect(w.statuses).toEqual([])
  expect((await $.command.run(typed('meter'))).text).toBe('usage-meter: HOME is not set, so there is nowhere to keep the turns.')
})
