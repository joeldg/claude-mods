import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On } from 'claude-code'

import { projectKey } from '../hooks/review'

const HOME = '/Users/me'
const CWD = '/Users/me/project'
const NOW = Date.UTC(2026, 9, 7, 14, 3, 5)
const DIR = `${HOME}/.claude/second-opinions/${projectKey(CWD)}`
const SAVED = `${DIR}/2026-10-07T14-03-05Z.md`
const LOG_FORMAT = '--format=%h %ad %an: %s%n%b'
const USAGE = { input_tokens: 21_000, output_tokens: 1_800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const REVIEW = [
  '## Wrong assumptions',
  '- `src/cache.ts:12` treats a TTL of 0 as "never expire"; the callers in `abc1234` mean "do not cache".',
  '## Bugs and risks',
  '- Nothing significant.',
  "## What's missing",
  '- A test for eviction.',
  '## What to do next',
  '1. Decide what TTL 0 means.',
].join('\n')

const LOG = 'abc1234 2026-10-06 Dev: Add a cache in front of the API\n\n src/cache.ts | 40 ++++++++\n 1 file changed\n'
const DIFF = 'diff --git a/src/cache.ts b/src/cache.ts\n+export const ttl = 0\n'
const STATUS = ' M src/cache.ts\n?? notes.md\n'

const PANE_PROPS = {
  title: 'Second opinion',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** A slash command as the person types it. */
const typed = (args: string) => ({
  command: 'second-opinion',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

type Answer = { code?: number; out?: string; err?: string }

type World = {
  /** git's answers by its arguments, joined with spaces; a command not listed fails. */
  git: Map<string, Answer>
  ran: string[]
  cwds: (string | undefined)[]
  toasts: string[]
  statuses: (string | undefined)[]
  logs: string[]
  opened: { id: string; title?: string; focus?: true }[]
  closed: string[]
  files: Map<string, string>
  writes: string[]
  fills: string[]
  completes: ModelCompleteRequest[]
  reply: ModelCompleteResult | 'refuse'
}

/** A repository on main with 30 commits and two changed files. */
const ON_MAIN: Record<string, Answer> = {
  'rev-parse --show-toplevel': { out: `${CWD}\n` },
  'branch --show-current': { out: 'main\n' },
  'rev-parse --verify --quiet HEAD': { out: `${'a'.repeat(40)}\n` },
  'status --short': { out: STATUS },
  'symbolic-ref --short refs/remotes/origin/HEAD': { out: 'origin/main\n' },
  'rev-list --count HEAD': { out: '30\n' },
  [`log -12 --stat --no-color --date=short ${LOG_FORMAT}`]: { out: LOG },
  'diff --no-color --no-ext-diff HEAD~12 HEAD': { out: DIFF },
}

/** Answers the host beneath the plugin: git, the files, the model, the prompt box and the screen. */
const world = (on: On, git: Record<string, Answer> = ON_MAIN): World => {
  const w: World = {
    git: new Map(Object.entries(git)),
    ran: [],
    cwds: [],
    toasts: [],
    statuses: [],
    logs: [],
    opened: [],
    closed: [],
    files: new Map(),
    writes: [],
    fills: [],
    completes: [],
    reply: { isAnswered: true, text: `\n${REVIEW}\n`, usage: USAGE },
  }
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const [tool, ...args] = e.argv
    const key = args.join(' ')
    w.ran.push(`${tool} ${key}`)
    w.cwds.push(e.init?.cwd)
    const answer = tool === 'git' ? w.git.get(key) : undefined
    return {
      value: {
        exitCode: answer ? (answer.code ?? 0) : 1,
        stdout: answer?.out ?? '',
        stderr: answer ? (answer.err ?? '') : `unexpected: ${tool} ${key}`,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file, open '${e.path}'` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = [...w.files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => path.slice(prefix.length))
    return names.length === 0
      ? { deny: `ENOENT: no such directory '${e.path}'` }
      : { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('model.complete', (_$, e) => {
    w.completes.push(e)
    return w.reply === 'refuse' ? { deny: 'the model claude-fable-5-1 is not allowed here' } : { value: w.reply }
  })
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push({ id: e.id, ...(e.title ? { title: e.title } : {}), ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  return w
}

const mountPane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'second-opinion', surface, component: 'Pane', requestId: 'second-opinion', props: PANE_PROPS })

test('a default run gathers the recent work, answers at once and reviews in the background', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)

  const ran = await $.command.run(typed(''))
  expect(ran.text).toBe(
    'Fable is reviewing 12 commits (one Fable call)… It opens in a pane when it is ready; /second-opinion show reopens it.',
  )
  // The command answered before the model was asked.
  expect(w.completes).toHaveLength(0)
  expect(w.statuses).toEqual(['second opinion: reviewing…'])
  expect(w.ran).toContain(`git log -12 --stat --no-color --date=short ${LOG_FORMAT}`)
  expect(w.ran).toContain('git diff --no-color --no-ext-diff HEAD~12 HEAD')
  expect(w.ran).toContain('git status --short')
  expect(w.cwds.every(cwd => cwd === CWD)).toBe(true)

  await clock.settle()
  expect(w.completes).toHaveLength(1)
  const call = w.completes[0]
  expect(call?.model).toBe('claude-fable-5-1')
  expect(call?.effort).toBe('high')
  expect(call?.prompt).toContain('Under review: the last 12 commits on main')
  expect(call?.prompt).toContain(`<git_log>\n${LOG.trimEnd()}\n</git_log>`)
  expect(call?.prompt).toContain(`<git_diff>\n${DIFF.trimEnd()}\n</git_diff>`)
  expect(call?.prompt).toContain(`<git_status>\n${STATUS.trim()}\n</git_status>`)
  expect(call?.prompt).toContain('## Wrong assumptions')

  expect(w.writes).toEqual([SAVED])
  const saved = w.files.get(SAVED) ?? ''
  expect(saved.split('\n')[0]).toBe('# Second opinion: the last 12 commits on main')
  expect(saved).toContain('- Model: claude-fable-5-1 (effort high)')
  expect(saved).toContain('- Tokens: 21000 in, 1800 out')
  expect(saved).toContain(REVIEW)
  expect(w.toasts).toEqual(['Second opinion ready (/second-opinion show)'])
  expect(w.opened).toEqual([{ id: 'second-opinion', title: 'Second opinion' }])
  expect(w.statuses.at(-1)).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const markdown = await ui.findAll({ type: 'Markdown' })
    expect(markdown.map((found: { props: Record<string, unknown> }) => found.props.text).join('\n')).toBe(REVIEW)
    expect(await ui.find({ type: 'Text', text: /^Fable on the last 12 commits on main · 2026-10-07 14:03 UTC/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'send' }))?.props.label).toBe('Send to Claude')
    expect((await ui.find({ type: 'Button', key: 'close' }))?.props.label).toBe('Close')
    await ui.unmount()
  }
})

test('on a feature branch it reviews the branch against the default branch', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, {
    ...ON_MAIN,
    'branch --show-current': { out: 'feature/cache\n' },
    'rev-list --count origin/main..HEAD': { out: '3\n' },
    'merge-base origin/main HEAD': { out: `${'b'.repeat(40)}\n` },
    [`log -12 --stat --no-color --date=short ${LOG_FORMAT} origin/main..HEAD`]: { out: LOG },
    [`diff --no-color --no-ext-diff ${'b'.repeat(40)}...HEAD`]: { out: DIFF },
  })

  const ran = await $.command.run(typed(''))
  expect(ran.text).toMatch(/^Fable is reviewing 3 commits on feature\/cache \(one Fable call\)…/)
  await clock.settle()
  const prompt = w.completes[0]?.prompt ?? ''
  expect(prompt).toContain('Project: project (branch feature/cache)')
  expect(prompt).toContain('Under review: the branch feature/cache, 3 commits ahead of origin/main')
  expect(prompt).toContain(`<git_diff>\n${DIFF.trimEnd()}\n</git_diff>`)
  expect(w.ran).not.toContain('git rev-list --count HEAD')
})

test(
  'the configured model and effort are the ones called, and a question focuses the review',
  { options: { model: 'claude-opus-5-5', effort: 'xhigh', maxContextChars: 5_000 } },
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, { ...ON_MAIN, 'diff --no-color --no-ext-diff HEAD~12 HEAD': { out: '+x\n'.repeat(20_000) } })

    const ran = await $.command.run(typed('is a TTL of 0 intended?'))
    expect(ran.text).toMatch(/^Opus is reviewing 12 commits \(one Opus call\)…/)
    expect(ran.text).toMatch(/cut to fit 5,000 characters: Their combined diff/)
    await clock.settle()
    expect(w.completes[0]?.model).toBe('claude-opus-5-5')
    expect(w.completes[0]?.effort).toBe('xhigh')
    const prompt = w.completes[0]?.prompt ?? ''
    expect(prompt).toContain('"## Their question"')
    expect(prompt).toContain('is a TTL of 0 intended?')
    expect(prompt).toMatch(/more characters cut to fit the context cap\]\n<\/git_diff>/)
    expect(prompt.length).toBeLessThan(5_000 + 3_000)
    expect(w.files.get(SAVED)).toContain('- Focus: is a TTL of 0 intended?')
  },
)

test('Send to Claude attaches the review to the next prompt only, once, and fills the box', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.command.run(typed(''))
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'send' })
    expect(w.fills.at(-1)).toBe(
      "Here's a second opinion from Fable (attached). What do you agree with, and what would you act on?",
    )
    expect(await ui.find({ type: 'Text', text: 'Attached to your next prompt.' })).toBeDefined()

    // A prompt that is not the person's (a task's notification) leaves it armed.
    const notified = await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    expect(notified.context).toBeUndefined()

    const first = await $.prompt.submit({ text: 'What do you agree with?', wait: false, origin: { kind: 'composer' } })
    expect(first.context).toHaveLength(1)
    const block = first.context?.[0] ?? ''
    expect(block).toMatch(/^A second opinion from Fable \(claude-fable-5-1, effort high\) on the last 12 commits on main/)
    expect(block).toContain(`<second_opinion>\n${REVIEW}\n</second_opinion>`)

    const second = await $.prompt.submit({ text: 'And next?', wait: false, origin: { kind: 'composer' } })
    expect(second.context).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Attached to your next prompt.' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['second-opinion'])
  await ui.unmount()
})

test('file <path> reviews that file, read from the session folder', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, {
    ...ON_MAIN,
    'log -8 --no-color --date=short --format=%h %ad %s': { out: 'abc1234 2026-10-06 Add a cache\n' },
  })
  w.files.set(`${CWD}/docs/plan.md`, '# Plan\n\nCache every API response forever.\n')

  const ran = await $.command.run(typed('file docs/plan.md'))
  expect(ran.text).toMatch(/^Fable is reviewing docs\/plan\.md \(one Fable call\)…/)
  await clock.settle()
  const prompt = w.completes[0]?.prompt ?? ''
  expect(prompt).toContain('Under review: docs/plan.md')
  expect(prompt).toContain('<document>\n# Plan\n\nCache every API response forever.\n</document>')
  expect(prompt).toContain('abc1234 2026-10-06 Add a cache')
  expect(w.writes).toEqual([SAVED])

  const missing = await $.command.run(typed('file docs/nope.md'))
  expect(missing.text).toMatch(/^second-opinion: could not read docs\/nope\.md: /)
  expect(w.toasts.at(-1)).toBe(missing.text)
  expect(w.completes).toHaveLength(1)
})

test('a failed model call toasts why, saves nothing and clears the status', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } }

  await $.command.run(typed(''))
  await clock.settle()
  expect(w.toasts).toEqual(['Second opinion failed: the API answered HTTP 529 (overloaded)'])
  expect(w.logs).toContain(
    'second-opinion: Fable could not review the last 12 commits on main: the API answered HTTP 529 (overloaded). Nothing was saved.',
  )
  expect(w.writes).toEqual([])
  expect(w.opened).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()

  // A model the engine refuses to call is reported the same way, and the next run may start.
  w.reply = 'refuse'
  const again = await $.command.run(typed(''))
  expect(again.text).toMatch(/^Fable is reviewing/)
  await clock.settle()
  expect(w.toasts.at(-1)).toMatch(/^Second opinion failed: the request was refused: /)
  expect(w.writes).toEqual([])
})

test('outside a git repository it says so, toasts, and calls no model', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, {
    'rev-parse --show-toplevel': { code: 128, err: 'fatal: not a git repository (or any of the parent directories): .git\n' },
  })

  const ran = await $.command.run(typed(''))
  expect(ran.text).toBe(
    'second-opinion: /Users/me/project is not inside a git repository. /second-opinion file <path> reviews a plan or spec without one.',
  )
  expect(w.toasts).toEqual([ran.text])
  await clock.settle()
  expect(w.completes).toEqual([])
  expect(w.statuses).toEqual([])
})

test('one review runs at a time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.command.run(typed(''))

  // The first review's call has not been made yet: its timer waits on the clock.
  const second = await $.command.run(typed('commits 3'))
  expect(second.text).toBe(
    'Fable is still reviewing the last 12 commits on main (started 0s ago); one review runs at a time.',
  )
  await clock.settle()
  expect(w.completes).toHaveLength(1)

  const third = await $.command.run(typed('diff'))
  expect(third.text).toMatch(/^Fable is reviewing the uncommitted changes/)
})

test('diff with nothing uncommitted says so and calls no model', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, { ...ON_MAIN, 'status --short': { out: '' }, 'diff --no-color --no-ext-diff HEAD': { out: '' } })
  const ran = await $.command.run(typed('diff'))
  expect(ran.text).toBe('second-opinion: there are no uncommitted changes to review.')
  await clock.settle()
  expect(w.completes).toEqual([])
})

test('show reopens the newest saved review and list lists them', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  const older = `${DIR}/2026-10-01T09-00-00Z.md`
  w.files.set(
    older,
    '# Second opinion: docs/plan.md\n\n- Model: claude-fable-5-1 (effort high)\n- Project: project\n\n---\n\nThe plan skips migrations.\n',
  )
  w.files.set(
    SAVED,
    '# Second opinion: the last 12 commits on main\n\n- Model: claude-fable-5-1 (effort max)\n- Project: project\n\n---\n\n## Bugs and risks\n- None.\n',
  )
  w.files.set(`${DIR}/notes.txt`, 'not a review')

  const listed = await $.command.run(typed('list'))
  expect(listed.text).toBe(
    [
      `Second opinions for this project, newest first (${DIR}):`,
      ' 1. 2026-10-07 14:03 UTC · the last 12 commits on main',
      ' 2. 2026-10-01 09:00 UTC · docs/plan.md',
      '/second-opinion show <n> opens one.',
    ].join('\n'),
  )

  const shown = await $.command.run(typed('show'))
  expect(shown.text).toBe(`Showing the second opinion on the last 12 commits on main from 2026-10-07 14:03 UTC (${SAVED}).`)
  expect(w.opened).toEqual([{ id: 'second-opinion', title: 'Second opinion', focus: true }])

  await $.command.run(typed('show 2'))
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('The plan skips migrations.')
  await ui.unmount()

  expect((await $.command.run(typed('show 9'))).text).toBe(
    'There is no saved second opinion #9 for this project. /second-opinion list shows them.',
  )
})

test('with nothing saved, show and list say how to start, and the pane says so too', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on)
  expect((await $.command.run(typed('show'))).text).toBe('No second opinion yet for this project. /second-opinion asks for one.')
  expect((await $.command.run(typed('list'))).text).toBe(
    'No second opinions are saved for this project yet. /second-opinion asks for one.',
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'No second opinion yet. /second-opinion asks for one.' })).toBeDefined()
    await ui.unmount()
  }
})
