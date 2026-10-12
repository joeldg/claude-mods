import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/Users/me/widgets'
const URL_219 = 'https://github.com/acme/widgets/pull/219'
const HEAD = 'b'.repeat(40)
const FIELDS = 'number,url,state,title,headRefName,headRefOid,statusCheckRollup,mergedAt'
const VIEW_219 = `gh pr view 219 --repo acme/widgets --json ${FIELDS}`
/** The same read without the checks: what a token lacking "Checks: read" may still read. */
const PLAIN_FIELDS = 'number,url,state,title,headRefName,headRefOid,mergedAt'
const PLAIN_VIEW_219 = `gh pr view 219 --repo acme/widgets --json ${PLAIN_FIELDS}`
const LIST = 'gh pr list --author @me --state open --json number,url,state,title,headRefName,headRefOid,statusCheckRollup --limit 20'
const PLAIN_LIST = 'gh pr list --author @me --state open --json number,url,state,title,headRefName,headRefOid --limit 20'
const CHECKS_DENIED =
  'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.contexts.nodes)'
const NOT_LOGGED_IN = 'HTTP 401: Requires authentication (https://api.github.com/graphql)'
const TOOL = 'mcp__pr-autopilot__prs_status'
const SESSION = { cwd: CWD, surface: 'terminal' as const, isInteractive: true }

type Answer = { code?: number; out?: string; err?: string }
type Ran = { argv: string; cwd: string | undefined }

type World = {
  answers: Map<string, Answer | (() => Answer)>
  ran: Ran[]
  toasts: string[]
  statuses: (string | undefined)[]
  suggested: string[]
  bash: string[]
  logs: string[]
  tools: { name: string; description: string; isDeferred?: boolean }[]
}

/** A GitHub Actions check run as `statusCheckRollup` lists it. */
const run = (name: string, status: string, conclusion: string, runId = 111) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/widgets/actions/runs/${runId}/job/9${runId}`,
})

/** What `gh pr view 219 --json …` prints. */
const view219 = (state: string, rollup: unknown[] = []) =>
  JSON.stringify({
    number: 219,
    url: URL_219,
    state,
    title: 'Faster widgets',
    headRefName: 'codex/faster',
    headRefOid: HEAD,
    statusCheckRollup: rollup,
    mergedAt: state === 'MERGED' ? '2026-10-07T10:00:00Z' : null,
  })

/** The same, read without the checks. */
const plain219 = (state: string) => {
  const full = JSON.parse(view219(state)) as Record<string, unknown>
  delete full.statusCheckRollup
  return JSON.stringify(full)
}

/** The git a clean checkout of acme/widgets on the PR's branch answers. */
const CLEAN_ON_PR_BRANCH: Record<string, Answer> = {
  'git remote get-url origin': { out: 'git@github.com:acme/widgets.git\n' },
  'git fetch --prune origin': {},
  'git symbolic-ref --short refs/remotes/origin/HEAD': { out: 'origin/main\n' },
  'git branch --show-current': { out: 'codex/faster\n' },
  'git status --porcelain --untracked-files=no': { out: '' },
  'git switch main': { err: "Switched to branch 'main'\n" },
  'git pull --ff-only origin main': { out: 'Updating 1111111..2222222\nFast-forward\n' },
  'git rev-parse --verify --quiet refs/heads/codex/faster': { out: `${HEAD}\n` },
  'git worktree list --porcelain': { out: `worktree ${CWD}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/main\n\n` },
  'git branch -D codex/faster': { out: 'Deleted branch codex/faster (was bbbbbbb).\n' },
}

/** Answers the host beneath the plugin: commands by argv, toasts, the status line, the prompt box. */
const world = (on: On): World => {
  const w: World = { answers: new Map(), ran: [], toasts: [], statuses: [], suggested: [], bash: [], logs: [], tools: [] }
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    w.ran.push({ argv, cwd: e.init?.cwd })
    const found = w.answers.get(argv)
    const answer = typeof found === 'function' ? found() : found
    return {
      value: {
        exitCode: answer ? (answer.code ?? 0) : 1,
        stdout: answer?.out ?? '',
        stderr: answer ? (answer.err ?? '') : `unexpected command: ${argv}`,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
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
  on('tool.register', (_$, e) => {
    w.tools.push({ name: e.name, description: e.description, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__pr-autopilot__${e.name}` } }
  })
  on('prompt.suggest', (_$, e) => {
    w.suggested.push(e.text)
    return { isShown: true }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.bash.push(e.command)
    const text = /gh pr create/.test(e.command)
      ? `\nCreating pull request for codex/faster into main in acme/widgets\n\n${URL_219}\n`
      : 'ok'
    return { result: { stdout: text, stderr: '', interrupted: false }, text }
  })
  return w
}

