import { expect, test } from 'claude-code/testing'

import type { RouteCache, RouteState } from '../types'
import {
  EMPTY_STATE,
  NEW_WORK,
  agentDone,
  classify,
  cleared,
  compilePatterns,
  decide,
  describeRoute,
  guardModel,
  noteBudget,
  parseSummary,
  planAgentStep,
  planStep,
  resolveModel,
  responded,
  started,
  statusText,
  submitted,
} from '../hooks/route'
import type { Ask, Guard, Settings } from '../hooks/route'

const { patterns } = compilePatterns('', '')
const cls = (text: string) => classify(text, patterns).cls

test('git housekeeping is routine', () => {
  for (const text of [
    'merged',
    'Merged.',
    'merged #61',
    '#219 merged',
    '#219 is merged',
    'PR #61 merged',
    'both are merged now',
    'all merged',
    'commit and push',
    'commit push',
    'commit it',
    'push',
    'push it',
    'open a PR',
    'close it',
    'close the issue',
    'commit and push, then open a PR',
  ]) {
    expect(cls(text), text).toBe('routine')
  }
})

test('approving or resuming work is never routine', () => {
  for (const text of ['yes', 'Yes.', 'ok', 'sure', 'go ahead', 'go for it', 'continue', 'keep going', 'do it', 'sounds good!', 'try again']) {
    expect(cls(text), text).toBe('neutral')
  }
})

test('housekeeping followed by new work is not routine', () => {
  for (const text of [
    'merged 219, go ahead with #214',
    'merged #219, start #214',
    'merged, keep going',
    'go ahead with #155',
    'yes, fix and merge',
    'push it and fix the lint',
    'commit and push, then continue',
  ]) {
    expect(cls(text), text).toBe('neutral')
  }
  expect(classify('merged #219, start #214', patterns).why).toBe('more than a routine reply')
  expect(NEW_WORK.test('go ahead with #214')).toBe(true)
  expect(NEW_WORK.test('start #214')).toBe(true)
  expect(NEW_WORK.test('fix and merge')).toBe(true)
  expect(NEW_WORK.test('now')).toBe(false)
  expect(NEW_WORK.test('then open a PR')).toBe(false)
})

test('deep asks are deep', () => {
  for (const text of [
    'review the auth module',
    'Audit the payment flow for race conditions',
    'plan the migration to the new queue',
    'can you architect a cache layer',
    'design the retry policy',
    'do a deep dive on the parser',
    'deep-dive into startup time',
    'assess whether we still need the worker',
    'investigate the flaky test',
    'find the root cause of the crash',
    'research how others solve this',
    'why does the build fail on CI?',
    'why is this so slow',
    'figure out where the memory goes',
    "what's wrong with the login page",
    'what is wrong here',
    'yes, go ahead with the plan',
  ]) {
    expect(cls(text), text).toBe('deep')
  }
})

test('everything else is neutral', () => {
  for (const text of [
    'fix the null check in the uploader',
    'add a --verbose flag to the CLI',
    'good job',
    'gone for today',
    'continue with the refactor of the payment module and add tests for every branch',
    'okay so the parser drops the last line when the file has no trailing newline',
    'the planet renderer is off by one',
    'previewing works now',
  ]) {
    expect(cls(text), text).toBe('neutral')
  }
})

test('a long message is never routine, even when it opens with a routine word', () => {
  const long = `merged ${'x'.repeat(130)}`
  expect(long.length).toBeGreaterThan(120)
  expect(classify(long, patterns)).toEqual({ cls: 'neutral', why: 'too long to be routine' })
  expect(classify('commit and push and then rewrite the whole importer to stream rows', patterns)).toEqual({
    cls: 'neutral',
    why: 'more than a routine reply',
  })
})

test('routine and deep at once is left to the session', () => {
  expect(classify('commit and push, then review the diff', patterns)).toEqual({
    cls: 'neutral',
    why: 'both routine ("commit and push") and deep ("review")',
  })
  // Deep wording past a routine opener that says a lot more is deep.
  expect(cls('ok, now audit the whole codebase for injection risks please')).toBe('deep')
})

