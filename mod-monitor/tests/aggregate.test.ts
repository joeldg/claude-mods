import { describe, expect, test } from 'claude-code/testing'

import { aggregate, countsText, eventText, failuresText, lastNote, markOf, paneView, reportText } from '../hooks/aggregate'
import type { PaneInput } from '../hooks/aggregate'
import { dayOf } from '../hooks/log'
import { DAY, EXPECTED, NOW, PAST, counts, event } from './fixtures'

const files = PAST.map(past => ({ session: past.session, day: dayOf(past.ts), lines: past.lines }))
const WEEK = NOW - 7 * DAY

describe('folding the day files', () => {
  test('counts add up across sessions, from the start of the range', () => {
    const mods = aggregate(files, WEEK)
    const recall = mods.get('recall')
    expect(recall?.sessions).toEqual(new Set(['aaaa1111', 'bbbb2222']))
    expect(recall?.runs).toEqual({ 'session.start': 2, 'prompt.submit': 16, 'tool.call': 30 })
    expect(recall?.runsTotal).toBe(48)
    expect(recall?.activeRuns).toBe(46)
    expect(recall?.toasts).toBe(6)
    expect([...(recall?.toastTexts ?? [])]).toEqual([
      ['Indexed 40 new extracts', 3],
      ['Index is 3 days old', 1],
      ['Recall is ready', 2],
    ])
    expect(recall?.commands.get('recall')).toEqual({ n: 3, bare: 1 })
    expect(recall?.procGroups.get('python3 recall.py')).toMatchObject({ n: 2, lastExit: 1, lastErr: 'Traceback (most recent call last):' })
    expect(recall?.failureGroups.get('tool.call|skipped')).toMatchObject({ n: 1, what: 'threw', maxMs: 12 })
    expect(recall?.slow.get('session.start')).toEqual({ event: 'session.start', n: 1, max: 2400, p95: 2400 })
    expect(recall?.tokens).toEqual({ in: 1000, out: 50, cacheRead: 0, cacheWrite: 0 })
    expect(recall?.modelMisses.get('api-error 429 rate_limit')).toBe(1)
    expect(mods.get('job-watch')?.lastActivity).toBe(0)
    // The ten-day-old session is out of the range.
    expect(aggregate(files).get('recall')?.runs['prompt.submit']).toBe(116)
  })

  test('what a mod last did is its last toast or command', () => {
    const recall = aggregate(files, WEEK).get('recall')
    // The bare /recall two days ago is newer than everything five days ago.
    expect(recall && lastNote(recall)).toBe('/recall')
    expect(eventText(event('x', NOW, { kind: 'proc-fail', cmd: 'gh pr', exit: null, ms: 3, err: 'spawn gh ENOENT' }))).toBe(
      '✗ gh pr: did not run — spawn gh ENOENT',
    )
    expect(eventText(event('x', NOW, { kind: 'status', text: '', n: 3 }))).toBe('status: (cleared) ×3')
    expect(countsText(recall)).toBe('hooks 48 · toasts 6 · commands 3 · tool calls 4 · process failures 2 · model calls 2')
  })
})

