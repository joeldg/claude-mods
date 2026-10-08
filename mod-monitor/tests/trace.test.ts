import { describe, expect, test } from 'claude-code/testing'

import { RESERVOIR_SIZE, deepestRejected, didRun, failureOf, isWatched, p95, roundMs, sample } from '../hooks/trace'
import type { Link } from '../hooks/trace'

const link = (outcome: string, extra: Partial<Link> = {}): Link => ({ plugin: 'recall', tier: 'user', outcome, ms: 3, ...extra })

describe('reading a trace', () => {
  test('each failure outcome, and the ones that are not failures', () => {
    expect(failureOf(link('skipped'), false)).toEqual({ outcome: 'skipped', what: 'threw' })
    expect(failureOf(link('skipped', { reason: 'bypassed by org-policy' }), false)).toBeNull()
    expect(failureOf(link('kept'), false)).toEqual({ outcome: 'kept', what: 'failed after next()' })
    expect(failureOf(link('caught'), false)).toEqual({ outcome: 'caught', what: 'failed (its .catch answered)' })
    expect(failureOf(link('expired'), false)).toEqual({ outcome: 'expired', what: 'ran out of time' })
    expect(failureOf(link('rejected'), true)).toEqual({ outcome: 'rejected', what: 'rejected' })
    expect(failureOf(link('rejected'), false)).toBeNull()
    expect(failureOf(link('returned'), false)).toBeNull()
    expect(failureOf(link('passed'), false)).toBeNull()
  })

  test('a rejection is the deepest rejected link’s; the ones above only let it pass', () => {
    const trace = [link('rejected', { plugin: 'a' }), link('returned', { plugin: 'b' }), link('rejected', { plugin: 'c' })]
    expect(deepestRejected(trace)).toBe(2)
    expect(deepestRejected([link('returned')])).toBe(-1)
    expect(deepestRejected([])).toBe(-1)
  })

  test('a link bypassed by next.to above did not run', () => {
    expect(didRun(link('skipped', { reason: 'bypassed by org-policy' }))).toBe(false)
    expect(didRun(link('skipped'))).toBe(true)
    expect(didRun(link('returned'))).toBe(true)
  })

  test('the engine, built-ins and the monitor itself are not reported on', () => {
    expect(isWatched({ plugin: 'engine', tier: 'core' }, 'mod-monitor')).toBe(false)
    expect(isWatched({ plugin: 'mod-monitor', tier: 'user' }, 'mod-monitor')).toBe(false)
    expect(isWatched({ plugin: 'bundled-thing', tier: 'builtin' }, 'mod-monitor')).toBe(false)
    expect(isWatched({ plugin: 'recall', tier: 'user' }, 'mod-monitor')).toBe(true)
    expect(isWatched({ plugin: 'org-policy', tier: 'prepend' }, 'mod-monitor')).toBe(true)
    expect(isWatched({ plugin: 'late', tier: 'append' }, 'mod-monitor')).toBe(true)
  })
})

describe('times', () => {
  test('p95 by nearest rank', () => {
    expect(p95([])).toBe(0)
    expect(p95([7])).toBe(7)
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19)
    expect(p95(Array.from({ length: 100 }, (_, i) => 100 - i))).toBe(95)
  })

  test('the reservoir keeps the first values, then replaces at random', () => {
    const reservoir = { seen: 0, values: [] as number[] }
    for (let i = 0; i < RESERVOIR_SIZE; i++) {
      sample(reservoir, i)
    }
    expect(reservoir.values).toHaveLength(RESERVOIR_SIZE)
    sample(reservoir, 1000, () => 0)
    expect(reservoir.values[0]).toBe(1000)
    sample(reservoir, 2000, () => 0.999)
    expect(reservoir.values).not.toContain(2000)
    expect(reservoir.seen).toBe(RESERVOIR_SIZE + 2)
  })

  test('milliseconds are rounded for the log', () => {
    expect(roundMs(1.23456)).toBe(1.2)
    expect(roundMs(1534.6)).toBe(1535)
  })
})