test('says why', () => {
  expect(classify('merged #219', patterns).why).toBe('starts with "merged"')
  expect(classify('please review this', patterns).why).toBe('mentions "review"')
  expect(classify('fix it', patterns).why).toBe('no routine or deep wording')
})

test('custom patterns replace the built-in ones', () => {
  const custom = compilePatterns('ship it|lgtm', String.raw`\bthreat model\b`)
  expect(custom.errors).toEqual([])
  expect(classify('ship it', custom.patterns).cls).toBe('routine')
  expect(classify('LGTM, thanks', custom.patterns).cls).toBe('routine')
  expect(classify('commit and push', custom.patterns).cls).toBe('neutral')
  expect(classify('threat model the upload path', custom.patterns).cls).toBe('deep')
  expect(classify('review the upload path', custom.patterns).cls).toBe('neutral')
})

test('a broken pattern falls back to the built-in one and says so', () => {
  const broken = compilePatterns('yes(', '[')
  expect(broken.errors).toHaveLength(2)
  expect(broken.errors[0]).toMatch(/^routinePattern is not a valid regular expression/)
  expect(classify('commit and push', broken.patterns).cls).toBe('routine')
  expect(classify('review it', broken.patterns).cls).toBe('deep')
})

const GUARD: Guard = { stickyTurns: 2, freeSwitchTokens: 30_000, cacheTtlMs: 3_600_000 }
const WARM: RouteCache = {
  applied: 'xhigh',
  model: 'claude-opus-5-5',
  base: 'xhigh',
  messageCount: 40,
  contextTokens: 150_000,
  lastAt: 1_000_000,
  lowerStreak: 0,
}
const ask = (over: Partial<Ask>): Ask => ({
  want: 'low',
  model: 'claude-opus-5-5',
  base: 'xhigh',
  messageCount: 42,
  now: 1_060_000,
  isForced: false,
  ...over,
})

test('over a warm, large cache, less effort waits for a second turn in a row', () => {
  const first = decide(WARM, ask({}), GUARD)
  expect(first).toEqual({ effort: 'xhigh', why: 'hold', lowerStreak: 1 })
  expect(decide({ ...WARM, lowerStreak: 1 }, ask({}), GUARD)).toEqual({ effort: 'low', why: 'streak', lowerStreak: 0 })
  expect(decide(WARM, ask({}), { ...GUARD, stickyTurns: 1 })).toEqual({ effort: 'low', why: 'streak', lowerStreak: 0 })
})

test('more effort, a forced turn and an unchanged effort never wait', () => {
  expect(decide({ ...WARM, applied: 'low' }, ask({ want: 'xhigh' }), GUARD).why).toBe('up')
  expect(decide(WARM, ask({ want: 'max' }), GUARD)).toEqual({ effort: 'max', why: 'up', lowerStreak: 0 })
  expect(decide(WARM, ask({ isForced: true }), GUARD)).toEqual({ effort: 'low', why: 'forced', lowerStreak: 0 })
  expect(decide({ ...WARM, lowerStreak: 1 }, ask({ want: 'xhigh' }), GUARD)).toEqual({ effort: 'xhigh', why: 'same', lowerStreak: 0 })
})

test('a switch is free when the cache is cold, small, or rebuilt anyway', () => {
  expect(decide(WARM, ask({ now: 1_000_000 + 3_600_001 }), GUARD).why).toBe('cold')
  expect(decide({ ...WARM, contextTokens: 20_000 }, ask({}), GUARD).why).toBe('small')
  expect(decide(WARM, ask({ model: 'claude-sonnet-5-5' }), GUARD).why).toBe('model')
  expect(decide(WARM, ask({ base: 'high' }), GUARD).why).toBe('base')
  expect(decide(WARM, ask({ messageCount: 3 }), GUARD).why).toBe('history')
  // No response seen yet: the cache's age is unknown, so it counts as warm.
  expect(decide({ ...WARM, lastAt: null }, ask({ now: 99_999_999 }), GUARD).why).toBe('hold')
})