/** The git commands the plugin ran, in order. */
const gitRan = (w: World): string[] => w.ran.filter(one => one.argv.startsWith('git ')).map(one => one.argv)

/** Every command the plugin ran, in order. */
const argvs = (w: World): string[] => w.ran.map(one => one.argv)

/** How many times one command ran. */
const count = (w: World, argv: string): number => argvs(w).filter(one => one === argv).length

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const createPr = (w: World, rollup: () => unknown[], state: () => string = () => 'OPEN') =>
  w.answers.set(VIEW_219, () => ({ out: view219(state(), rollup()) }))

test('a PR opened with gh pr create is watched and shown on the status line', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const w = world(on)
  createPr(w, () => [run('lint', 'IN_PROGRESS', '')])

  await $.tool.call({ tool: 'Bash', command: 'git push -u origin codex/faster && gh pr create --fill --base main' })
  expect(w.bash).toHaveLength(1)
  expect(w.ran.map(one => one.argv)).toEqual([VIEW_219])
  expect(w.statuses.at(-1)).toBe('PRs: #219 CI…')

  const listed = await $.command.run(typed('prs', ''))
  expect(listed.text).toBe('#219 acme/widgets · open · CI running · codex/faster · Faster widgets')
})

test('other Bash commands are left alone', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: `echo ${URL_219}` })
  expect(w.ran).toEqual([])
  expect(w.statuses).toEqual([])
})

test('a poll that sees CI fail toasts the failing check, and again when it passes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let rollup: unknown[] = [run('lint', 'IN_PROGRESS', ''), run('test', 'QUEUED', '')]
  createPr(w, () => rollup)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  await clock.advance(60_000)
  expect(w.toasts).toEqual([])

  rollup = [run('lint', 'COMPLETED', 'FAILURE', 37636185372), run('test', 'COMPLETED', 'SUCCESS')]
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['CI failed on #219: lint'])
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✗')

  await clock.advance(60_000)
  expect(w.toasts).toHaveLength(1)

  rollup = [run('lint', 'COMPLETED', 'SUCCESS'), run('test', 'COMPLETED', 'SUCCESS')]
  await clock.advance(60_000)
  expect(w.toasts.at(-1)).toBe('CI passed on #219')
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')
})

test('a merge runs the cleanup once, in order, and suggests carrying on', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [run('lint', 'COMPLETED', 'SUCCESS')], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')

  state = 'MERGED'
  await clock.advance(60_000)
  expect(gitRan(w)).toEqual([
    'git remote get-url origin',
    'git fetch --prune origin',
    'git symbolic-ref --short refs/remotes/origin/HEAD',
    'git branch --show-current',
    'git status --porcelain --untracked-files=no',
    'git switch main',
    'git pull --ff-only origin main',
    'git rev-parse --verify --quiet refs/heads/codex/faster',
    'git worktree list --porcelain',
    'git branch -D codex/faster',
  ])
  expect(w.ran.filter(one => one.argv.startsWith('git ')).every(one => one.cwd === CWD)).toBe(true)
  expect(w.toasts).toEqual(['#219 merged → main pulled · branch codex/faster deleted'])
  expect(w.suggested).toEqual(['#219 is merged and cleaned up. Carry on with the next task.'])
  expect(w.statuses.at(-1)).toBeUndefined()

  // Merged PRs are not polled again, and the cleanup never runs twice.
  const before = w.ran.length
  await clock.advance(120_000)
  expect(w.ran.length).toBe(before)
  expect((await $.command.run(typed('prs', ''))).text).toBe(
    '#219 acme/widgets · merged, cleaned up · codex/faster · Faster widgets',
  )
})

