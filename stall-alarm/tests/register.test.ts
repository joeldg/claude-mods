import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const CWD = '/home/dev/example-app'
const WAITING = 'Claude is waiting · example-app'
const STOPPED = 'Claude stopped · example-app'
const PUSH = { command: 'git push origin main' }
const OAUTH = 'OAuth refresh token is no longer valid; run /login to re-authenticate'
const ROUTINE =
  '<scheduled-task name="daily-report" file="/home/dev/.claude/scheduled-tasks/daily-report/SKILL.md">\n' +
  'Gather the morning headlines and write the digest.\n</scheduled-task>'
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
const osascript = (message: string, title: string) => [
  'osascript',
  '-e',
  `display notification "${message}" with title "${title}" sound name "Glass"`,
]

/** Answers the host beneath the plugin: processes, toasts, the status line, the engine's verdicts, the turns. */
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
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('tool.check', (_$, e) => ({ decision: w.verdicts[e.tool] ?? 'ask' }))
  return w
}

/** The session's start in a project folder, then the person's first prompt. */
const begin = async ($: Engine, text = 'keep going until the tests pass', kind: 'composer' | 'sdk' = 'composer') => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text, wait: false, origin: { kind } })
}

/** A permission dialog the engine opens for one call. */
const ask = ($: Engine, tool_use_id: string, input: Record<string, unknown> = PUSH, tool = 'Bash') =>
  $.tool.check({ tool, input, tool_use_id })

const endTurn = ($: Engine, reason: 'answer' | 'error' | 'aborted', answer = '', agentId?: string) =>
  $.turn.complete({ answer, durationMs: 10, isAborted: reason === 'aborted', turnId: 't1', reason, agentId })

/** A slash command as the person types it. */
const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const endSession = { reason: 'other' as const, sessionId: 's1', resume: { id: 's1' } }

test('a dialog answered within the threshold raises no alarm, toast or status', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(2 * MINUTE)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  await begin($)

  expect((await ask($, 'toolu_1')).decision).toBe('ask')
  const call = $.tool.call({ tool: 'Bash', command: PUSH.command, tool_use_id: 'toolu_1' })
  await clock.advance(2 * MINUTE)
  await call
  await clock.advance(10 * MINUTE)

  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])
  expect((await $.command.run(typed('stalls'))).text).toBe(
    [
      'No open waits.',
      'No alarms yet.',
      'Settings: stall after 5m · repeat every 30m · Mac notifications on · phone push off · any error off · routines skipped',
    ].join('\n'),
  )
})

test('a dialog open past the threshold alarms once, shows the wait, then repeats each period until the turn ends', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await ask($, 'toolu_1')
  await clock.advance(4 * MINUTE)
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])

  await clock.advance(MINUTE)
  const first = 'Claude has been waiting 5m for your OK: Bash git push origin main'
  expect(w.toasts).toEqual([first])
  expect(w.argv).toEqual([osascript(first, WAITING)])
  expect(w.statuses.at(-1)).toBe('waiting on you 5m')

  // The same call checked again is the same wait; ten minutes in, no repeat yet.
  await ask($, 'toolu_1')
  await clock.advance(5 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.statuses.at(-1)).toBe('waiting on you 10m')

  await clock.advance(25 * MINUTE)
  const again = 'Claude has been waiting 35m for your OK: Bash git push origin main'
  expect(w.toasts).toEqual([first, again])
  expect(w.argv).toEqual([osascript(first, WAITING), osascript(again, WAITING)])
  expect((await $.command.run(typed('stalls'))).text).toBe(
    [
      'Open waits:',
      '- 35m for your OK: Bash git push origin main · alarmed 2 times',
      'Last alarms:',
      `- 0s ago · ${again}`,
      `- 30m ago · ${first}`,
      'Settings: stall after 5m · repeat every 30m · Mac notifications on · phone push off · any error off · routines skipped',
    ].join('\n'),
  )

  // A subagent's turn ending leaves the main loop's wait open; the main turn's end closes it.
  await endTurn($, 'answer', 'done', 'agent_1')
  expect(w.statuses.at(-1)).toBe('waiting on you 35m')
  await endTurn($, 'answer', 'done')
  expect(w.statuses.at(-1)).toBeUndefined()
  const shown = w.statuses.length
  await clock.advance(60 * MINUTE)
  expect(w.toasts).toHaveLength(2)
  expect(w.statuses).toHaveLength(shown)
  expect((await $.command.run(typed('stalls'))).text).toContain('No open waits.\nLast alarms:\n')
})

