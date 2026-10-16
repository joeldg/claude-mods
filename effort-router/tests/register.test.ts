import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptOrigin, TurnStepInput, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'
const HOME = '/Users/me'
/** Where usage-meter writes its machine-wide summary of the last 5 hours. */
const SUMMARY = `${HOME}/.claude/usage-meter/summary.json`

type World = {
  /** Every request as it reached the engine beneath the plugin. */
  sent: TurnStepInput[]
  statuses: (string | undefined)[]
  toasts: string[]
  /** Context tokens each response reports (what the next request re-sends). */
  context: number
  /** Messages the conversation holds. */
  messages: number
  turns: number
  /** Files on disk, by absolute path. */
  files: Map<string, string>
  /** Every path read. */
  reads: string[]
  logs: { text: string; to: string | undefined }[]
}

/** Answers the engine beneath the plugin: the model requests, the turn's events, the status line and toasts. */
const world = (on: On): World => {
  const w: World = { sent: [], statuses: [], toasts: [], context: 1_000, messages: 0, turns: 0, files: new Map(), reads: [], logs: [] }
  mock.env(on, { HOME })
  on('fs.read', (_$, e) => {
    w.reads.push(e.path)
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.log', (_$, e) => {
    w.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    w.sent.push({ ...e })
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: w.context - 100, cache_creation_input_tokens: 0, model: e.model },
    }
    return result
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.context, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

/** Reads a streamed step to its end and hands back its result. */
async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<R> {
  for (;;) {
    const next = await stream.next()
    if (next.done) {
      return next.value
    }
  }
}

type TurnOptions = {
  steps?: number
  model?: string
  effort?: TurnStepInput['effort']
  origin?: PromptOrigin
  /** A subagent's requests made during the turn. */
  agentSteps?: number
  /** The effort the session hands the subagent's requests. */
  agentEffort?: TurnStepInput['effort']
}

/** One turn as a session runs it: the prompt, the turn's start, its requests (tool rounds), its end. */
async function turn($: Engine, w: World, text: string, options: TurnOptions = {}): Promise<void> {
  const { steps = 2, model = OPUS, origin = { kind: 'composer' }, agentSteps = 0, agentEffort = 'medium' } = options
  const effort = 'effort' in options ? options.effort : 'xhigh'
  w.turns += 1
  const turnId = `t${w.turns}`
  w.messages += 1
  await $.prompt.submit({ text, wait: false, origin })
  await $.turn.start({ text, turnId })
  for (let index = 0; index < steps; index++) {
    await drain($.turn.step({ turnId, index, model, ...(effort === undefined ? {} : { effort }), messageCount: w.messages }))
    w.messages += 2
  }
  for (let index = 0; index < agentSteps; index++) {
    await drain($.turn.step({ turnId: `${turnId}-agent`, index, model, effort: agentEffort, messageCount: 1 + index, agentId: 'agent-1' }))
  }
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId, reason: 'answer' })
}

/** The efforts the last turn's requests (main loop) were sent at. */
const lastTurnEfforts = (w: World): unknown[] => w.sent.filter(one => one.turnId === `t${w.turns}`).map(one => one.effort)

/** The efforts every subagent request was sent at. */
const agentEfforts = (w: World): unknown[] => w.sent.filter(one => one.agentId !== undefined).map(one => one.effort)

/** The debug-log lines about the budget cap. */
const budgetLogs = (w: World): string[] => w.logs.filter(one => one.to === 'debug' && one.text.includes('budget cap')).map(one => one.text)

/** usage-meter's summary of the last 5 hours, as it writes it; `pct` is null until a limit has been hit once. */
const summary = (pct: number | null, ts: number): string =>
  JSON.stringify({
    ts,
    windowMs: 18_000_000,
    sessions: 3,
    tokens: { input: 1_000, cacheRead: 2_000_000, cacheWrite: 300_000, output: 50_000 },
    effective: 2_351_000,
    capEstimate: pct === null ? null : 2_800_000,
    pct,
    lastHitAt: pct === null ? null : ts - 7_200_000,
    nextResetAt: pct === null ? null : ts + 3_600_000,
  })

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