test('the cleanup never switches or pulls with uncommitted changes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  w.answers.set('git status --porcelain --untracked-files=no', { out: ' M src/widget.ts\n' })
  w.answers.set('git worktree list --porcelain', {
    out: `worktree ${CWD}\nHEAD ${HEAD}\nbranch refs/heads/codex/faster\n\n`,
  })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  state = 'MERGED'
  await clock.advance(60_000)
  const git = gitRan(w)
  expect(git).toContain('git fetch --prune origin')
  expect(git.some(argv => /^git (switch|pull|checkout|branch -D|push)/.test(argv))).toBe(false)
  expect(w.toasts).toEqual([
    `#219 merged → uncommitted changes: stayed on codex/faster, did not switch or pull · branch codex/faster kept: checked out in ${CWD}`,
  ])
  expect(w.suggested).toEqual(['#219 is merged (uncommitted changes on codex/faster). Carry on with the next task.'])
})

test('the cleanup keeps a local branch whose tip is not the merged head', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  w.answers.set('git branch --show-current', { out: 'main\n' })
  w.answers.set('git rev-parse --verify --quiet refs/heads/codex/faster', { out: `${'c'.repeat(40)}\n` })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  state = 'MERGED'
  await clock.advance(60_000)
  const git = gitRan(w)
  expect(git).toContain('git pull --ff-only origin main')
  expect(git).not.toContain('git switch main')
  expect(git).not.toContain('git branch -D codex/faster')
  expect(w.toasts).toEqual([
    '#219 merged → main pulled · branch codex/faster kept: local ccccccc is not the merged head bbbbbbb',
  ])
})

test('the cleanup is skipped in a folder that is not a clone of the repository', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [], () => state)
  w.answers.set('git remote get-url origin', { out: 'https://github.com/someone/else.git\n' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  state = 'MERGED'
  await clock.advance(60_000)
  expect(gitRan(w)).toEqual(['git remote get-url origin'])
  expect(w.toasts).toEqual(['#219 merged → cleanup skipped: this folder is a clone of someone/else'])
})

test('a merge seen while a turn runs is cleaned up when the turn ends', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  await $.turn.start({ text: 'start #214', turnId: 't1' })
  state = 'MERGED'
  await clock.advance(60_000)
  expect(gitRan(w)).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(gitRan(w)).toContain('git branch -D codex/faster')
  expect(w.toasts).toEqual(['#219 merged → main pulled · branch codex/faster deleted'])
})

test('a PR closed without merging stops being watched', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [], () => state)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(w.statuses.at(-1)).toBe('PRs: #219')

  state = 'CLOSED'
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['#219 was closed without merging; no longer watched'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(gitRan(w)).toEqual([])
})

test("adopts the person's open PRs in the session's repository at start", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.answers.set('git rev-parse --is-inside-work-tree', { out: 'true\n' })
  w.answers.set('gh repo view --json nameWithOwner', { out: '{"nameWithOwner":"acme/widgets"}\n' })
  w.answers.set(
    'gh pr list --author @me --state open --json number,url,state,title,headRefName,headRefOid,statusCheckRollup --limit 20',
    {
      out: JSON.stringify([
        JSON.parse(view219('OPEN', [run('lint', 'COMPLETED', 'SUCCESS')])),
        {
          number: 221,
          url: 'https://github.com/acme/widgets/pull/221',
          state: 'OPEN',
          title: 'Lint fixes',
          headRefName: 'codex/lint',
          headRefOid: 'd'.repeat(40),
          statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE', 42)],
        },
      ]),
    },
  )

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.ran.map(one => one.cwd)).toEqual([CWD, CWD, CWD])
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓ · #221 ✗')
  // Adopted as they stand: no toast for CI that was already failing.
  expect(w.toasts).toEqual([])

  const forgot = await $.command.run(typed('prs', 'forget 221'))
  expect(forgot.text).toBe('Stopped watching 1 PR(s).')
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')
})