test('a question left unanswered alarms; its answer closes the wait', { timeoutMs: 30_000 }, async ($, on) => {
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
  await begin($)

  const asking = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_q', questions: QUESTIONS })
  await clock.settle()
  // The engine's ask for the same call is the same wait.
  await ask($, 'toolu_q', { questions: QUESTIONS }, 'AskUserQuestion')
  await clock.advance(5 * MINUTE)
  const message = 'Claude has been waiting 5m for your answer: Which sources should the digest use?'
  expect(w.toasts).toEqual([message])
  expect(w.argv).toEqual([osascript(message, WAITING)])
  expect(w.statuses.at(-1)).toBe('waiting on you 5m')

  answer()
  await asking
  expect(w.statuses.at(-1)).toBeUndefined()
  await clock.advance(60 * MINUTE)
  expect(w.toasts).toHaveLength(1)
})

test('overlapping dialogs each alarm at their own threshold; the status shows the oldest', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await ask($, 'toolu_1')
  await clock.advance(2 * MINUTE)
  await ask($, 'toolu_2', { url: 'https://www.example.com/markets', prompt: 'summarise' }, 'WebFetch')
  await clock.advance(3 * MINUTE)
  expect(w.toasts).toEqual(['Claude has been waiting 5m for your OK: Bash git push origin main'])
  await clock.advance(2 * MINUTE)
  expect(w.toasts).toEqual([
    'Claude has been waiting 5m for your OK: Bash git push origin main',
    'Claude has been waiting 5m for your OK: WebFetch example.com',
  ])
  expect(w.statuses.at(-1)).toBe('waiting on you 7m')
})

test('a query with no call id, and a call the engine allows, open no wait', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.verdicts.Read = 'allow'
  await begin($)
  await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com/' } })
  await ask($, 'toolu_r', { file_path: '/home/dev/example-app/a.md' }, 'Read')
  await clock.advance(10 * MINUTE)
  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])
})

test('a turn that stops on a login error alarms at once, once, whichever hook hears of it first', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)

  // The usual order: the classic StopFailure hook, then the turn's end.
  await $.classic.StopFailure({ error: 'authentication_failed', error_details: OAUTH })
  await endTurn($, 'error')
  await clock.settle()
  const stopped = `Claude stopped: ${OAUTH}`
  expect(w.toasts).toEqual([stopped])
  expect(w.argv).toEqual([osascript(stopped, STOPPED)])

  // The other order, with the error's text only in the turn's answer, and a fix the text does not name.
  await $.turn.start({ text: 'again', turnId: 't2' })
  await endTurn($, 'error', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}')
  await clock.settle()
  const expired = 'Claude stopped: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · run /login'
  expect(w.toasts).toEqual([stopped, expired])
  await $.classic.StopFailure({ error: 'authentication_failed', error_details: 'OAuth token has expired.' })
  await clock.settle()
  expect(w.toasts).toHaveLength(2)
  expect(w.argv).toHaveLength(2)
  expect((await $.command.run(typed('stalls'))).text).toContain(`Last alarms:\n- 0s ago · ${expired}\n- 0s ago · ${stopped}\n`)
})

test('a usage-limit error alarms too; a plain error and an answered turn are quiet', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await $.classic.StopFailure({ error: 'server_error', error_details: 'Internal server error' })
  await endTurn($, 'error')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await endTurn($, 'answer', 'done')
  await clock.settle()
  expect(w.toasts).toEqual([])

  await $.turn.start({ text: 'again', turnId: 't3' })
  await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit. Resets at 3pm." })
  await endTurn($, 'error')
  await clock.settle()
  expect(w.toasts).toEqual(["Claude stopped: You've hit your usage limit. Resets at 3pm."])
})

test('with alarmOnAnyError on, a plain error alarms', { options: { alarmOnAnyError: true }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await $.classic.StopFailure({ error: 'server_error', error_details: 'Internal server error' })
  await endTurn($, 'error')
  await clock.settle()
  expect(w.toasts).toEqual(['Claude stopped: Internal server error'])
  expect(w.argv).toEqual([osascript('Claude stopped: Internal server error', STOPPED)])
})

