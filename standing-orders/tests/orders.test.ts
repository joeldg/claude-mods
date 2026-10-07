import { expect, test } from 'claude-code/testing'

import {
  BLOCK_LEAD,
  MAX_TEXT,
  USAGE,
  blockText,
  exportMarkdown,
  findDirective,
  goalChange,
  listText,
  normalizeOrder,
  ordersPath,
  parseOrdersCommand,
  parseProjectFile,
  projectKey,
  sameOrder,
  serializeProjectFile,
  tildePath,
  unsentText,
} from '../hooks/orders'
import type { Order } from '../types'

const order = (text: string, addedAt = 0): Order => ({ text, addedAt })

test('the instructions people repeated after compactions are offered as orders', () => {
  const cases: [string, string][] = [
    ['make sure to reload ~/.claude/CLAUDE.md', 'make sure to reload ~/.claude/CLAUDE.md'],
    ["please don't lose track of where we were", "don't lose track of where we were"],
    ["don't try to open bambu with full spectrum files", "don't try to open bambu with full spectrum files"],
    [
      'we shouldn\u2019t be using X as far as I know, the ADR states we are using other models',
      "we shouldn't be using X as far as I know, the ADR states we are using other models",
    ],
    ['never open bambu with full spectrum files', 'never open bambu with full spectrum files'],
  ]
  for (const [prompt, expected] of cases) {
    expect(findDirective(prompt)).toBe(expected)
  }
})

test('every trigger phrase is recognised, the clause it starts in kept', () => {
  const cases: [string, string][] = [
    ['Always run the tests before you commit.', 'Always run the tests before you commit'],
    ['Thanks, that worked. From now on, never push to main without asking.', 'From now on, never push to main without asking'],
    ['going forward use pnpm instead of npm', 'going forward use pnpm instead of npm'],
    ['remember to update the changelog when you bump the version', 'remember to update the changelog when you bump the version'],
    ['remember that the ADR says we use the other models', 'remember that the ADR says we use the other models'],
    ['In this project we use tabs, not spaces.', 'In this project we use tabs, not spaces'],
    ['we use pnpm in this project', 'we use pnpm in this project'],
    ['For this job, use PETG at 0.2mm layers', 'For this job, use PETG at 0.2mm layers'],
    ['stop adding comments to every line', 'stop adding comments to every line'],
    ['Do not amend commits that were already pushed', 'Do not amend commits that were already pushed'],
    ["we don't use Redux in this repo", "we don't use Redux in this repo"],
    ['Claude, never commit .env files.', 'never commit .env files'],
    ['Please always use `bun` instead of npm', 'always use `bun` instead of npm'],
    ['- never edit src/generated/api/types.ts by hand', 'never edit src/generated/api/types.ts by hand'],
    ['Reminder: never push to main', 'never push to main'],
    ["don't do anything yet, but always run the linter first", 'always run the linter first'],
  ]
  for (const [prompt, expected] of cases) {
    expect(findDirective(prompt)).toBe(expected)
  }
})

test('a restated order is offered as the order itself', () => {
  expect(findDirective('I told you not to open bambu with full spectrum files')).toBe(
    "don't open bambu with full spectrum files",
  )
  expect(findDirective("I've already told you to always use pnpm here")).toBe('always use pnpm here')
  expect(findDirective("I'd like you to never amend pushed commits")).toBe('never amend pushed commits')
  expect(findDirective('I want you to stop rewriting my tests')).toBe('stop rewriting my tests')
})

test('questions, remarks and one-off phrasing are not orders', () => {
  for (const prompt of [
    "don't worry about the CPU",
    'what do you think?',
    'always nice to see',
    'just for clarity, what is your goal?',
    "don't do anything yet",
    'never mind, that is fine',
    'I never said that',
    "there's a bug in this project",
    'Do you always run tests before committing',
    'can you make sure to run tests?',
    'you never listen to me',
    'Claude never listens to me',
    'never do that again',
    'stop doing that',
    "I'll be more careful going forward",
    'never push to main today',
    "you shouldn't have done that",
    'always has been',
    'Always a pleasure',
    'never seen that before',
    "Don't get me wrong, it works",
    "we don't need that",
    'fix the failing test in auth.ts',
    '',
  ]) {
    expect(findDirective(prompt)).toBeNull()
  }
})

