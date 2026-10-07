import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/Users/me/repo'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const LINE = 'main ↑1 ↓2 · 3 changed · PRs #123 ✗ #124 ✓ · 2 owner issues · 2 stale branches · last commit 2h ago'

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const done = (conclusion: string) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion })

/** What a command answers: its stdout, an exit code with output, or `deny` when it cannot start. */
type Reply = string | { exitCode: number; stdout?: string; stderr?: string } | 'deny'

type World = { replies: Record<string, Reply>; ran: string[]; cwds: (string | undefined)[] }

/** A repo mid-work, as git and gh print it. */
const REPLIES: Record<string, Reply> = {
  'git status': '## main...origin/main [ahead 1, behind 2]\nM  hooks/register.tsx\n M README.md\n?? notes.md\n',
  'git log': '220cc0c\t2 hours ago\tjoeldg\tAdd job-watch and machine-guard mods\n1a2b3c4\t3 days ago\tjoeldg\tInitial commit\n',
  'git branch -vv':
    '* main      220cc0c [origin/main: ahead 1, behind 2] Add job-watch\n  old-spike 1d2c7be [origin/old-spike: gone] Try a thing\n',
  'git symbolic-ref': 'origin/main\n',
  'git worktree': `worktree ${CWD}\nHEAD 220cc0c\nbranch refs/heads/main\n`,
  'git remote': 'https://github.com/joeldg/claude-mods.git\n',
  'git branch --merged': '* main\n  fix/merged\n',
  'gh pr': JSON.stringify([
    {
      number: 123,
      title: 'Fix login redirect',
      headRefName: 'fix/login',
      isDraft: false,
      statusCheckRollup: [done('SUCCESS'), done('FAILURE')],
    },
    { number: 124, title: 'Add repo-brief', headRefName: 'repo-brief', isDraft: true, statusCheckRollup: [done('SUCCESS')] },
  ]),
  'gh issue': JSON.stringify([
    { number: 12, title: 'Ship the band', labels: [{ name: 'owner' }] },
    { number: 15, title: 'Write the docs', labels: [{ name: 'owner' }, { name: 'docs' }] },
    { number: 16, title: 'Someday', labels: [{ name: 'idea' }] },
  ]),
}

/** `git --no-optional-locks status …` → `git status`; `git branch -vv` and `--merged` told apart; `gh pr list` → `gh pr`. */
const keyOf = (argv: readonly string[]): string => {
  const [tool = '', ...rest] = argv
  const words = rest.filter(word => word !== '--no-optional-locks')
  return tool === 'git' && words[0] === 'branch' ? `git branch ${words[1]}` : `${tool} ${words[0]}`
}

/** Answers the host beneath the plugin: the session's folder, git and gh, and the engine's own answers. */
const world = (on: On, replies: Record<string, Reply> = REPLIES): World => {
  const w: World = { replies: { ...replies }, ran: [], cwds: [] }
  on('process.run', (_$, e) => {
    const key = keyOf(e.argv)
    w.ran.push(key)
    w.cwds.push(e.init?.cwd)
    const reply = w.replies[key]
    if (reply === undefined || reply === 'deny') {
      return { deny: `${e.argv[0]}: command not found` }
    }
    const out = typeof reply === 'string' ? { exitCode: 0, stdout: reply } : reply
    return {
      value: {
        exitCode: out.exitCode,
        stdout: out.stdout ?? '',
        stderr: out.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // The engine's own band, drawn when the plugin passes: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return w
}

const firstContext = { blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-07." }] }

const TURN = { answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }

type Node = string | { type?: string; children?: Node[] }

/** The text a band draws, nested spans joined, Buttons left out: '' when only the engine's empty band shows. */
const shown = (node: Node): string =>
  typeof node === 'string' ? node : node.type === 'Button' ? '' : (node.children ?? []).map(shown).join('')

test('the first message carries the brief: branch, changes, commits, PRs, issues', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  const out = await $.prompt.context(firstContext)
  expect(out.blocks.map(block => block.name)).toEqual(['currentDate', 'repoBrief'])
  const brief = out.blocks[1]?.text ?? ''
  expect(brief.split('\n')[0]).toBe(
    'Repo state when this session started (gathered by the repo-brief mod; run git yourself for anything newer):',
  )
  expect(brief).toContain('Branch: main tracking origin/main, ahead 1, behind 2')
  expect(brief).toContain('Uncommitted: 3 files (1 staged, 1 unstaged, 1 untracked)')
  expect(brief).toContain('  ?? notes.md')
  expect(brief).toContain('  220cc0c 2 hours ago, joeldg: Add job-watch and machine-guard mods')
  expect(brief).toContain('  #123 ✗ CI failing: Fix login redirect (fix/login)')
  expect(brief).toContain('  #124 ✓ CI passing: Add repo-brief (repo-brief, draft)')
  expect(brief).toContain('Open issues: 3; labelled owner, todo, P0, blocked (2):')
  expect(brief).toContain('  #15 Write the docs [owner, docs]')
  expect(brief).toContain('Stale local branches (2; upstream gone or merged into origin/main): old-spike, fix/merged')
  expect(brief.length).toBeLessThan(2500)
  expect(w.cwds.every(cwd => cwd === CWD)).toBe(true)
})

test('the snapshot gathered at session start is the one the first message gets', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.ran.filter(key => key === 'git status')).toHaveLength(1)
  expect(w.ran).toContain('gh pr')

  const out = await $.prompt.context(firstContext)
  expect(out.blocks.at(-1)?.text).toContain('Branch: main tracking origin/main')
  expect(w.ran.filter(key => key === 'git status')).toHaveLength(1)
})

test('the band draws the one-liner on terminal and desktop, and Hide hides it', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  await $.command.run(typed('brief', ''))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'repo-brief', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await ui.drawn()) as Node)).toBe(LINE)
    // The marks are spans of their own inside the one truncating line.
    expect((await ui.find({ type: 'Text', text: /^ ✗$/ }))?.props.color).toBe('red')
    expect((await ui.find({ type: 'Text', text: /^ ✓$/ }))?.props.color).toBe('green')
    expect((await ui.find({ type: 'Text', text: /^main/ }))?.props.wrap).toBe('truncate-end')

    await ui.press({ key: 'hide' })
    expect(shown((await ui.drawn()) as Node)).toBe('')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()

    // /brief brings the band back.
    await $.command.run(typed('brief', ''))
  }
})