test('a routine prompt sends every request of its turn at low, and says so while it runs', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, '#219 merged', { steps: 3 })
  expect(lastTurnEfforts(w)).toEqual(['low', 'low', 'low'])
  expect(w.statuses).toEqual(['effort: low (routine)', undefined])
})

test('a deep prompt runs at max', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  expect(w.statuses[0]).toBe('effort: max (deep)')
})

test('a neutral prompt leaves the effort as the session set it', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'add a --verbose flag to the export command')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(w.statuses.filter(one => one !== undefined)).toEqual([])

  await turn($, w, 'fix the off-by-one in the pager', { effort: 'high' })
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
})

test("bare approvals and replies that start new work run at the session's own effort", async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  for (const text of ['yes', 'continue', 'go ahead', 'merged 219, go ahead with #214', 'yes, fix and merge', 'merged, keep going']) {
    await turn($, w, text)
    expect(lastTurnEfforts(w), text).toEqual(['xhigh', 'xhigh'])
  }
  expect(w.statuses.filter(one => one !== undefined)).toEqual([])
})

test('/route off leaves every turn alone until /route on', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  const off = await $.command.run(typed('route', 'off'))
  expect(off.text).toMatch(/^Effort routing is off for this session/)
  await turn($, w, 'commit and push')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  await turn($, w, 'audit the session handling')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  await $.command.run(typed('route', 'on'))
  await turn($, w, 'audit the session handling')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
})

test('/route deep forces the next prompt only', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  const forced = await $.command.run(typed('route', 'deep'))
  expect(forced.text).toBe('Your next prompt runs at max (deep), whatever it says.')
  await turn($, w, 'fix the off-by-one in the pager')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  expect(w.statuses[0]).toBe('effort: max (deep, forced)')

  await turn($, w, 'fix the off-by-one in the pager')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
})

test("subagents keep their own effort; prompts that are not the person's own are not routed", async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'commit and push', { agentSteps: 2 })
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
  expect(w.sent.filter(one => one.agentId !== undefined).map(one => one.effort)).toEqual(['medium', 'medium'])

  await turn($, w, 'merged', { origin: { kind: 'task-notification' } })
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
})

test('a model without effort levels is left alone', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'commit and push', { effort: undefined, model: 'claude-haiku-4-5' })
  expect(w.sent.map(one => one.effort)).toEqual([undefined, undefined])
  expect(w.statuses.filter(one => one !== undefined)).toEqual([])
})

test('avoidModel sends matching requests, subagents included, to the fallback model', { options: { avoidModel: 'fable' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'add a --verbose flag to the export command', { model: FABLE, agentSteps: 1 })
  expect(w.sent.map(one => one.model)).toEqual([OPUS, OPUS, OPUS])
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(w.toasts).toEqual([`effort-router: requests for ${FABLE} go to ${OPUS} (avoidModel).`])

  await turn($, w, 'push it', { model: 'claude-sonnet-5-5' })
  expect(w.sent.slice(-2).map(one => [one.model, one.effort])).toEqual([
    ['claude-sonnet-5-5', 'low'],
    ['claude-sonnet-5-5', 'low'],
  ])
  expect(w.toasts).toHaveLength(1)
})

test('avoidModel is off by default', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'add a --verbose flag', { model: FABLE })
  expect(w.sent.map(one => one.model)).toEqual([FABLE, FABLE])
})

test('over a large, warm prompt cache a lower effort waits for a second routine turn; more effort never waits', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on)
  w.context = 150_000

  await turn($, w, 'add a --verbose flag to the export command')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  await clock.advance(60_000)
  await turn($, w, 'merged')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(w.statuses.at(-2)).toBe('effort: xhigh (routine, held for the prompt cache 1/2)')

  await clock.advance(60_000)
  await turn($, w, 'commit and push')
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
  expect(w.statuses.at(-2)).toBe('effort: low (routine)')

  // Back to real work: the session's effort at once, no waiting.
  await clock.advance(60_000)
  await turn($, w, 'add tests for the export flag')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  // Deep goes up at once; the neutral turn after it stays at max once rather than rewriting the cache.
  await turn($, w, 'investigate why the export is slow')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  await turn($, w, 'make the export stream rows')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  expect(w.statuses.at(-2)).toBe('effort: max (held for the prompt cache 1/2)')
  await turn($, w, 'and add a progress bar')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/This session: 2 routine, 1 deep, 4 neutral turns · 4 effort switches · 2 held for the prompt cache/)
  expect(shown.text).toMatch(/Prompt cache: written at xhigh over about 150k tokens\./)
})