const SETTINGS: Settings = { routineEffort: 'low', deepEffort: 'max', guard: GUARD, budgetCapAt: 80, budgetCapEffort: 'high', subagentEffort: null }
const facts = (turnId: string, over: Partial<{ messageCount: number; now: number; contextTokens: number; base: 'xhigh' | 'high' }> = {}) => ({
  turnId,
  model: 'claude-opus-5-5',
  base: 'xhigh' as const,
  messageCount: 2,
  now: 0,
  contextTokens: 0,
  ...over,
})

test('a turn takes its prompt class, and every request of the turn keeps the first one\'s effort', () => {
  let state = submitted(EMPTY_STATE, 'commit and push', true, patterns)
  state = started(state, 't1', 'commit and push', patterns)
  const first = planStep(state, facts('t1'), SETTINGS)
  expect(first.effort).toBe('low')
  expect(first.isNew).toBe(true)
  expect(first.status).toBe('effort: low (routine)')
  expect(first.state.counts).toEqual({ routine: 1, deep: 0, neutral: 0, switches: 1, holds: 0 })

  // A huge response comes back; the rest of the turn still runs at low.
  state = responded(first.state, {
    model: 'claude-opus-5-5',
    messageCount: 3,
    now: 10,
    usage: { input_tokens: 5, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 199_495 },
  })
  expect(state.cache?.contextTokens).toBe(200_000)
  const second = planStep(state, facts('t1', { messageCount: 4 }), SETTINGS)
  expect(second.effort).toBe('low')
  expect(second.isNew).toBe(false)
  expect(second.state).toBe(state)
})

test('a prompt that is not the person\'s own is neutral, and /route forces the next personal one', () => {
  expect(submitted(EMPTY_STATE, 'merged', false, patterns).pending).toEqual({
    cls: 'neutral',
    why: 'not typed by you',
    isForced: false,
    text: 'merged',
  })
  const forced = submitted({ ...EMPTY_STATE, forced: 'deep' }, 'yes', true, patterns)
  expect(forced.forced).toBeNull()
  expect(forced.pending).toEqual({ cls: 'deep', why: 'forced with /route', isForced: true, text: 'yes' })
})

test('a turn whose prompt was not seen is classified from its own text, or neutral', () => {
  expect(started(EMPTY_STATE, 't9', 'review this', patterns).turn?.cls).toBe('deep')
  expect(started(EMPTY_STATE, 't9', '', patterns).turn?.cls).toBe('neutral')
})

test('routing off sends the session\'s own effort and shows nothing', () => {
  let state = { ...EMPTY_STATE, isOn: false }
  state = started(submitted(state, 'commit and push', true, patterns), 't1', 'commit and push', patterns)
  const planned = planStep(state, facts('t1'), SETTINGS)
  expect(planned.effort).toBe('xhigh')
  expect(planned.status).toBeUndefined()
})

test('/clear makes the next switch free', () => {
  const warm = {
    ...EMPTY_STATE,
    cache: WARM,
    counts: { routine: 3, deep: 1, neutral: 2, switches: 2, holds: 1 },
    agents: { 'agent-1': { turnId: 'a1', effort: 'high' as const } },
    budget: { checkedAt: 5, pct: 84, note: '', isCapping: true },
  }
  const after = cleared(warm)
  expect(after.counts).toEqual({ routine: 0, deep: 0, neutral: 0, switches: 0, holds: 0 })
  expect(after.cache).toEqual({ ...WARM, messageCount: 0, contextTokens: 0, lastAt: null })
  // Subagent turns end with the conversation; the budget is the machine's, not the conversation's.
  expect(after.agents).toEqual({})
  expect(after.budget).toEqual(warm.budget)
})