test('a folder that is not a git repository adopts nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.ran.map(one => one.argv)).toEqual(['git rev-parse --is-inside-work-tree'])
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('/prs watch adds a PR by number in this folder’s repository', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  w.answers.set(`gh pr view 219 --json ${FIELDS}`, { out: view219('OPEN', [run('lint', 'COMPLETED', 'FAILURE', 5)]) })
  w.answers.set(VIEW_219, { out: view219('OPEN', [run('lint', 'COMPLETED', 'FAILURE', 5)]) })

  const watched = await $.command.run(typed('prs', 'watch #219'))
  expect(watched.text).toBe('Watching #219 acme/widgets · open · CI failing: lint · codex/faster · Faster widgets')
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✗')
  expect((await $.command.run(typed('prs', 'watch nothing'))).text).toMatch(/^Usage: \/prs/)
})

test('a prompt saying #258 is failing gets its checks and the failed log tail', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  w.answers.set('gh pr checks 258', {
    code: 1,
    out: [
      'lint\tfail\t1m2s\thttps://github.com/acme/widgets/actions/runs/777/job/1\t',
      'test\tpass\t3m\thttps://github.com/acme/widgets/actions/runs/778/job/2\t',
      '',
    ].join('\n'),
  })
  // 130 lines of log: the default logLines (120) keeps lines 11 to 130.
  const log = Array.from({ length: 130 }, (_, i) => `lint\tRun eslint\t2026-10-07T14:25:01.0000000Z line ${i + 1}`)
  log.push('lint\tRun eslint\t2026-10-07T14:25:04.0000000Z ##[error]Process completed with exit code 1.', '')
  w.answers.set('gh run view 777 --log-failed', { out: log.join('\n') })

  const entered = await $.prompt.submit({ text: '#258 is failing', wait: false, origin: { kind: 'composer' } })
  expect(entered.text).toBe('#258 is failing')
  expect(entered.context).toHaveLength(1)
  const context = entered.context?.[0] ?? ''
  expect(context).toMatch(/^pr-autopilot: the prompt mentions failing CI on #258, so here is what gh reports\./)
  expect(context).toMatch(/Checks \(`gh pr checks 258`\):\nlint\tfail\t1m2s/)
  expect(context).toMatch(/Last 120 lines of the failed log \(`gh run view 777 --log-failed`\):\nlint\tRun eslint\tline 12\n/)
  expect(context).toMatch(/line 130\nlint\tRun eslint\t##\[error\]Process completed with exit code 1\.$/)
  expect(context).not.toMatch(/line 11\n/)
  expect(context).not.toMatch(/2026-10-07T/)
  expect(w.ran.map(one => one.argv)).toEqual(['gh pr checks 258', 'gh run view 777 --log-failed'])
})

test('a watched failing PR is found from "CI failed" alone, with its repository', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let rollup: unknown[] = [run('lint', 'IN_PROGRESS', '')]
  createPr(w, () => rollup)
  w.answers.set('gh pr checks 219 --repo acme/widgets', {
    code: 1,
    out: 'lint\tfail\t1m\thttps://github.com/acme/widgets/actions/runs/555/job/1\t\n',
  })
  w.answers.set('gh run view 555 --repo acme/widgets --log-failed', { out: 'lint\tRun eslint\tboom\n' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  rollup = [run('lint', 'COMPLETED', 'FAILURE', 555)]
  await clock.advance(60_000)

  const entered = await $.prompt.submit({ text: 'CI failed, fix it', wait: false, origin: { kind: 'composer' } })
  expect(entered.context?.[0]).toMatch(/`gh run view 555 --repo acme\/widgets --log-failed`\):\nlint\tRun eslint\tboom$/)
})

test('prompts that are not about failing CI get nothing', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  const entered = await $.prompt.submit({
    text: 'merged #219, clean up branches and start #214',
    wait: false,
    origin: { kind: 'composer' },
  })
  expect(entered.context).toBeUndefined()
  expect(w.ran).toEqual([])
})