test('pasted logs, code fences and slash commands are passed over', () => {
  const log = [
    "Here's the build output:",
    '2026-10-07 12:00:01 WARN never retried the connection',
    'npm WARN deprecated left-pad@1.0: always use the latest',
    '    at Object.<anonymous> (/srv/app/index.js:10:5)',
    'Error: Do not call setState in render',
    'TypeError: never is not a function',
    '[worker 3] always-on mode enabled',
    '{"level":"warn","msg":"never retry"}',
  ].join('\n')
  expect(findDirective(log)).toBeNull()

  // A long paste: only its first and last few lines are read, so a log line that reads as prose is skipped.
  const long = ['why does the deploy fail?', ...Array.from({ length: 30 }, (_, i) => `step ${i} done`)]
  long.splice(15, 0, 'Never use the cache for this step because it is stale')
  expect(findDirective(long.join('\n'))).toBeNull()

  const fenced = '```\n// always close the handle\nnever();\n```\nwhat does this do?'
  expect(findDirective(fenced)).toBeNull()

  expect(findDirective('/orders add never push to main')).toBeNull()

  // The person's own line after a paste still counts.
  expect(findDirective(`${log}\nfrom now on, run the build with --verbose`)).toBe('from now on, run the build with --verbose')
})

test('orders are normalized: one line, trimmed, quotes and trailing punctuation dropped, capped', () => {
  expect(normalizeOrder('  never   push\n to main.  ')).toBe('never push to main')
  expect(normalizeOrder('\u201cnever push to main\u201d')).toBe('never push to main')
  expect(normalizeOrder('don\u2019t touch the lockfile!')).toBe("don't touch the lockfile")
  const long = normalizeOrder(`always ${'remember the details '.repeat(20)}`)
  expect(long).toHaveLength(MAX_TEXT)
  expect(long.endsWith('…')).toBe(true)
  expect(sameOrder('Never push to main.', 'never  push to main')).toBe(true)
  expect(sameOrder('never push to main', 'never push to prod')).toBe(false)
})

test('the project key is the folder made filename-safe, as ~/.claude/projects names them', () => {
  expect(projectKey('/Users/me/project')).toBe('-Users-me-project')
  expect(projectKey('/Users/me/project/')).toBe('-Users-me-project')
  expect(projectKey('/Users/me/my.app_v2')).toBe('-Users-me-my-app-v2')
  expect(projectKey('C:\\Users\\me\\project')).toBe('C--Users-me-project')

  const deep = `/Users/me/${'nested/'.repeat(30)}project`
  const key = projectKey(deep)
  expect(key.length).toBeLessThanOrEqual(120)
  expect(key).toMatch(/-[0-9a-f]{8}$/)
  expect(projectKey(deep)).toBe(key)
  expect(projectKey(`${deep}2`)).not.toBe(key)

  expect(ordersPath('/Users/me', '/Users/me/project')).toBe('/Users/me/.claude/standing-orders/-Users-me-project.json')
  expect(ordersPath('/Users/me/', '/Users/me/project')).toBe('/Users/me/.claude/standing-orders/-Users-me-project.json')
  expect(tildePath('/Users/me/.claude/standing-orders/x.json', '/Users/me')).toBe('~/.claude/standing-orders/x.json')
  expect(tildePath('/Users/meow/x.json', '/Users/me')).toBe('/Users/meow/x.json')
  expect(tildePath('/srv/x.json', undefined)).toBe('/srv/x.json')
})

test('a project file round-trips, and one that is not orders is reported, not emptied', () => {
  const orders = [order('never push to main', 5), order('use pnpm', 6)]
  const text = serializeProjectFile('/Users/me/project', orders)
  expect(JSON.parse(text)).toEqual({ root: '/Users/me/project', orders })
  expect(parseProjectFile(text)).toEqual(orders)

  expect(parseProjectFile('')).toEqual([])
  expect(parseProjectFile('["never push to main", "  "]')).toEqual([order('never push to main')])
  expect(parseProjectFile('{"orders": [{"text": 3}, {"text": "use pnpm", "addedAt": "x"}]}')).toEqual([order('use pnpm')])
  expect(parseProjectFile('{not json')).toBeNull()
  expect(parseProjectFile('{"rules": []}')).toBeNull()
})