test('the band yields to a survey', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  await $.command.run(typed('brief', ''))
  const ui = await $.ui.mount({
    plugin: 'repo-brief',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, hasSurvey: true },
  })
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()
})

test('outside a git repo there is no brief and no band', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, {
    'git status': { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
  })

  const out = await $.prompt.context(firstContext)
  expect(out.blocks.map(block => block.name)).toEqual(['currentDate'])
  expect(w.ran).toEqual(['git status'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'repo-brief', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await ui.drawn()) as Node)).toBe('')
    await ui.unmount()
  }
  expect((await $.command.run(typed('brief', ''))).text).toBe(`repo-brief: ${CWD} is not inside a git repository.`)
})

test('when gh fails the brief still has the git side and no PR section', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on, { ...REPLIES, 'gh pr': 'deny', 'gh issue': { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } })

  const brief = (await $.prompt.context(firstContext)).blocks.at(-1)?.text ?? ''
  expect(brief).toContain('Branch: main tracking origin/main, ahead 1, behind 2')
  expect(brief).toContain('220cc0c 2 hours ago')
  expect(brief).not.toContain('Open PRs')
  expect(brief).not.toContain('Open issues')
  expect(brief).toContain('PRs and issues: not gathered')

  const ui = await $.ui.mount({ plugin: 'repo-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toBe('main ↑1 ↓2 · 3 changed · 2 stale branches · last commit 2h ago')
  await ui.unmount()
})

test('/brief re-gathers and returns the whole summary', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)

  const first = await $.command.run(typed('brief', ''))
  expect(first.text?.split('\n')[0]).toBe('Repo state just now (gathered by the repo-brief mod):')
  expect(first.text).toContain('Branch: main tracking origin/main, ahead 1, behind 2')
  expect(first.text).toContain('#123 ✗ CI failing')

  w.replies['git status'] = '## main...origin/main\n'
  const second = await $.command.run(typed('brief', ''))
  expect(second.text).toContain('Branch: main tracking origin/main, up to date')
  expect(second.text).toContain('Working tree: clean')
  expect(w.ran.filter(key => key === 'git status')).toHaveLength(2)
})

test('a finished turn refreshes the band at most every refreshMinutes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await $.command.run(typed('brief', ''))
  w.replies['git status'] = '## main...origin/main [ahead 3]\n'

  await clock.advance(60_000)
  await $.turn.complete(TURN)
  await clock.settle()
  expect(w.ran.filter(key => key === 'git status')).toHaveLength(1)

  await clock.advance(61_000)
  await $.turn.complete(TURN)
  await clock.settle()
  expect(w.ran.filter(key => key === 'git status')).toHaveLength(2)
  const ui = await $.ui.mount({ plugin: 'repo-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toMatch(/^main ↑3 · clean · /)
  await ui.unmount()
})

test(
  'with briefClaude off the first message is left alone',
  { options: { briefClaude: false, focusLabels: 'idea' } },
  async ($, on) => {
    mock.clock(on, { now: 0 })
    world(on)
    // A test's options reach `register` from Claude Code 2.1.289 on; an older kit hands it the defaults,
    // which /brief shows by the focus labels it lists, and then there is nothing here to check.
    const brief = await $.command.run(typed('brief', ''))
    if (!brief.text?.includes('#16 Someday [idea]')) {
      return
    }
    const out = await $.prompt.context(firstContext)
    expect(out.blocks.map(block => block.name)).toEqual(['currentDate'])
  },
)