test('once the cache has lapsed, a lower effort is sent at once', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on)
  w.context = 150_000

  await turn($, w, 'add a --verbose flag to the export command')
  await clock.advance(6 * 60_000)
  await turn($, w, 'push it')
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
})

test('stickyTurns 1 switches every turn', { options: { stickyTurns: 1 } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  w.context = 150_000

  await turn($, w, 'add a --verbose flag to the export command')
  await turn($, w, 'merged')
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
})

test('loaded mid-session over a large context it holds as over any warm cache; /clear frees the next switch', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  w.context = 200_000

  await turn($, w, 'commit and push')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  w.messages = 0
  await turn($, w, 'commit and push')
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
})

test('a prompt typed mid-turn never changes the running turn', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await $.prompt.submit({ text: 'add a --verbose flag to the export command', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'add a --verbose flag to the export command', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 1 }))
  await $.prompt.submit({ text: 'commit and push', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 1, model: OPUS, effort: 'xhigh', messageCount: 4 }))
  expect(w.sent.map(one => one.effort)).toEqual(['xhigh', 'xhigh'])
})

test('custom effort levels and patterns from settings', { options: { routineEffort: 'medium', deepEffort: 'xhigh', routinePattern: 'ship it' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'ship it', { effort: 'high' })
  expect(lastTurnEfforts(w)).toEqual(['medium', 'medium'])
  await turn($, w, 'commit and push', { effort: 'high' })
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  await turn($, w, 'plan the rollout', { effort: 'high' })
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
})

test('/route reports, and rejects what it does not know', { options: { avoidModel: 'fable', routinePattern: 'yes(' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'merged')
  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/^effort-router: on\n/)
  expect(shown.text).toMatch(/Last turn: routine "merged", starts with "merged" → low/)
  expect(shown.text).toMatch(/Model guard: models matching \/fable\/i run on claude-opus-5-5/)
  expect(shown.text).toMatch(/routinePattern is not a valid regular expression/)

  const odd = await $.command.run(typed('route', 'sideways'))
  expect(odd.text).toMatch(/^Usage: \/route/)
})

test('turned off in settings, nothing is touched', { options: { enabled: false, avoidModel: 'fable' } }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)

  await turn($, w, 'commit and push', { model: FABLE })
  expect(w.sent.map(one => [one.model, one.effort])).toEqual([
    [FABLE, 'xhigh'],
    [FABLE, 'xhigh'],
  ])
  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/turned off in its settings/)
})

test('a failure while choosing sends the request unchanged and logs it for mod-monitor', async ($, on) => {
  const w = world(on)
  on('clock.now', () => ({ deny: 'clock unavailable' }))
  await turn($, w, 'commit and push')
  // A routine prompt would go out at low; with routing broken it keeps the session's own effort.
  expect(w.sent.length).toBeGreaterThan(0)
  expect(w.sent.every(step => step.effort === 'xhigh')).toBe(true)
  expect(w.logs.some(line => line.text.startsWith('effort-router: choosing the effort failed, so the request went out unchanged'))).toBe(true)
})

test('at 84% of the 5-hour budget a deep ask is capped at high, and the status line says so', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(84, 995_000))

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.statuses[0]).toBe('effort: high (budget 84%)')

  // A neutral turn at the session's xhigh is capped too.
  await turn($, w, 'add a --verbose flag to the export command')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.statuses.at(-2)).toBe('effort: high (budget 84%)')

  // A turn already at or below the cap is left alone.
  await turn($, w, 'commit and push')
  expect(lastTurnEfforts(w)).toEqual(['low', 'low'])
  expect(w.statuses.at(-2)).toBe('effort: low (routine)')
  await turn($, w, 'add tests for the export flag', { effort: 'high' })
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.statuses.at(-2)).toBeUndefined()

  expect(budgetLogs(w)).toEqual(['effort-router: budget cap engaged: 84% of the 5-hour limit used (cap at 80%); turns run at high or less'])
})

