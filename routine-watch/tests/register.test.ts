import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROMPT =
  '<scheduled-task name="daily-report" file="/Users/me/.claude/scheduled-tasks/daily-report/SKILL.md">\n' +
  'Gather the morning headlines and write the digest.\n</scheduled-task>'
const TITLE = 'Claude routine: daily-report'
const FETCH = { url: 'https://www.example.com/markets', prompt: 'Summarise the headlines' }
const QUESTIONS = [
  {
    question: 'Which sources should the digest use?',
    header: 'Sources',
    options: [
      { label: 'Wire services', description: 'Agency feeds' },
      { label: 'Blogs', description: 'Independent writers' },
    ],
    multiSelect: false,
  },
]

type Verdict = 'allow' | 'ask' | 'deny'

type World = {
  /** Every process the plugin ran. */
  argv: string[][]
  toasts: string[]
  statuses: (string | undefined)[]
  /** The engine's own verdict per tool; `ask` when not listed. */
  verdicts: Record<string, Verdict>
  /** What a process exits with, by argv[0]. */
  exits: Record<string, number>
}

/** The macOS notification osascript would post. */
const osascript = (message: string, title = TITLE) => [
  'osascript',
  '-e',
  `display notification "${message}" with title "${title}" sound name "Glass"`,
]

/** Answers the host beneath the plugin: processes, toasts, the status line, the engine's verdicts. */
const world = (on: On): World => {
  const w: World = { argv: [], toasts: [], statuses: [], verdicts: {}, exits: {} }
  on('process.run', (_$, e) => {
    w.argv.push([...e.argv])
    const exitCode = w.exits[e.argv[0] ?? ''] ?? 0
    return {
      value: { exitCode, stdout: '', stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.check', (_$, e) => ({ decision: w.verdicts[e.tool] ?? 'ask' }))
  return w
}

/** The session's first prompt, as a desktop scheduled task submits it. */
const startRoutine = async ($: Engine, text = PROMPT) => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })

/** A slash command as the person types it. */
const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const endSession = { reason: 'other' as const, sessionId: 's1', resume: { id: 's1' } }

test('outside a routine an ask is left alone: no notification, toast or status', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await $.prompt.submit({ text: 'Fix the flaky test', wait: false, origin: { kind: 'composer' } })

  const verdict = await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  expect(verdict.decision).toBe('ask')
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_2' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'error' })
  await $.session.end(endSession)
  await clock.advance(60_000)

  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])
  expect((await $.command.run(typed('routine'))).text).toMatch(/^Not a routine session/)
})

test('a later prompt with the tag does not make a session a routine', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await startRoutine($)
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  expect(w.toasts).toEqual([])
})

test('in a routine an ask notifies once: osascript, a toast and the status line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on)
  await startRoutine($)
  expect(w.statuses).toEqual(['routine: daily-report'])

  const verdict = await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  expect(verdict.decision).toBe('ask')
  await clock.settle()
  expect(w.argv).toEqual([osascript('Waiting for your OK: WebFetch example.com')])
  expect(w.toasts).toEqual(['Waiting for your OK: WebFetch example.com'])
  expect(w.statuses.at(-1)).toBe('routine: daily-report · waiting on you <1m')

  // The same call checked again is not a second wait.
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await clock.settle()
  expect(w.argv).toHaveLength(1)
  expect(w.toasts).toHaveLength(1)

  await clock.advance(3 * 60_000)
  expect(w.statuses.at(-1)).toBe('routine: daily-report · waiting on you 3m')
  const shown = await $.command.run(typed('routine'))
  expect(shown.text).toBe(
    [
      'Routine: daily-report',
      'Started 3m ago',
      'Waited on you 1 time · waiting now for 3m: WebFetch example.com',
      'Settings: Mac notifications on · web reads ask (allowWebReads off) · phone push off · finish notice on',
    ].join('\n'),
  )
})

test('the wait ends when the tool call it held up finishes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let check: Promise<unknown> = Promise.resolve()
  // The engine's own order: the call's permission check runs inside it.
  on('tool.call', { tool: 'Bash' }, async () => {
    await check
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  await startRoutine($)

  check = $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_b' })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'toolu_b' })
  await clock.settle()
  expect(w.toasts).toEqual(['Waiting for your OK: Bash git push'])
  expect(w.statuses).toEqual(['routine: daily-report', 'routine: daily-report · waiting on you <1m', 'routine: daily-report'])
  expect((await $.command.run(typed('routine'))).text).toContain('Waited on you 1 time\n')
})

test('a query with no call id, and a call the engine allows, notify nobody', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.verdicts.Read = 'allow'
  await startRoutine($)
  await $.tool.check({ tool: 'WebFetch', input: FETCH })
  await $.tool.check({ tool: 'Read', input: { file_path: '/Users/me/project/a.md' }, tool_use_id: 'toolu_r' })
  await clock.settle()
  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
})

test('with allowWebReads on, WebFetch and WebSearch are allowed quietly and Bash still asks', { options: { allowWebReads: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)

  const fetch = await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_f' })
  expect(fetch.decision).toBe('allow')
  expect(fetch.reason).toMatch(/allowWebReads/)
  const search = await $.tool.check({ tool: 'WebSearch', input: { query: 'markets today' }, tool_use_id: 'toolu_s' })
  expect(search.decision).toBe('allow')
  await clock.settle()
  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])

  const bash = await $.tool.check({ tool: 'Bash', input: { command: 'curl https://example.com' }, tool_use_id: 'toolu_b' })
  expect(bash.decision).toBe('ask')
  await clock.settle()
  expect(w.argv).toEqual([osascript('Waiting for your OK: Bash curl https://example.com')])
})

