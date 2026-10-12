import { expect, test } from 'claude-code/testing'

import {
  alarmTitle,
  appleScriptString,
  classifyError,
  commandArgv,
  describeCall,
  describeStalls,
  dueAlarms,
  errorMessage,
  firstQuestion,
  folderName,
  formatDuration,
  isRoutinePrompt,
  osascriptArgv,
  statusLine,
  waitMessage,
} from '../hooks/stall'
import type { StallSession, StallSettings, StallWait } from '../types'

const MINUTE = 60_000
const STALL_MS = 5 * MINUTE
const REPEAT_MS = 30 * MINUTE

const SETTINGS: StallSettings = {
  stallMinutes: 5,
  repeatMinutes: 30,
  notifyMac: true,
  notifyCommand: '',
  alarmOnAnyError: false,
  skipRoutines: true,
}

const wait = (changes: Partial<StallWait> = {}): StallWait => ({
  since: 0,
  kind: 'ok',
  label: 'Bash git push origin main',
  alarmedAt: null,
  alarms: 0,
  ...changes,
})

const session = (changes: Partial<StallSession> = {}): StallSession => ({
  isDecided: true,
  isRoutine: false,
  isOff: false,
  folder: 'example-app',
  waiting: {},
  alarms: [],
  ...changes,
})

const OAUTH = 'OAuth refresh token is no longer valid; run /login to re-authenticate'

test('isRoutinePrompt knows a scheduled task by its tag or its origin', () => {
  expect(isRoutinePrompt('<scheduled-task name="daily-report" file="/home/dev/x/SKILL.md">go</scheduled-task>', 'sdk')).toBe(true)
  expect(isRoutinePrompt('<scheduled-task file="/home/dev/x/SKILL.md">go</scheduled-task>', 'composer')).toBe(true)
  expect(isRoutinePrompt('check the feeds', 'scheduled-trigger')).toBe(true)
  expect(isRoutinePrompt('keep going until the tests pass', 'composer')).toBe(false)
  expect(isRoutinePrompt('a <scheduled-tasks> list', 'sdk')).toBe(false)
})

test('appleScriptString escapes quotes and backslashes and flattens line breaks', () => {
  expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""')
  expect(appleScriptString('C:\\temp\\')).toBe('"C:\\\\temp\\\\"')
  expect(appleScriptString('one\ntwo\r\nthree\tfour')).toBe('"one two three four"')
  expect(appleScriptString('x" & do shell script "rm -rf ~" & "')).toBe('"x\\" & do shell script \\"rm -rf ~\\" & \\""')
})

test('osascriptArgv is one -e script with title, message and the Glass sound', () => {
  expect(osascriptArgv('Claude is waiting · example-app', 'Claude has been waiting 5m for your OK: Bash ls')).toEqual([
    'osascript',
    '-e',
    'display notification "Claude has been waiting 5m for your OK: Bash ls" with title "Claude is waiting · example-app" sound name "Glass"',
  ])
  expect(osascriptArgv('t', 'm'.repeat(500))[2] ?? '').toContain(`"${'m'.repeat(239)}…"`)
})

test('commandArgv fills {title} and {message} into single arguments, never through a shell', () => {
  const values = { title: 'Claude stopped', message: 'Claude stopped: boom; rm -rf /' }
  expect(commandArgv('curl -s -H Title:{title} -d {message} ntfy.sh/my-topic', values)).toEqual([
    'curl',
    '-s',
    '-H',
    'Title:Claude stopped',
    '-d',
    'Claude stopped: boom; rm -rf /',
    'ntfy.sh/my-topic',
  ])
  expect(commandArgv('push {title} {message}', { title: '{message}', message: '$(whoami) {title}' })).toEqual([
    'push',
    '{message}',
    '$(whoami) {title}',
  ])
  expect(commandArgv('   ', values)).toBeNull()
})