describe('the pane', () => {
  const today = aggregate(
    [
      {
        session: 'now',
        day: dayOf(NOW),
        lines: [
          counts('recall', NOW - 60_000, { runs: { 'session.start': 1, 'tool.call': 3 } }),
          event('recall', NOW - 60_000, { kind: 'toast', text: 'Indexed 2 new extracts' }),
          counts('pr-autopilot', NOW - 30_000, { runs: { 'session.start': 1 } }),
          event('job-watch', NOW - 120_000, { kind: 'failure', event: 'tool.call', outcome: 'kept', ms: 4, what: 'failed after next()' }),
          counts('job-watch', NOW - 120_000, { runs: { 'tool.call': 1 }, fails: 1 }),
        ],
      },
    ],
    NOW - DAY,
  )
  const input: PaneInput = {
    now: NOW,
    expected: EXPECTED,
    loaded: new Set(['recall', 'pr-autopilot', 'job-watch', 'extra']),
    covered: new Set(['recall', 'job-watch']),
    procBursts: new Set(),
    today,
    folder: '~/.claude/mods/monitor/2026-10-07/',
  }

  test('marks: active, failing, not loaded, idle', () => {
    expect(markOf('recall', input)).toBe('✓')
    expect(markOf('job-watch', input)).toBe('⚠')
    expect(markOf('slicer-handoff', input)).toBe('✗')
    // Starting with the session is not use.
    expect(markOf('pr-autopilot', input)).toBe('·')
    expect(markOf('recall', { ...input, procBursts: new Set(['recall']) })).toBe('⚠')
  })

  test('rows, header and coverage', () => {
    const view = paneView(input)
    expect(view.header).toBe('3 of 4 mods loaded · 2 covered · 1 failing today')
    expect(view.rows.map(row => `${row.mark} ${row.name}`)).toEqual([
      '✓ recall',
      '· pr-autopilot',
      '⚠ job-watch',
      '✗ slicer-handoff',
      '· extra',
    ])
    expect(view.rows[0]?.last).toBe('1m ago · toast: Indexed 2 new extracts')
    expect(view.rows[0]?.counts).toBe('hooks 4')
    expect(view.rows[2]?.details).toHaveLength(1)
    expect(view.rows[2]?.details[0]).toMatch(/^\d\d:\d\d {2}✗ tool\.call hook failed after next\(\) \(4 ms\)$/)
    expect(view.rows[3]?.last).toBe('not seen in this session (not loaded, or silent so far)')
    expect(view.coverage).toBe(
      'Not seen beneath the monitor yet: extra, pr-autopilot (loaded above it, or idle). It sees failures only in the mods beneath it.',
    )
    expect(paneView({ ...input, covered: input.loaded }).coverage).toBe('Every loaded mod has run beneath the monitor.')
  })

  test('with no plugin folders named, the rows are the mods seen', () => {
    const view = paneView({ ...input, expected: [] })
    expect(view.header).toBe('4 mods loaded · 2 covered · 1 failing today')
    expect(view.rows.map(row => row.name)).toEqual(['extra', 'job-watch', 'pr-autopilot', 'recall'])
  })
})

describe('reports', () => {
  const input = { now: NOW, since: WEEK, range: '7d', sessions: 2, expected: EXPECTED, mods: aggregate(files, WEEK) }

  test('/mods report says per mod what it did, and which mods never showed', () => {
    const text = reportText(input)
    expect(text).toStartWith('# Mods report: last 7d (')
    expect(text).toContain('2 sessions · 3 mods seen · 1 with failures')
    expect(text).toContain('recall — loaded in 2 sessions')
    expect(text).toContain('  hook runs 48: tool.call 30 · prompt.submit 16 · session.start 2')
    expect(text).toContain('  toasts 6: "Indexed 40 new extracts" ×3 · "Recall is ready" ×2 · "Index is 3 days old" ×1')
    expect(text).toContain('  commands used: /recall ×3 (1 bare)')
    expect(text).toContain('  tool calls 4')
    expect(text).toContain('  process failures 2:')
    expect(text).toMatch(/ {4}python3 recall\.py ×2, last \d\d-\d\d \d\d:\d\d \(exit 1\): Traceback \(most recent call last\):/)
    expect(text).toContain('  hook failures 1:')
    expect(text).toMatch(/ {4}tool\.call threw \(skipped\) ×1, last \d\d-\d\d \d\d:\d\d, up to 12 ms/)
    expect(text).toContain('  slowest hooks: session.start max 2.4 s, p95 2.4 s (1 slow)')
    expect(text).toContain(
      '  model calls 2: haiku ×2 — 1,000 in / 50 out tokens (cache 0 read / 0 written); unanswered: api-error 429 rate_limit ×1',
    )
    expect(text).toContain('pr-autopilot — loaded in 1 session\n  hook runs 6: turn.complete 5 · session.start 1')
    expect(text).toContain('job-watch — loaded in 1 session\n  hook runs 0')
    expect(text).toContain('Never seen: slicer-handoff')
    expect(text).not.toContain('116')
  })

  test('/mods failures lists failures alone', () => {
    const text = failuresText(input)
    expect(text).toContain('recall\n  hook failures 1:')
    expect(text).toContain('  process failures 2:')
    expect(text).not.toContain('pr-autopilot')
    expect(text).not.toContain('toasts')
    expect(failuresText({ ...input, mods: aggregate([], WEEK) })).toContain('No hook failures or process errors.')
  })
})