test('status line', () => {
  expect(statusText('routine', { effort: 'low', why: 'small', lowerStreak: 0 }, false, 2)).toBe('effort: low (routine)')
  expect(statusText('deep', { effort: 'max', why: 'up', lowerStreak: 0 }, true, 2)).toBe('effort: max (deep, forced)')
  expect(statusText('routine', { effort: 'xhigh', why: 'hold', lowerStreak: 1 }, false, 2)).toBe(
    'effort: xhigh (routine, held for the prompt cache 1/2)',
  )
  expect(statusText('neutral', { effort: 'max', why: 'hold', lowerStreak: 1 }, false, 2)).toBe('effort: max (held for the prompt cache 1/2)')
  expect(statusText('neutral', { effort: 'xhigh', why: 'same', lowerStreak: 0 }, false, 2)).toBeUndefined()
})

test('the model guard sends avoided models to the fallback, aliases spelled as current ids', () => {
  const fable = /fable/i
  expect(guardModel('claude-fable-5-1', fable, 'opus')).toBe('claude-opus-5-5')
  expect(guardModel('claude-opus-5-5', fable, 'opus')).toBe('claude-opus-5-5')
  expect(guardModel('claude-fable-5-1', null, 'opus')).toBe('claude-fable-5-1')
  expect(guardModel('claude-fable-5-1', fable, 'claude-opus-5')).toBe('claude-opus-5')
  // A fallback that is itself avoided leaves the request alone.
  expect(guardModel('claude-fable-5-1', fable, 'fable')).toBe('claude-fable-5-1')
  expect(resolveModel('Sonnet', 'us.anthropic.claude-fable-5-1')).toBe('us.anthropic.claude-sonnet-5-5')
  expect(resolveModel('my-proxy-model', 'claude-fable-5-1')).toBe('my-proxy-model')
})

test('/route describes the last turn and the session', () => {
  let state = started(submitted(EMPTY_STATE, 'merged #219', true, patterns), 't1', 'merged #219', patterns)
  state = planStep(state, facts('t1'), SETTINGS).state
  const text = describeRoute(state, { settings: SETTINGS, modelGuard: null, errors: [] })
  expect(text).toBe(
    [
      'effort-router: on',
      'Last turn: routine "merged #219", starts with "merged" → low (small context)',
      'This session: 1 routine, 0 deep, 0 neutral turns · 1 effort switch · 0 held for the prompt cache',
      "Routine → low, deep → max, neutral → the session's own effort.",
      'Cache guard: a switch is made at once under 30k context tokens, after 60 min idle, or toward more effort; less effort waits for 2 turns in a row.',
      'Prompt cache: written at low over about 0 tokens.',
      'Model guard: off',
      'Budget: not read yet · cap at 80% → high: not engaged',
      "Subagents: the session's own effort",
    ].join('\n'),
  )
})

const NOW = 10_000_000

/** usage-meter's summary as it writes it, with fields overridden. */
const summaryText = (over: Record<string, unknown>): string =>
  JSON.stringify({
    ts: NOW - 5_000,
    windowMs: 18_000_000,
    sessions: 2,
    tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
    effective: 10,
    capEstimate: 100,
    pct: 84,
    lastHitAt: 1,
    nextResetAt: 2,
    ...over,
  })

test("usage-meter's summary gives the percentage used, or no information when missing, stale or unlearned", () => {
  expect(parseSummary(summaryText({}), NOW)).toEqual({ pct: 84, note: '' })
  expect(parseSummary(summaryText({ pct: 84.6 }), NOW)).toEqual({ pct: 84.6, note: '' })
  expect(parseSummary(summaryText({ ts: NOW - 10 * 60_000 }), NOW).pct).toBe(84)
  expect(parseSummary(summaryText({ ts: NOW - 11 * 60_000 }), NOW)).toEqual({ pct: null, note: 'summary is 11 min old' })
  expect(parseSummary(summaryText({ pct: null, capEstimate: null }), NOW)).toEqual({ pct: null, note: 'no limit learned yet' })
  for (const text of [null, '', 'not json', '[1]', 'null', summaryText({ pct: '84' }), summaryText({ ts: 'yesterday' }), '{"pct": 84}']) {
    expect(parseSummary(text, NOW), String(text)).toEqual({ pct: null, note: 'no usage-meter summary' })
  }
})