test('with deleteRemoteBranch on, the merged branch on origin is deleted too', { options: { deleteRemoteBranch: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [run('lint', 'COMPLETED', 'SUCCESS')], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  w.answers.set('git ls-remote --heads origin codex/faster', { out: `${HEAD}\trefs/heads/codex/faster\n` })
  w.answers.set('git push origin --delete codex/faster', { err: ' - [deleted]         codex/faster\n' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  state = 'MERGED'
  await clock.advance(60_000)
  expect(gitRan(w).slice(-2)).toEqual(['git ls-remote --heads origin codex/faster', 'git push origin --delete codex/faster'])
  expect(w.toasts).toEqual(['#219 merged → main pulled · branch codex/faster deleted · origin/codex/faster deleted'])
})

test('with deleteRemoteBranch on, a branch that moved on origin since the merge is kept', { options: { deleteRemoteBranch: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let state = 'OPEN'
  createPr(w, () => [run('lint', 'COMPLETED', 'SUCCESS')], () => state)
  for (const [argv, answer] of Object.entries(CLEAN_ON_PR_BRANCH)) {
    w.answers.set(argv, answer)
  }
  w.answers.set('git ls-remote --heads origin codex/faster', { out: `${'c'.repeat(40)}\trefs/heads/codex/faster\n` })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  state = 'MERGED'
  await clock.advance(60_000)
  expect(gitRan(w)).not.toContain('git push origin --delete codex/faster')
  expect(w.toasts.at(-1)).toMatch(/origin\/codex\/faster kept: it moved since the merge$/)
})

test('with attachCiLogs off, a prompt about failing CI gets nothing', { options: { attachCiLogs: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  const entered = await $.prompt.submit({ text: '#258 is failing', wait: false, origin: { kind: 'composer' } })
  expect(entered.context).toBeUndefined()
  expect(w.ran).toEqual([])
})

test(
  'a token that cannot read checks holds them for authRetryMinutes, toasts once and shows CI as unknown',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    w.answers.set(VIEW_219, { code: 1, err: CHECKS_DENIED })
    w.answers.set(PLAIN_VIEW_219, () => ({ out: plain219('OPEN') }))

    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(argvs(w)).toEqual([VIEW_219, PLAIN_VIEW_219])
    expect(w.statuses.at(-1)).toBe('PRs: #219 CI?')
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/can't read PR checks/)
    expect(w.toasts[0]).toMatch(/"Checks: read"/)
    expect(w.toasts[0]).toMatch(/gh auth login --web/)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatch(/^pr-autopilot: gh can't read checks/)

    // The polls go on without the checks until the window ends; nothing toasts or logs again.
    await clock.advance(29 * 60_000)
    expect(count(w, VIEW_219)).toBe(1)
    expect(count(w, PLAIN_VIEW_219)).toBe(30)
    expect(w.toasts).toHaveLength(1)
    expect(w.logs).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe('PRs: #219 CI?')

    // At the window's end the checks are tried once more; refused again, they wait another window, quietly.
    await clock.advance(60_000)
    expect(count(w, VIEW_219)).toBe(2)
    expect(count(w, PLAIN_VIEW_219)).toBe(31)
    expect(w.toasts).toHaveLength(1)
    expect(w.logs).toHaveLength(2)

    // The tool says so too, without asking gh again: the data is fresh.
    const told = String((await $.tool.call({ tool: TOOL })).result)
    expect(told.split('\n')).toEqual([
      "#219 Faster widgets · open · codex/faster · CI unknown — gh token can't read checks · https://github.com/acme/widgets/pull/219",
      'Refreshed just now.',
      'gh can\'t read checks (its token lacks "Checks: read"): CI is unknown. Fix gh auth; /prs retries now, else in 30 min.',
    ])
    expect(count(w, VIEW_219)).toBe(2)
  },
)

test(
  'when gh cannot read PRs at all the status line says so and nothing is polled until the window ends',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    w.answers.set(VIEW_219, { code: 1, err: NOT_LOGGED_IN })
    w.answers.set(PLAIN_VIEW_219, { code: 1, err: NOT_LOGGED_IN })

    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(argvs(w)).toEqual([VIEW_219, PLAIN_VIEW_219])
    expect(w.statuses.at(-1)).toBe("PRs: gh can't read them")
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/^pr-autopilot: gh can't read PRs/)
    expect(w.toasts[0]).toMatch(/gh auth login --web/)

    await clock.advance(29 * 60_000)
    expect(w.ran).toHaveLength(2)
    await clock.advance(60_000)
    expect(argvs(w)).toEqual([VIEW_219, PLAIN_VIEW_219, VIEW_219, PLAIN_VIEW_219])
    expect(w.toasts).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe("PRs: gh can't read them")

    // Logged in again: the next window's retry reads the PR and the status line is back.
    w.answers.set(VIEW_219, { out: view219('OPEN', [run('lint', 'COMPLETED', 'SUCCESS')]) })
    await clock.advance(30 * 60_000)
    expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')
    expect(w.toasts.filter(text => text.startsWith('pr-autopilot:'))).toHaveLength(1)
  },
)

test('/prs retries at once, and a read that works again clears the hold', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.answers.set(VIEW_219, { code: 1, err: CHECKS_DENIED })
  w.answers.set(PLAIN_VIEW_219, () => ({ out: plain219('OPEN') }))
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(60_000)
  expect(count(w, VIEW_219)).toBe(1)

  // Still refused: /prs says why, and the window starts over.
  const held = await $.command.run(typed('prs', ''))
  expect(held.text).toBe(
    "#219 acme/widgets · open · CI unknown — gh token can't read checks · codex/faster · Faster widgets\n" +
      'gh can\'t read checks (its token lacks "Checks: read"): CI is unknown. Fix gh auth; /prs retries now, else in 30 min.',
  )
  expect(count(w, VIEW_219)).toBe(2)
  expect(count(w, PLAIN_VIEW_219)).toBe(3)

  // "Checks: read" granted: /prs reads the checks, polls go on with them, and nothing toasts for what was merely unknown.
  w.answers.set(VIEW_219, { out: view219('OPEN', [run('lint', 'COMPLETED', 'SUCCESS')]) })
  const fixed = await $.command.run(typed('prs', ''))
  expect(fixed.text).toBe('#219 acme/widgets · open · CI passed · codex/faster · Faster widgets')
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')
  await clock.advance(60_000)
  expect(count(w, VIEW_219)).toBe(4)
  expect(count(w, PLAIN_VIEW_219)).toBe(3)
  expect(w.toasts).toHaveLength(1)
})

test('a rate limit holds polling for five minutes', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  let answer: Answer = { out: view219('OPEN', [run('lint', 'IN_PROGRESS', '')]) }
  w.answers.set(VIEW_219, () => answer)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(w.statuses.at(-1)).toBe('PRs: #219 CI…')

  answer = { code: 1, err: 'HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)' }
  await clock.advance(60_000)
  expect(w.ran).toHaveLength(2)
  await clock.advance(4 * 60_000)
  expect(w.ran).toHaveLength(2)
  // The status line keeps what was last known; no toast, one debug line.
  expect(w.statuses.at(-1)).toBe('PRs: #219 CI…')
  expect(w.toasts).toEqual([])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/rate limit/)

  answer = { out: view219('OPEN', [run('lint', 'COMPLETED', 'SUCCESS')]) }
  await clock.advance(60_000)
  expect(w.ran).toHaveLength(3)
  expect(w.statuses.at(-1)).toBe('PRs: #219 ✓')
  await clock.advance(60_000)
  expect(w.ran).toHaveLength(4)
})

test(
  'other failures double the wait between polls up to ten minutes, and a success resets it',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    let answer: Answer = { out: view219('OPEN', [run('lint', 'IN_PROGRESS', '')]) }
    w.answers.set(VIEW_219, () => answer)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    answer = { code: 1, err: 'GraphQL: Something went wrong while executing your query. This may be the result of a timeout.' }

    // The seconds at which a poll ran: at 60s, then 120s later, 240s later, 480s later, then every 600s.
    const polledAt: number[] = []
    let seen = w.ran.length
    for (let tick = 1; tick <= 50; tick++) {
      await clock.advance(60_000)
      if (w.ran.length > seen) {
        polledAt.push(tick * 60)
        seen = w.ran.length
      }
    }
    expect(polledAt).toEqual([60, 180, 420, 900, 1500, 2100, 2700])
    expect(w.toasts).toEqual([])
    expect(w.logs).toHaveLength(7)

    answer = { out: view219('OPEN', [run('lint', 'IN_PROGRESS', '')]) }
    const resumedAt: number[] = []
    for (let tick = 51; tick <= 60; tick++) {
      await clock.advance(60_000)
      if (w.ran.length > seen) {
        resumedAt.push(tick * 60)
        seen = w.ran.length
      }
    }
    expect(resumedAt).toEqual([3300, 3360, 3420, 3480, 3540, 3600])
    expect(w.logs).toHaveLength(8)
  },
)