test('with allowWebReads on, a rule that denies WebFetch still denies, and outside a routine it asks', { options: { allowWebReads: true } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  expect((await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_0' })).decision).toBe('ask')

  await startRoutine($)
  w.verdicts.WebFetch = 'deny'
  expect((await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })).decision).toBe('deny')
})

test('allowWebReads is off by default: WebFetch asks and notifies', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)
  expect((await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })).decision).toBe('ask')
  await clock.settle()
  expect(w.toasts).toEqual(['Waiting for your OK: WebFetch example.com'])
})

test('AskUserQuestion notifies once while the question is open', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let answer = () => {}
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await answered
    return { result: { questions: QUESTIONS, answers: {} }, text: 'The user answered: Wire services' }
  })
  await startRoutine($)

  const asking = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_q', questions: QUESTIONS })
  await clock.settle()
  expect(w.argv).toEqual([osascript('Question for you: Which sources should the digest use?')])
  expect(w.toasts).toEqual(['Question for you: Which sources should the digest use?'])
  expect(w.statuses.at(-1)).toBe('routine: daily-report · waiting on you <1m')

  // The engine's ask for the same call is the same wait.
  await $.tool.check({ tool: 'AskUserQuestion', input: { questions: QUESTIONS }, tool_use_id: 'toolu_q' })
  await clock.settle()
  expect(w.toasts).toHaveLength(1)

  answer()
  await asking
  expect(w.statuses.at(-1)).toBe('routine: daily-report')
})

test('a turn that ends on an error notifies', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(w.toasts).toEqual([])

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't2', reason: 'error' })
  await clock.settle()
  expect(w.toasts).toEqual(['The run stopped: its turn ended on an error.'])
  expect(w.argv).toEqual([osascript('The run stopped: its turn ended on an error.')])
})

test('the session end says how long the routine ran and how often it waited', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  const w = world(on)
  await startRoutine($)
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_2' })
  await clock.advance(23 * 60_000 + 30_000)
  w.argv = []

  await $.session.end(endSession)
  const finished = 'Routine daily-report finished after 23m · waited on you 2 times'
  expect(w.argv).toEqual([osascript(finished)])
  expect(w.toasts.at(-1)).toBe(finished)
  expect(w.statuses.at(-1)).toBeUndefined()

  // The ticker stopped with the session.
  const shown = w.statuses.length
  await clock.advance(60_000)
  expect(w.statuses).toHaveLength(shown)
})

test('with notifyOnFinish off the end is quiet', { options: { notifyOnFinish: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)
  await $.session.end(endSession)
  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
})

test('notifyCommand runs beside osascript with the title and message as single arguments', { options: { notifyCommand: 'curl -s -H Title:{title} -d {message} ntfy.sh/my-topic' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)
  await $.tool.check({ tool: 'Bash', input: { command: 'echo hi; rm -rf /' }, tool_use_id: 'toolu_1' })
  await clock.settle()
  expect(w.argv).toEqual([
    osascript('Waiting for your OK: Bash echo hi; rm -rf /'),
    ['curl', '-s', '-H', `Title:${TITLE}`, '-d', 'Waiting for your OK: Bash echo hi; rm -rf /', 'ntfy.sh/my-topic'],
  ])
})

test('with notifyMac off only the push command and the toast are used, and a failing push is harmless', { options: { notifyMac: false, notifyCommand: 'push {message}' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.exits.push = 1
  await startRoutine($)
  const verdict = await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await clock.settle()
  expect(verdict.decision).toBe('ask')
  expect(w.argv).toEqual([['push', 'Waiting for your OK: WebFetch example.com']])
  expect(w.toasts).toEqual(['Waiting for your OK: WebFetch example.com'])
})

test('a first prompt a schedule fired counts as a routine even without the tag', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await $.prompt.submit({ text: 'check the feeds', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect(w.statuses).toEqual(['routine: scheduled task'])
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await clock.settle()
  expect(w.argv).toEqual([osascript('Waiting for your OK: WebFetch example.com', 'Claude routine: scheduled task')])
})

test('a quote in the routine name cannot break out of the AppleScript string', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($, '<scheduled-task name="say &quot;hi&quot; \\ bye">go</scheduled-task>')
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await clock.settle()
  expect(w.argv[0]?.[2]).toBe(
    'display notification "Waiting for your OK: WebFetch example.com" with title "Claude routine: say \\"hi\\" \\\\ bye" sound name "Glass"',
  )
})

test('overlapping waits each notify; the status shows the oldest; the turn end closes any left open', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await startRoutine($)
  await $.tool.check({ tool: 'WebFetch', input: FETCH, tool_use_id: 'toolu_1' })
  await clock.advance(2 * 60_000)
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_2' })
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['Waiting for your OK: WebFetch example.com', 'Waiting for your OK: Bash ls'])
  expect(w.statuses.at(-1)).toBe('routine: daily-report · waiting on you 3m')

  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: true, turnId: 't1', reason: 'aborted' })
  expect(w.statuses.at(-1)).toBe('routine: daily-report')
  const shown = w.statuses.length
  await clock.advance(60_000)
  expect(w.statuses).toHaveLength(shown)
  expect((await $.command.run(typed('routine'))).text).toContain('\nWaited on you 2 times\n')
})