test('the budget cap engages at the threshold and releases below it or without information', () => {
  const at = (state: RouteState, pct: number | null, note = '') => noteBudget(state, { pct, note }, 5_000, 80)
  const first = at(EMPTY_STATE, 84)
  expect(first.change).toBe('engaged')
  expect(first.state.budget).toEqual({ checkedAt: 5_000, pct: 84, note: '', isCapping: true })
  expect(at(first.state, 90).change).toBeNull()
  expect(at(first.state, 80).change).toBeNull()
  expect(at(first.state, 79).change).toBe('released')
  expect(at(first.state, 79).state.budget?.isCapping).toBe(false)
  const lost = at(first.state, null, 'no usage-meter summary')
  expect(lost.change).toBe('released')
  expect(lost.state.budget).toEqual({ checkedAt: 5_000, pct: null, note: 'no usage-meter summary', isCapping: false })
  expect(at(EMPTY_STATE, 40).change).toBeNull()
  expect(at(EMPTY_STATE, 40).state.budget?.isCapping).toBe(false)
  // 0 turns the cap off.
  expect(noteBudget(EMPTY_STATE, { pct: 99, note: '' }, 5_000, 0).state.budget?.isCapping).toBe(false)
})

const CAPPED: RouteState = noteBudget(EMPTY_STATE, { pct: 84, note: '' }, 0, 80).state

test('under the cap a deep ask runs at the cap effort; a turn at or below it is left alone', () => {
  let state = started(submitted(CAPPED, 'review the parser', true, patterns), 't1', 'review the parser', patterns)
  const deep = planStep(state, facts('t1'), SETTINGS)
  expect(deep.effort).toBe('high')
  expect(deep.status).toBe('effort: high (budget 84%)')
  expect(deep.state.turn?.want).toBe('high')
  expect(deep.state.turn?.cappedAt).toBe(84)

  state = started(submitted(CAPPED, 'commit and push', true, patterns), 't2', 'commit and push', patterns)
  const routine = planStep(state, facts('t2'), SETTINGS)
  expect(routine.effort).toBe('low')
  expect(routine.status).toBe('effort: low (routine)')
  expect(routine.state.turn?.cappedAt).toBeNull()

  state = started(submitted(CAPPED, 'fix the pager', true, patterns), 't3', 'fix the pager', patterns)
  const neutral = planStep(state, facts('t3'), SETTINGS)
  expect(neutral.effort).toBe('high')
  expect(neutral.status).toBe('effort: high (budget 84%)')
  expect(planStep(state, facts('t3', { base: 'high' }), SETTINGS).status).toBeUndefined()

  // Forced deep is capped too; routing off is not.
  const forced = started(submitted({ ...CAPPED, forced: 'deep' }, 'fix the pager', true, patterns), 't4', 'fix the pager', patterns)
  expect(planStep(forced, facts('t4'), SETTINGS).effort).toBe('high')
  expect(planStep({ ...state, isOn: false }, facts('t3'), SETTINGS).effort).toBe('xhigh')
  // A cap turned off in settings ignores a reading that says capping.
  expect(planStep(state, facts('t3'), { ...SETTINGS, budgetCapAt: 0 }).effort).toBe('xhigh')
})

test('over a warm cache the cap waits like any lowering', () => {
  const state = started(submitted({ ...CAPPED, cache: WARM }, 'fix the pager', true, patterns), 't1', 'fix the pager', patterns)
  const held = planStep(state, facts('t1', { messageCount: 42, now: 1_060_000 }), SETTINGS)
  expect(held.effort).toBe('xhigh')
  expect(held.status).toBe('effort: xhigh (budget 84%, held for the prompt cache 1/2)')
  expect(held.state.turn?.cappedAt).toBe(84)
  const text = describeRoute(held.state, { settings: SETTINGS, modelGuard: null, errors: [] })
  expect(text).toMatch(/Last turn: neutral "fix the pager", no routine or deep wording → xhigh, held for the prompt cache \(wanted high: budget 84%\)/)
})

