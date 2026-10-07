import { expect, test } from 'claude-code/testing'

import {
  appleScriptString,
  commandArgv,
  describeCall,
  describeRun,
  detectRoutine,
  finishMessage,
  firstQuestion,
  formatDuration,
  hostOf,
  osascriptArgv,
  routineName,
  statusLine,
} from '../hooks/routine'
import type { RoutineRun, RoutineSettings } from '../types'

const PROMPT =
  '<scheduled-task name="daily-report" file="/Users/me/.claude/scheduled-tasks/daily-report/SKILL.md">\n' +
  'Gather the morning headlines and write the digest.\n</scheduled-task>'

const SETTINGS: RoutineSettings = { notifyMac: true, allowWebReads: false, notifyCommand: '', notifyOnFinish: true }

const run = (changes: Partial<RoutineRun> = {}): RoutineRun => ({
  name: 'daily-report',
  startedAt: 0,
  waits: 0,
  waiting: {},
  ...changes,
})

test('routineName reads the scheduled task tag', () => {
  expect(routineName(PROMPT)).toBe('daily-report')
  expect(routineName(`Some preamble\n${PROMPT}`)).toBe('daily-report')
  expect(routineName("<scheduled-task file='/x/SKILL.md' name='weekly digest'>")).toBe('weekly digest')
  expect(routineName('<scheduled-task name="news &amp; markets">')).toBe('news & markets')
  expect(routineName('<scheduled-task name="  spaced\n  out  ">')).toBe('spaced out')
  expect(routineName(`<scheduled-task name="${'x'.repeat(80)}">`)).toBe(`${'x'.repeat(59)}…`)
})

test('routineName: a tag with no name is a routine all the same; no tag is none', () => {
  expect(routineName('<scheduled-task file="/x/SKILL.md">go</scheduled-task>')).toBe('scheduled task')
  expect(routineName('<scheduled-task name="">')).toBe('scheduled task')
  expect(routineName('Write the daily report')).toBeNull()
  expect(routineName('a <scheduled-tasks> list')).toBeNull()
  expect(routineName('')).toBeNull()
})

test('detectRoutine falls back to a prompt a schedule fired', () => {
  expect(detectRoutine(PROMPT, 'sdk')).toBe('daily-report')
  expect(detectRoutine('check the feeds', 'scheduled-trigger')).toBe('scheduled task')
  expect(detectRoutine('check the feeds', 'composer')).toBeNull()
  expect(detectRoutine('check the feeds', 'sdk')).toBeNull()
})

test('appleScriptString escapes quotes and backslashes and flattens line breaks', () => {
  expect(appleScriptString('plain')).toBe('"plain"')
  expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""')
  expect(appleScriptString('C:\\temp\\')).toBe('"C:\\\\temp\\\\"')
  expect(appleScriptString('a\\"b')).toBe('"a\\\\\\"b"')
  expect(appleScriptString('one\ntwo\r\nthree\tfour')).toBe('"one two three four"')
  // A quote cannot end the literal early and smuggle in a command.
  expect(appleScriptString('x" & do shell script "rm -rf ~" & "')).toBe('"x\\" & do shell script \\"rm -rf ~\\" & \\""')
})

test('osascriptArgv is one -e script with title, message and the Glass sound', () => {
  expect(osascriptArgv('Claude routine: daily-report', 'Waiting for your OK: WebFetch example.com')).toEqual([
    'osascript',
    '-e',
    'display notification "Waiting for your OK: WebFetch example.com" with title "Claude routine: daily-report" sound name "Glass"',
  ])
  const long = osascriptArgv('t', 'm'.repeat(500))[2] ?? ''
  expect(long).toContain(`"${'m'.repeat(239)}…"`)
})

test('commandArgv fills {title} and {message} into single arguments, with no shell', () => {
  const values = { title: 'Claude routine: daily-report', message: 'Waiting for your OK: Bash ls; rm -rf /' }
  expect(commandArgv('curl -s -d {message} ntfy.sh/my-topic', values)).toEqual([
    'curl',
    '-s',
    '-d',
    'Waiting for your OK: Bash ls; rm -rf /',
    'ntfy.sh/my-topic',
  ])
  expect(commandArgv('  curl   -H Title:{title}  -d {message} ntfy.sh/t ', values)).toEqual([
    'curl',
    '-H',
    'Title:Claude routine: daily-report',
    '-d',
    'Waiting for your OK: Bash ls; rm -rf /',
    'ntfy.sh/t',
  ])
})