test('describeCall labels a call by what it touches', () => {
  expect(describeCall('Bash', { command: 'git push\n  origin main' })).toBe('Bash git push origin main')
  expect(describeCall('WebFetch', { url: 'https://www.example.com/a', prompt: 'summarise' })).toBe('WebFetch example.com')
  expect(describeCall('WebSearch', { query: 'markets today' })).toBe('WebSearch "markets today"')
  expect(describeCall('Write', { file_path: '/home/dev/app/out/digest.md', content: '…' })).toBe('Write digest.md')
  expect(describeCall('TodoWrite', { todos: [] })).toBe('TodoWrite')
  expect(describeCall('Bash', { command: 'x'.repeat(100) })).toBe(`Bash ${'x'.repeat(59)}…`)
})

test('firstQuestion reads the first question asked', () => {
  expect(firstQuestion({ questions: [{ question: 'Which sources?' }, { question: 'Second?' }] })).toBe('Which sources?')
  expect(firstQuestion({ questions: [] })).toBe('a question')
})

test('formatDuration says seconds, minutes, then hours', () => {
  expect(formatDuration(45_900)).toBe('45s')
  expect(formatDuration(5 * MINUTE)).toBe('5m')
  expect(formatDuration(65 * MINUTE)).toBe('1h05m')
  expect(formatDuration(-5)).toBe('0s')
})

test('folderName is the last part of the path, or nothing', () => {
  expect(folderName('/home/dev/example-app')).toBe('example-app')
  expect(folderName('/home/dev/example-app/')).toBe('example-app')
  expect(folderName('')).toBe('')
})

test('alarmTitle names the folder when known', () => {
  expect(alarmTitle('Claude is waiting', 'example-app')).toBe('Claude is waiting · example-app')
  expect(alarmTitle('Claude stopped', '')).toBe('Claude stopped')
})

test('waitMessage says how long, and for what: an OK or an answer', () => {
  expect(waitMessage(wait(), 5 * MINUTE)).toBe('Claude has been waiting 5m for your OK: Bash git push origin main')
  expect(waitMessage(wait({ since: MINUTE, kind: 'question', label: 'Which sources should the digest use?' }), 36 * MINUTE)).toBe(
    'Claude has been waiting 35m for your answer: Which sources should the digest use?',
  )
})

test('dueAlarms: the first alarm at the threshold, then one per repeat period, none for 0', () => {
  const waiting = { a: wait({ since: 0 }), b: wait({ since: 2 * MINUTE }) }
  expect(dueAlarms(waiting, 2 * MINUTE, STALL_MS, REPEAT_MS)).toEqual([])
  expect(dueAlarms(waiting, 5 * MINUTE, STALL_MS, REPEAT_MS)).toEqual(['a'])
  expect(dueAlarms(waiting, 7 * MINUTE, STALL_MS, REPEAT_MS)).toEqual(['a', 'b'])

  const alarmed = { a: wait({ since: 0, alarmedAt: 5 * MINUTE, alarms: 1 }) }
  expect(dueAlarms(alarmed, 10 * MINUTE, STALL_MS, REPEAT_MS)).toEqual([])
  expect(dueAlarms(alarmed, 35 * MINUTE, STALL_MS, REPEAT_MS)).toEqual(['a'])
  expect(dueAlarms(alarmed, 35 * MINUTE, STALL_MS, 0)).toEqual([])
})

test('statusLine shows the oldest wait once it is past the threshold', () => {
  expect(statusLine({}, 10 * MINUTE, STALL_MS)).toBeUndefined()
  const waiting = { a: wait({ since: 3 * MINUTE }), b: wait({ since: 0 }) }
  expect(statusLine(waiting, 4 * MINUTE, STALL_MS)).toBeUndefined()
  expect(statusLine(waiting, 7 * MINUTE, STALL_MS)).toBe('waiting on you 7m')
})