test(
  'the prs_status tool is registered for Claude and lists the watched PRs, refreshing stale data first',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(SESSION)
    await clock.settle()
    expect(w.tools.map(tool => tool.name)).toEqual(['prs_status'])
    expect(w.tools[0]?.isDeferred).toBe(false)
    expect(w.tools[0]?.description).toMatch(/gh pr view/)
    expect(w.tools[0]?.description).toMatch(/gh pr checks/)

    let answer: Answer = { out: view219('OPEN', [run('lint', 'IN_PROGRESS', '')]) }
    w.answers.set(VIEW_219, () => answer)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    const ghCalls = () => argvs(w).filter(argv => argv.startsWith('gh ')).length
    expect(ghCalls()).toBe(1)

    await clock.advance(30_000)
    const fresh = await $.tool.call({ tool: TOOL })
    expect(String(fresh.result)).toBe(
      '#219 Faster widgets · open · codex/faster · CI running · https://github.com/acme/widgets/pull/219\nRefreshed 30s ago.',
    )
    expect(ghCalls()).toBe(1)
    expect(String((await $.tool.call({ tool: TOOL, number: 300 })).result)).toBe(
      '#300 is not watched (watched: #219); /prs watch 300 adds it.\nRefreshed 30s ago.',
    )

    // Data older than pollSeconds is read again first (here a failure had held the polls back).
    answer = { code: 1, err: 'GraphQL: Something went wrong while executing your query.' }
    await clock.advance(30_000)
    expect(ghCalls()).toBe(2)
    answer = { out: view219('OPEN', [run('lint', 'COMPLETED', 'FAILURE', 5)]) }
    await clock.advance(60_000)
    expect(ghCalls()).toBe(2)
    const stale = await $.tool.call({ tool: TOOL, number: 219 })
    expect(ghCalls()).toBe(3)
    expect(String(stale.result)).toBe(
      '#219 Faster widgets · open · codex/faster · CI failing: lint · https://github.com/acme/widgets/pull/219\nRefreshed just now.',
    )
    expect(w.toasts).toEqual(['CI failed on #219: lint'])
  },
)