test('a subagent runs at subagentEffort, under the budget cap, pinned for its turn', () => {
  const run = { agentId: 'agent-1', turnId: 'a1', effort: 'xhigh' as const }
  const same = planAgentStep(EMPTY_STATE, run, SETTINGS)
  expect(same.effort).toBe('xhigh')
  expect(same.state.agents).toEqual({ 'agent-1': { turnId: 'a1', effort: 'xhigh' } })

  const low: Settings = { ...SETTINGS, subagentEffort: 'low' }
  expect(planAgentStep(EMPTY_STATE, run, low).effort).toBe('low')
  expect(planAgentStep(CAPPED, run, SETTINGS).effort).toBe('high')
  expect(planAgentStep(CAPPED, run, { ...SETTINGS, subagentEffort: 'max' }).effort).toBe('high')
  expect(planAgentStep(CAPPED, run, low).effort).toBe('low')

  // Pinned: the turn's later requests keep the first effort whatever the budget says now; the next turn decides anew.
  const pinned = { ...CAPPED, agents: same.state.agents }
  const later = planAgentStep(pinned, run, SETTINGS)
  expect(later.effort).toBe('xhigh')
  expect(later.state).toBe(pinned)
  expect(planAgentStep(pinned, { ...run, turnId: 'a2' }, SETTINGS).effort).toBe('high')
  expect(agentDone(pinned, 'agent-1').agents).toEqual({})
  expect(agentDone(EMPTY_STATE, 'agent-9')).toBe(EMPTY_STATE)

  // Routing off: the request is left as it came, still pinned so /route on never changes a running turn.
  const off = planAgentStep({ ...CAPPED, isOn: false }, run, low)
  expect(off.effort).toBe('xhigh')
  expect(off.state.agents).toEqual({ 'agent-1': { turnId: 'a1', effort: 'xhigh' } })
})

test('status line under the budget cap', () => {
  expect(statusText('deep', { effort: 'high', why: 'small', lowerStreak: 0 }, false, 2, 84)).toBe('effort: high (budget 84%)')
  expect(statusText('deep', { effort: 'high', why: 'forced', lowerStreak: 0 }, true, 2, 84.4)).toBe('effort: high (budget 84%)')
  expect(statusText('neutral', { effort: 'xhigh', why: 'hold', lowerStreak: 1 }, false, 2, 84)).toBe('effort: xhigh (budget 84%, held for the prompt cache 1/2)')
  expect(statusText('neutral', { effort: 'xhigh', why: 'same', lowerStreak: 0 }, false, 2, null)).toBeUndefined()
})

test('/route describes the budget and the subagent effort', () => {
  const info = { settings: SETTINGS, modelGuard: null, errors: [] }
  expect(describeRoute(CAPPED, info)).toMatch(/^Budget: 84% of the 5-hour limit used · cap at 80% → high: engaged$/m)
  expect(describeRoute({ ...CAPPED, isOn: false }, info)).toMatch(/^Budget: 84% of the 5-hour limit used · cap at 80% → high: not applied while routing is off$/m)
  const below = noteBudget(EMPTY_STATE, { pct: 40.4, note: '' }, 0, 80).state
  expect(describeRoute(below, info)).toMatch(/^Budget: 40% of the 5-hour limit used · cap at 80% → high: not engaged$/m)
  const unknown = noteBudget(EMPTY_STATE, { pct: null, note: 'summary is 12 min old' }, 0, 80).state
  expect(describeRoute(unknown, info)).toMatch(/^Budget: unknown \(summary is 12 min old\) · cap at 80% → high: not engaged$/m)
  expect(describeRoute(CAPPED, { ...info, settings: { ...SETTINGS, budgetCapAt: 0 } })).toMatch(/^Budget cap: off$/m)
  expect(describeRoute(EMPTY_STATE, { ...info, settings: { ...SETTINGS, budgetCapAt: 50, budgetCapEffort: 'medium', subagentEffort: 'low' } })).toMatch(
    /^Budget: not read yet · cap at 50% → medium: not engaged\nSubagents: run at low$/m,
  )
})