test('a routine session is left to routine-watch: nothing is tracked or alarmed', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($, ROUTINE, 'sdk')
  await ask($, 'toolu_1')
  await clock.advance(10 * MINUTE)
  await $.classic.StopFailure({ error: 'authentication_failed', error_details: OAUTH })
  await endTurn($, 'error')
  await clock.settle()
  expect(w.argv).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])
  expect((await $.command.run(typed('stalls'))).text?.split('\n')[0]).toBe('Routine session: left to routine-watch (skipRoutines on).')
})

test('with skipRoutines off a routine session is watched like any other', { options: { skipRoutines: false }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($, ROUTINE, 'sdk')
  await ask($, 'toolu_1')
  await clock.advance(5 * MINUTE)
  expect(w.toasts).toEqual(['Claude has been waiting 5m for your OK: Bash git push origin main'])
})

test('/stalls off silences alarms and the status for the session; /stalls on brings them back', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  expect((await $.command.run(typed('stalls', 'off'))).text).toBe('stall-alarm: alarms are off for this session; /stalls on turns them back on.')
  await ask($, 'toolu_1')
  await clock.advance(10 * MINUTE)
  expect(w.toasts).toEqual([])
  expect(w.statuses).toEqual([])
  expect((await $.command.run(typed('stalls'))).text?.split('\n').slice(0, 3)).toEqual([
    'Alarms are off for this session; /stalls on turns them back on.',
    'Open waits:',
    '- 10m for your OK: Bash git push origin main',
  ])

  expect((await $.command.run(typed('stalls', 'on'))).text).toBe('stall-alarm: alarms are on.')
  await clock.advance(15_000)
  expect(w.toasts).toEqual(['Claude has been waiting 10m for your OK: Bash git push origin main'])
  expect(w.statuses.at(-1)).toBe('waiting on you 10m')
  expect((await $.command.run(typed('stalls', 'maybe'))).text).toBe('Usage: /stalls, /stalls off, /stalls on')
})

test('notifyCommand runs beside osascript with the title and message as single arguments', { options: { notifyCommand: 'curl -s -H Title:{title} -d {message} ntfy.sh/my-topic' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await ask($, 'toolu_1', { command: 'echo hi; rm -rf /' })
  await clock.advance(5 * MINUTE)
  const message = 'Claude has been waiting 5m for your OK: Bash echo hi; rm -rf /'
  expect(w.argv).toEqual([
    osascript(message, WAITING),
    ['curl', '-s', '-H', `Title:${WAITING}`, '-d', message, 'ntfy.sh/my-topic'],
  ])
})

test('with notifyMac off only the push command and the toast are used, and a failing push is harmless', { options: { notifyMac: false, notifyCommand: 'push {message}' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.exits.push = 1
  await begin($)
  await ask($, 'toolu_1')
  await clock.advance(5 * MINUTE)
  const message = 'Claude has been waiting 5m for your OK: Bash git push origin main'
  expect(w.argv).toEqual([['push', message]])
  expect(w.toasts).toEqual([message])
})

test('stallMinutes and repeatMinutes set the threshold and the period; 0 repeats never', { options: { stallMinutes: 2, repeatMinutes: 0 }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await ask($, 'toolu_1')
  await clock.advance(2 * MINUTE)
  expect(w.toasts).toEqual(['Claude has been waiting 2m for your OK: Bash git push origin main'])
  expect(w.statuses.at(-1)).toBe('waiting on you 2m')
  // Past where the default period would have repeated (30m after the alarm).
  await clock.advance(40 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect((await $.command.run(typed('stalls'))).text).toContain('Settings: stall after 2m · no repeat ·')
})

test('the session end clears the status and the waits; the next conversation starts afresh', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await begin($)
  await ask($, 'toolu_1')
  await clock.advance(6 * MINUTE)
  expect(w.statuses.at(-1)).toBe('waiting on you 6m')

  await $.session.end(endSession)
  expect(w.statuses.at(-1)).toBeUndefined()
  const shown = w.statuses.length
  await clock.advance(60 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.statuses).toHaveLength(shown)
  expect((await $.command.run(typed('stalls'))).text?.split('\n')[0]).toBe('No open waits.')
})