test(
  'adopting falls back to listing without the checks when the token cannot read them',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    w.answers.set('git rev-parse --is-inside-work-tree', { out: 'true\n' })
    w.answers.set('gh repo view --json nameWithOwner', { out: '{"nameWithOwner":"acme/widgets"}\n' })
    w.answers.set(LIST, { code: 1, err: CHECKS_DENIED })
    w.answers.set(PLAIN_LIST, {
      out: JSON.stringify([
        JSON.parse(plain219('OPEN')),
        {
          number: 221,
          url: 'https://github.com/acme/widgets/pull/221',
          state: 'OPEN',
          title: 'Lint fixes',
          headRefName: 'codex/lint',
          headRefOid: 'd'.repeat(40),
        },
      ]),
    })

    await $.session.start(SESSION)
    await clock.settle()
    expect(argvs(w).filter(argv => argv.startsWith('gh '))).toEqual(['gh repo view --json nameWithOwner', LIST, PLAIN_LIST])
    expect(w.statuses.at(-1)).toBe('PRs: #219 CI? · #221 CI?')
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/"Checks: read"/)

    // The polls that follow read without the checks too.
    await clock.advance(60_000)
    expect(count(w, PLAIN_VIEW_219)).toBe(1)
    expect(count(w, VIEW_219)).toBe(0)
  },
)
