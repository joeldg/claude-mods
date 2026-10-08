import type { CountsLine, EventLine, Line } from '../types'

/** Noon UTC: the same local day across the usual time zones. */
export const NOW = Date.UTC(2026, 9, 7, 12, 0)
export const DAY = 86_400_000

export const counts = (plugin: string, ts: number, fields: Partial<CountsLine>): CountsLine => ({
  t: 'counts',
  ts,
  plugin,
  runs: {},
  procs: 0,
  procFails: 0,
  writes: 0,
  toasts: 0,
  models: 0,
  slow: {},
  fails: 0,
  cmds: 0,
  tools: 0,
  ...fields,
})

type EventFields = EventLine extends infer L ? (L extends EventLine ? Omit<L, 't' | 'ts' | 'plugin'> : never) : never

export const event = (plugin: string, ts: number, fields: EventFields): EventLine => ({ t: 'event', ts, plugin, ...fields }) as EventLine

/** A past session, as a day file holds it. */
export type PastSession = { session: string; ts: number; lines: Line[] }

const A = NOW - 2 * DAY
const B = NOW - 5 * DAY
const OLD = NOW - 10 * DAY

/** Two sessions in the last week, on different days, and one older. */
export const PAST: PastSession[] = [
  {
    session: 'aaaa1111',
    ts: A,
    lines: [
      event('recall', A, { kind: 'seen', via: 'plugin.register', tier: 'user', version: '0.1.0' }),
      event('pr-autopilot', A, { kind: 'seen', via: 'plugin.register', tier: 'user' }),
      event('job-watch', A, { kind: 'seen', via: 'command.register' }),
      event('recall', A + 1_000, { kind: 'slow', event: 'session.start', ms: 2400 }),
      event('recall', A + 60_000, { kind: 'toast', text: 'Indexed 40 new extracts', n: 2, last: A + 90_000 }),
      event('recall', A + 120_000, { kind: 'toast', text: 'Index is 3 days old' }),
      event('recall', A + 130_000, { kind: 'command', command: 'recall', hasArgs: true, by: 'composer' }),
      event('recall', A + 140_000, { kind: 'command', command: 'recall', hasArgs: false, by: 'composer' }),
      event('recall', A + 150_000, {
        kind: 'proc-fail',
        cmd: 'python3 recall.py',
        exit: 1,
        ms: 800,
        err: 'Traceback (most recent call last):',
        n: 2,
        last: A + 155_000,
      }),
      event('recall', A + 160_000, { kind: 'failure', event: 'tool.call', outcome: 'skipped', ms: 12, what: 'threw' }),
      event('recall', A + 170_000, {
        kind: 'model',
        model: 'haiku',
        outcome: 'answered',
        ms: 900,
        usage: { in: 1000, out: 50, cacheRead: 0, cacheWrite: 0 },
      }),
      event('pr-autopilot', A + 180_000, { kind: 'toast', text: '#219 merged → main' }),
      counts('recall', A + 200_000, {
        runs: { 'session.start': 1, 'prompt.submit': 12, 'tool.call': 30 },
        procs: 5,
        procFails: 2,
        writes: 1,
        toasts: 3,
        models: 1,
        slow: { 'session.start': { n: 1, max: 2400, p95: 2400 } },
        fails: 1,
        cmds: 2,
        tools: 4,
      }),
      counts('pr-autopilot', A + 200_000, { runs: { 'session.start': 1, 'turn.complete': 5 }, procs: 10, toasts: 1 }),
    ],
  },
  {
    session: 'bbbb2222',
    ts: B,
    lines: [
      event('recall', B, { kind: 'seen', via: 'plugin.register' }),
      event('recall', B + 10_000, { kind: 'toast', text: 'Indexed 40 new extracts' }),
      event('recall', B + 20_000, { kind: 'toast', text: 'Recall is ready', n: 2, last: B + 25_000 }),
      event('recall', B + 30_000, { kind: 'command', command: 'recall', hasArgs: true, by: 'composer' }),
      event('recall', B + 40_000, {
        kind: 'model',
        model: 'haiku',
        outcome: 'api-error 429 rate_limit',
        ms: 300,
        usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      counts('recall', B + 50_000, { runs: { 'session.start': 1, 'prompt.submit': 4 }, toasts: 3, models: 1, cmds: 1 }),
    ],
  },
  {
    session: 'cccc3333',
    ts: OLD,
    lines: [event('recall', OLD, { kind: 'seen', via: 'trace' }), counts('recall', OLD + 1_000, { runs: { 'prompt.submit': 100 } })],
  },
]

/** The mods the plugin folders name in these tests' world. */
export const EXPECTED = ['recall', 'pr-autopilot', 'job-watch', 'slicer-handoff']

export const jsonl = (lines: readonly Line[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
