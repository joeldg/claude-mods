import { expect, test } from 'claude-code/testing'

import type { RouteCache } from '../types'
import {
  EMPTY_STATE,
  NEW_WORK,
  classify,
  cleared,
  compilePatterns,
  decide,
  describeRoute,
  guardModel,
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

const SETTINGS: Settings = { routineEffort: 'low', deepEffort: 'max', guard: GUARD }
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
  const warm = { ...EMPTY_STATE, cache: WARM, counts: { routine: 3, deep: 1, neutral: 2, switches: 2, holds: 1 } }
  const after = cleared(warm)
  expect(after.counts).toEqual({ routine: 0, deep: 0, neutral: 0, switches: 0, holds: 0 })
  expect(after.cache).toEqual({ ...WARM, messageCount: 0, contextTokens: 0, lastAt: null })
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
    ].join('\n'),
  )
})