test('commandArgv never substitutes twice, and is null when no command is set', () => {
  expect(commandArgv('push {title} {message}', { title: '{message}', message: '$(whoami) `id` {title}' })).toEqual([
    'push',
    '{message}',
    '$(whoami) `id` {title}',
  ])
  expect(commandArgv('', { title: 't', message: 'm' })).toBeNull()
  expect(commandArgv('   ', { title: 't', message: 'm' })).toBeNull()
})

test('hostOf names the host without www', () => {
  expect(hostOf('https://www.example.com/markets/today?x=1')).toBe('example.com')
  expect(hostOf('http://user:pw@news.example.org:8080/a')).toBe('news.example.org')
  expect(hostOf('HTTPS://Example.COM')).toBe('example.com')
  expect(hostOf('not a url')).toBe('not a url')
})

test('describeCall labels a call by what it touches', () => {
  expect(describeCall('WebFetch', { url: 'https://www.example.com/a', prompt: 'summarise' })).toBe('WebFetch example.com')
  expect(describeCall('WebSearch', { query: 'markets today' })).toBe('WebSearch "markets today"')
  expect(describeCall('Bash', { command: 'git push\n  origin main' })).toBe('Bash git push origin main')
  expect(describeCall('Write', { file_path: '/Users/me/project/out/digest.md', content: '…' })).toBe('Write digest.md')
  expect(describeCall('mcp__browser__navigate', { url: 'https://example.net/' })).toBe('mcp__browser__navigate example.net')
  expect(describeCall('TodoWrite', { todos: [] })).toBe('TodoWrite')
  expect(describeCall('Odd', null)).toBe('Odd')
  expect(describeCall('Bash', { command: 'x'.repeat(100) })).toBe(`Bash ${'x'.repeat(59)}…`)
})

test('firstQuestion reads the first question asked', () => {
  expect(firstQuestion({ questions: [{ question: 'Which sources?', header: 'Sources' }, { question: 'Second?' }] })).toBe(
    'Which sources?',
  )
  expect(firstQuestion({ questions: [] })).toBe('a question')
  expect(firstQuestion({})).toBe('a question')
})

test('formatDuration says seconds, minutes, then hours', () => {
  expect(formatDuration(0)).toBe('0s')
  expect(formatDuration(45_900)).toBe('45s')
  expect(formatDuration(60_000)).toBe('1m')
  expect(formatDuration(23 * 60_000 + 59_000)).toBe('23m')
  expect(formatDuration(65 * 60_000)).toBe('1h05m')
  expect(formatDuration(-5)).toBe('0s')
})

test('statusLine names the routine and the oldest open wait', () => {
  expect(statusLine(run(), 1_000)).toBe('routine: daily-report')
  const waiting = run({
    waits: 2,
    waiting: {
      a: { since: 100_000, label: 'Bash ls' },
      b: { since: 40_000, label: 'WebFetch example.com' },
    },
  })
  expect(statusLine(waiting, 60_000)).toBe('routine: daily-report · waiting on you <1m')
  expect(statusLine(waiting, 40_000 + 3 * 60_000 + 10_000)).toBe('routine: daily-report · waiting on you 3m')
})

test('finishMessage says how long and how often it waited', () => {
  expect(finishMessage(run({ startedAt: 1_000 }), 1_000 + 23 * 60_000)).toBe(
    'Routine daily-report finished after 23m · never waited on you',
  )
  expect(finishMessage(run({ waits: 1 }), 30_000)).toBe('Routine daily-report finished after 30s · waited on you 1 time')
  expect(finishMessage(run({ waits: 3 }), 2 * 3_600_000)).toBe(
    'Routine daily-report finished after 2h00m · waited on you 3 times',
  )
})

test('describeRun shows the run and the settings, never the push command', () => {
  const settings = { ...SETTINGS, notifyCommand: 'curl -d {message} ntfy.sh/secret-topic' }
  expect(describeRun(null, settings, 0)).toBe(
    [
      'Not a routine session: routine-watch acts only in scheduled-task runs.',
      'Settings: Mac notifications on · web reads ask (allowWebReads off) · phone push on · finish notice on',
    ].join('\n'),
  )
  const busy = run({ waits: 2, waiting: { t1: { since: 5 * 60_000, label: 'WebFetch example.com' } } })
  expect(describeRun(busy, { ...SETTINGS, allowWebReads: true, notifyMac: false }, 8 * 60_000)).toBe(
    [
      'Routine: daily-report',
      'Started 8m ago',
      'Waited on you 2 times · waiting now for 3m: WebFetch example.com',
      'Settings: Mac notifications off · web reads allowed (allowWebReads on) · phone push off · finish notice on',
    ].join('\n'),
  )
  expect(describeRun(run(), SETTINGS, 0).split('\n')[2]).toBe('Has not waited on you')
  expect(describeRun(run(), settings, 0)).not.toContain('secret-topic')
})