test('the context block lists project orders, session orders and the goal; nothing when empty', () => {
  expect(blockText([], [], null)).toBeNull()
  expect(blockText([order('never push to main')], [order('use the staging db')], 'all tests in test/auth pass')).toBe(
    [
      BLOCK_LEAD,
      'For this project:',
      '- never push to main',
      'For this session:',
      '- use the staging db',
      'Active goal: all tests in test/auth pass',
    ].join('\n'),
  )
  expect(blockText([], [], 'ship the release')).toBe(`${BLOCK_LEAD}\nActive goal: ship the release`)
  expect(blockText([order('never push to main')], [], null)).toBe(`${BLOCK_LEAD}\nFor this project:\n- never push to main`)
})

test('the note for orders kept mid-conversation names their scope', () => {
  expect(unsentText([{ text: 'never push to main', scope: 'project' }])).toBe(
    'A standing order was just added (kept by the standing-orders mod; follow it unless the user says otherwise):\n- never push to main (for this project)',
  )
  expect(
    unsentText([
      { text: 'never push to main', scope: 'project' },
      { text: 'use the staging db', scope: 'session' },
    ]).split('\n'),
  ).toEqual([
    'Standing orders were just added (kept by the standing-orders mod; follow them unless the user says otherwise):',
    '- never push to main (for this project)',
    '- use the staging db (for this session)',
  ])
})

test('the listing numbers project orders first, then session orders', () => {
  const text = listText({
    root: '/Users/me/project',
    file: '~/.claude/standing-orders/-Users-me-project.json',
    project: [order('never push to main'), order('use pnpm')],
    session: [order('use the staging db')],
    goal: 'ship it',
  })
  expect(text.split('\n')).toEqual([
    'Standing orders for /Users/me/project:',
    'This project (~/.claude/standing-orders/-Users-me-project.json):',
    '  1. never push to main',
    '  2. use pnpm',
    'This session:',
    '  3. use the staging db',
    'Active goal: ship it',
  ])
  expect(listText({ root: '/Users/me/project', file: null, project: [], session: [], goal: null })).toMatch(
    /^No standing orders for \/Users\/me\/project\./,
  )
})

test('export is a Markdown list in a fence, ready for CLAUDE.md', () => {
  expect(exportMarkdown([])).toBeNull()
  expect(exportMarkdown([order('never push to main'), order('use `pnpm`')])).toBe(
    ['```markdown', '## Standing orders', '', '- never push to main', '- use `pnpm`', '```'].join('\n'),
  )
  expect(exportMarkdown([order('wrap code in ``` fences')])?.startsWith('````markdown')).toBe(true)
})

test('/orders arguments', () => {
  expect(parseOrdersCommand('')).toEqual({ verb: 'list' })
  expect(parseOrdersCommand(' list ')).toEqual({ verb: 'list' })
  expect(parseOrdersCommand('add never push to main')).toEqual({ verb: 'add', scope: 'project', text: 'never push to main' })
  expect(parseOrdersCommand('add session  use the staging db.')).toEqual({
    verb: 'add',
    scope: 'session',
    text: 'use the staging db',
  })
  expect(parseOrdersCommand('add Project use pnpm')).toEqual({ verb: 'add', scope: 'project', text: 'use pnpm' })
  expect(parseOrdersCommand('add projects use pnpm')).toEqual({ verb: 'add', scope: 'project', text: 'projects use pnpm' })
  expect(parseOrdersCommand('add session')).toEqual({ verb: 'usage' })
  expect(parseOrdersCommand('forget 2')).toEqual({ verb: 'forget', number: 2 })
  expect(parseOrdersCommand('forget #3')).toEqual({ verb: 'forget', number: 3 })
  expect(parseOrdersCommand('forget zero')).toEqual({ verb: 'usage' })
  expect(parseOrdersCommand('forget 0')).toEqual({ verb: 'usage' })
  expect(parseOrdersCommand('clear session')).toEqual({ verb: 'clear', scope: 'session' })
  expect(parseOrdersCommand('clear project')).toEqual({ verb: 'clear', scope: 'project' })
  expect(parseOrdersCommand('clear')).toEqual({ verb: 'usage' })
  expect(parseOrdersCommand('export')).toEqual({ verb: 'export' })
  expect(parseOrdersCommand('dance')).toEqual({ verb: 'usage' })
  expect(USAGE).toContain('/orders add [project|session] <text>')
})

test('/goal sets the goal, /goal clear clears it, a bare /goal leaves it', () => {
  expect(goalChange('  all tests in test/auth pass  ')).toBe('all tests in test/auth pass')
  expect(goalChange('clear')).toBeNull()
  expect(goalChange('')).toBeUndefined()
  expect(goalChange('x'.repeat(600))).toHaveLength(500)
})