test('classifyError knows the errors that stop a run until you act, and the fix', () => {
  expect(classifyError(OAUTH, 'authentication_failed')).toEqual({ isKnown: true, fix: 'run /login' })
  expect(classifyError('API Error: 401 authentication_error', null)).toEqual({ isKnown: false, fix: null })
  expect(classifyError('', 'authentication_failed')).toEqual({ isKnown: true, fix: 'run /login' })
  expect(classifyError('Not logged in', null)).toEqual({ isKnown: true, fix: 'run /login' })
  expect(classifyError('You have hit your usage limit', null)).toEqual({ isKnown: true, fix: null })
  expect(classifyError('Rate limit reached', 'rate_limit')).toEqual({ isKnown: true, fix: null })
  expect(classifyError('Your credit balance is too low', 'billing_error')).toEqual({ isKnown: true, fix: 'check billing' })
  expect(classifyError('Overloaded', 'overloaded')).toEqual({ isKnown: true, fix: null })
  expect(classifyError('Internal server error', 'server_error')).toEqual({ isKnown: false, fix: null })
  expect(classifyError('something odd', null)).toEqual({ isKnown: false, fix: null })
})

test('errorMessage is the first line of the error and the fix, unless the line already names it', () => {
  expect(errorMessage(OAUTH, 'authentication_failed')).toBe(`Claude stopped: ${OAUTH}`)
  expect(errorMessage('API Error: 401 authentication_error\nmore detail', 'authentication_failed')).toBe(
    'Claude stopped: API Error: 401 authentication_error · run /login',
  )
  expect(errorMessage('Internal server error', 'server_error')).toBe('Claude stopped: Internal server error')
  expect(errorMessage('', 'billing_error')).toBe('Claude stopped: billing error · check billing')
  expect(errorMessage('', null)).toBe('Claude stopped: its turn ended on an error')
  expect(errorMessage(`${'x'.repeat(200)}\nsecond`, null)).toBe(`Claude stopped: ${'x'.repeat(159)}…`)
})

test('describeStalls shows the open waits with their ages, the last alarms and the settings', () => {
  expect(describeStalls(session(), SETTINGS, 0)).toBe(
    [
      'No open waits.',
      'No alarms yet.',
      'Settings: stall after 5m · repeat every 30m · Mac notifications on · phone push off · any error off · routines skipped',
    ].join('\n'),
  )
  const busy = session({
    waiting: {
      a: wait({ since: 0, alarmedAt: 5 * MINUTE, alarms: 1 }),
      b: wait({ since: 6 * MINUTE, kind: 'question', label: 'Which sources?' }),
    },
    alarms: [{ at: 5 * MINUTE, message: 'Claude has been waiting 5m for your OK: Bash git push origin main' }],
  })
  const settings = { ...SETTINGS, repeatMinutes: 0, notifyMac: false, notifyCommand: 'curl -d {message} ntfy.sh/secret-topic', alarmOnAnyError: true, skipRoutines: false }
  expect(describeStalls(busy, settings, 7 * MINUTE)).toBe(
    [
      'Open waits:',
      '- 7m for your OK: Bash git push origin main · alarmed 1 time',
      '- 1m for your answer: Which sources?',
      'Last alarms:',
      '- 2m ago · Claude has been waiting 5m for your OK: Bash git push origin main',
      'Settings: stall after 5m · no repeat · Mac notifications off · phone push on · any error on · routines watched too',
    ].join('\n'),
  )
  expect(describeStalls(busy, settings, 7 * MINUTE)).not.toContain('secret-topic')
})

test('describeStalls says when it is off, and when a routine is left to routine-watch', () => {
  expect(describeStalls(session({ isOff: true }), SETTINGS, 0).split('\n')[0]).toBe(
    'Alarms are off for this session; /stalls on turns them back on.',
  )
  expect(describeStalls(session({ isRoutine: true }), SETTINGS, 0).split('\n')[0]).toBe(
    'Routine session: left to routine-watch (skipRoutines on).',
  )
  expect(describeStalls(session({ isRoutine: true }), { ...SETTINGS, skipRoutines: false }, 0).split('\n')[0]).toBe('No open waits.')
})