test('at 40% of the budget nothing changes, and the summary is read once per turn', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(40, 999_000))

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  expect(w.statuses[0]).toBe('effort: max (deep)')
  expect(w.reads).toEqual([SUMMARY])
  expect(budgetLogs(w)).toEqual([])

  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/^Budget: 40% of the 5-hour limit used · cap at 80% → high: not engaged$/m)
  expect(shown.text).toMatch(/^Subagents: the session's own effort$/m)
})

test('a missing, stale or unlearned summary is no budget information', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])

  await clock.advance(31_000)
  w.files.set(SUMMARY, summary(84, clock.now() - 11 * 60_000))
  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  const stale = await $.command.run(typed('route', ''))
  expect(stale.text).toMatch(/^Budget: unknown \(summary is 11 min old\) · cap at 80% → high: not engaged$/m)

  await clock.advance(31_000)
  w.files.set(SUMMARY, summary(null, clock.now()))
  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  const unlearned = await $.command.run(typed('route', ''))
  expect(unlearned.text).toMatch(/^Budget: unknown \(no limit learned yet\)/m)

  await clock.advance(31_000)
  w.files.set(SUMMARY, 'not json')
  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  const broken = await $.command.run(typed('route', ''))
  expect(broken.text).toMatch(/^Budget: unknown \(no usage-meter summary\)/m)

  expect(w.statuses.filter(one => one !== undefined)).toEqual(['effort: max (deep)', 'effort: max (deep)', 'effort: max (deep)', 'effort: max (deep)'])
  expect(budgetLogs(w)).toEqual([])
})

test('the cap is released once the summary drops below, after the 30 s memo, with one log line each way', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(84, 999_000))

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])

  // The reading is kept for 30 s: the file's change is not seen yet.
  w.files.set(SUMMARY, summary(60, clock.now()))
  await clock.advance(10_000)
  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.reads).toEqual([SUMMARY])

  await clock.advance(25_000)
  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  expect(w.statuses.at(-2)).toBe('effort: max (deep)')
  expect(w.reads).toEqual([SUMMARY, SUMMARY])
  expect(budgetLogs(w)).toEqual([
    'effort-router: budget cap engaged: 84% of the 5-hour limit used (cap at 80%); turns run at high or less',
    'effort-router: budget cap released: 60% of the 5-hour limit used (cap at 80%)',
  ])
})

test('over a large, warm prompt cache the cap waits for a second turn, as any lowering does', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.context = 150_000

  await turn($, w, 'add a --verbose flag to the export command')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])

  w.files.set(SUMMARY, summary(84, clock.now()))
  await clock.advance(60_000)
  await turn($, w, 'add tests for the export flag')
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(w.statuses.at(-2)).toBe('effort: xhigh (budget 84%, held for the prompt cache 1/2)')

  await clock.advance(60_000)
  await turn($, w, 'and add a progress bar')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.statuses.at(-2)).toBe('effort: high (budget 84%)')

  // Capped, a deep ask stays at the cap.
  await clock.advance(60_000)
  await turn($, w, 'investigate why the export is slow')
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(w.statuses.at(-2)).toBe('effort: high (budget 84%)')

  const shown = await $.command.run(typed('route', ''))
  // The built-in deep pattern matches the stem ("investigat" covers "investigating").
  expect(shown.text).toMatch(/Last turn: deep "investigate why the export is slow", mentions "investigat" → high \(budget 84%\)/)
})

test('subagentEffort sends subagent requests at that effort and leaves the main turn alone', { options: { subagentEffort: 'low' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  await turn($, w, 'add a --verbose flag to the export command', { agentSteps: 2, agentEffort: 'xhigh' })
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(agentEfforts(w)).toEqual(['low', 'low'])
  expect(w.statuses.filter(one => one !== undefined)).toEqual([])

  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/^Subagents: run at low$/m)
})

