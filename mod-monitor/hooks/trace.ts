/**
 * Reading `next.trace`: which links are mods the monitor reports on, which of
 * them failed and how, and the small reservoir a hook's p95 comes from. Pure.
 */

import type { FailureOutcome } from '../types'

/** What the monitor reads of one trace entry (TraceEntry's own fields). */
export type Link = {
  readonly plugin: string
  readonly tier: string
  readonly outcome: string
  readonly reason?: string
  readonly ms: number
}

export type Failure = { outcome: FailureOutcome; what: string }

/** Each failure outcome in plain words, as the toasts and reports say it. */
export const WHAT: Record<FailureOutcome, string> = {
  skipped: 'threw',
  kept: 'failed after next()',
  caught: 'failed (its .catch answered)',
  expired: 'ran out of time',
  rejected: 'rejected',
}

/**
 * Whether a link is one the monitor reports on: a plugin of the person's or
 * the organization's, never the engine, a plugin bundled with Claude Code
 * (`builtin`) or the monitor itself.
 */
export function isWatched(link: { readonly plugin: string; readonly tier: string }, self: string): boolean {
  return link.plugin !== 'engine' && link.plugin !== self && link.tier !== 'builtin' && link.tier !== 'core'
}

/**
 * The deepest link that rejected, or -1. The trace lists the nearest link
 * first, so the deepest is the last: where the rejection came from; the
 * rejected ones above it only let it pass.
 */
export function deepestRejected(trace: readonly Link[]): number {
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i]?.outcome === 'rejected') {
      return i
    }
  }
  return -1
}

/**
 * The failure a link's outcome records, or null:
 *  - `skipped` with no reason: it threw (or answered what the site refuses) before `next`;
 *    with a reason it was bypassed by a `next.to` above, which is no failure;
 *  - `kept`: it failed after `next` (threw, or returned nothing), and that run's result stands;
 *  - `caught`: it failed and its `.catch` handler answered;
 *  - `expired`: its budget ran out;
 *  - `rejected`: only the deepest rejected link, where the rejection came from.
 */
export function failureOf(link: Link, isDeepestRejected: boolean): Failure | null {
  switch (link.outcome) {
    case 'skipped':
      return link.reason ? null : { outcome: 'skipped', what: WHAT.skipped }
    case 'kept':
    case 'caught':
    case 'expired':
      return { outcome: link.outcome, what: WHAT[link.outcome] }
    case 'rejected':
      return isDeepestRejected ? { outcome: 'rejected', what: WHAT.rejected } : null
    default:
      return null
  }
}

/** Whether the link ran: every outcome but a skip a `next.to` above made (which carries a reason). */
export function didRun(link: Link): boolean {
  return !(link.outcome === 'skipped' && link.reason)
}

/** A uniform sample of a hook's times: the first `RESERVOIR_SIZE` kept, then each replacing at random. */
export type Reservoir = { seen: number; values: number[] }

export const RESERVOIR_SIZE = 64

export function sample(reservoir: Reservoir, value: number, random: () => number = Math.random): void {
  reservoir.seen += 1
  if (reservoir.values.length < RESERVOIR_SIZE) {
    reservoir.values.push(value)
    return
  }
  const at = Math.floor(random() * reservoir.seen)
  if (at < RESERVOIR_SIZE) {
    reservoir.values[at] = value
  }
}

/** The 95th percentile (nearest rank) of the values; 0 for none. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[rank] ?? 0
}

/** Milliseconds rounded for a log line. */
export function roundMs(ms: number): number {
  return ms >= 100 ? Math.round(ms) : Math.round(ms * 10) / 10
}