test('the budget cap applies to subagents too: the lower of the two efforts', { options: { subagentEffort: 'max' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(84, 999_000))

  await turn($, w, 'add a --verbose flag to the export command', { agentSteps: 2, agentEffort: 'medium' })
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(agentEfforts(w)).toEqual(['high', 'high'])
})

test('with no subagentEffort the cap still lowers a subagent running above it, and leaves one below it alone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(84, 999_000))

  await turn($, w, 'commit and push', { agentSteps: 1, agentEffort: 'xhigh' })
  await turn($, w, 'commit and push', { agentSteps: 1, agentEffort: 'low' })
  expect(agentEfforts(w)).toEqual(['high', 'low'])
})

test("a subagent's turn keeps its first effort when the budget crosses midway; its next turn is capped", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(40, 999_000))

  await $.turn.start({ text: 'investigate the flaky test', turnId: 'a1', agentId: 'agent-1' })
  await drain($.turn.step({ turnId: 'a1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 1, agentId: 'agent-1' }))
  w.files.set(SUMMARY, summary(84, clock.now()))
  await clock.advance(31_000)
  await drain($.turn.step({ turnId: 'a1', index: 1, model: OPUS, effort: 'xhigh', messageCount: 3, agentId: 'agent-1' }))
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' })
  expect(agentEfforts(w)).toEqual(['xhigh', 'xhigh'])

  await $.turn.start({ text: 'and the other one', turnId: 'a2', agentId: 'agent-1' })
  await drain($.turn.step({ turnId: 'a2', index: 0, model: OPUS, effort: 'xhigh', messageCount: 1, agentId: 'agent-1' }))
  expect(agentEfforts(w)).toEqual(['xhigh', 'xhigh', 'high'])
})

test("a subagent's turn start and steps never change the running main turn", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  await $.prompt.submit({ text: 'commit and push', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'commit and push', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 1 }))
  await $.turn.start({ text: 'investigate why the export is slow', turnId: 'a1', agentId: 'agent-1' })
  await drain($.turn.step({ turnId: 'a1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 1, agentId: 'agent-1' }))
  await drain($.turn.step({ turnId: 't1', index: 1, model: OPUS, effort: 'xhigh', messageCount: 4 }))
  expect(w.sent.filter(one => one.agentId === undefined).map(one => one.effort)).toEqual(['low', 'low'])
  expect(agentEfforts(w)).toEqual(['xhigh'])

  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/Last turn: routine "commit and push", starts with "commit and push" → low/)
})

test('/route off disables the budget cap and the subagent effort too', { options: { subagentEffort: 'low' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(84, 999_000))

  await $.command.run(typed('route', 'off'))
  await turn($, w, 'review the retry logic in the uploader', { agentSteps: 1, agentEffort: 'xhigh' })
  expect(lastTurnEfforts(w)).toEqual(['xhigh', 'xhigh'])
  expect(agentEfforts(w)).toEqual(['xhigh'])

  await $.command.run(typed('route', 'on'))
  await turn($, w, 'review the retry logic in the uploader', { agentSteps: 1, agentEffort: 'xhigh' })
  expect(lastTurnEfforts(w)).toEqual(['high', 'high'])
  expect(agentEfforts(w)).toEqual(['xhigh', 'low'])
})

test('budgetCapAt 0 turns the cap off: the summary is never read', { options: { budgetCapAt: 0 } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(99, 999_000))

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['max', 'max'])
  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/^Budget cap: off$/m)
  expect(w.reads).toEqual([])
})

test('budgetCapAt and budgetCapEffort from settings', { options: { budgetCapAt: 50, budgetCapEffort: 'medium' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(SUMMARY, summary(55, 999_000))

  await turn($, w, 'review the retry logic in the uploader')
  expect(lastTurnEfforts(w)).toEqual(['medium', 'medium'])
  expect(w.statuses[0]).toBe('effort: medium (budget 55%)')
  const shown = await $.command.run(typed('route', ''))
  expect(shown.text).toMatch(/^Budget: 55% of the 5-hour limit used · cap at 50% → medium: engaged$/m)
  expect(shown.text).toMatch(/Last turn: deep "review the retry logic in the uploader", mentions "review" → medium \(budget 55%\)/)
})
