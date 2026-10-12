import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ModalCache, ModalShared } from '../types'

const MIN = 60_000
const NOW = Date.parse('2026-10-07T15:00:00Z')

const WORKER = 'ap-0123456789abcdefABCDEF'
const TRAINER = 'ap-fedcba9876543210FEDCBA'
const SWEEP = 'ap-00000000000000000000zz'

const HOME = '/home/dev'
const CWD = '/work'
/** The shared cache and lock every session on the machine reads. */
const CACHE = `${HOME}/.claude/modal-meter/cache.json`
const LOCK = `${HOME}/.claude/modal-meter/lock.json`
/** The one `rg` run that looks for `import modal` in the project's Python files. */
const RG = `rg -l -m1 --glob *.py --glob !.venv/** --glob !node_modules/** --glob !.git/** -e ^\\s*(import|from)\\s+modal\\b ${CWD}`

const PANE_PROPS = {
  title: 'Modal',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

/** One row of `modal app list --json` as Modal 1.2 prints it. */
type Row = {
  'App ID': string
  Description: string
  State: string
  Tasks: string
  'Created at': string
  'Stopped at': string | null
}

const APPS = (): Row[] => [
  {
    'App ID': WORKER,
    Description: 'image-worker',
    State: 'ephemeral (detached)',
    Tasks: '2',
    // Ten minutes before NOW.
    'Created at': '2026-10-07 07:50:00-07:00',
    'Stopped at': null,
  },
  {
    'App ID': TRAINER,
    Description: 'trainer',
    State: 'deployed',
    Tasks: '0',
    'Created at': '2026-09-20 10:00:00-07:00',
    'Stopped at': null,
  },
  {
    'App ID': SWEEP,
    Description: 'old-sweep',
    State: 'stopped',
    Tasks: '0',
    'Created at': '2026-10-06 09:00:00-07:00',
    'Stopped at': '2026-10-06 11:30:00-07:00',
  },
]

const NO_BILLING =
  "Usage: python -m modal [OPTIONS] COMMAND [ARGS]...\nTry 'python -m modal -h' for help.\n╭─ Error ─────────────────────╮\n│ No such command 'billing'.  │\n╰─────────────────────────────╯\n"

/** The same apps as another session's poll left them in the shared cache. */
const SHARED: ModalShared = {
  cli: ['modal'],
  problem: null,
  apps: [
    { id: WORKER, name: 'image-worker', state: 'detached', containers: 2, createdAt: NOW - 10 * MIN, stoppedAt: null },
    { id: TRAINER, name: 'trainer', state: 'deployed', containers: 0, createdAt: Date.parse('2026-09-20T17:00:00Z'), stoppedAt: null },
  ],
  spendToday: null,
  spendNote: 'this Modal CLI has no `billing report` command; Modal 1.3.3 and later have one',
  spendAskedAt: NOW - 60 * MIN,
  spendWaitMs: 5 * MIN,
  billingUnsupportedAt: NOW - 60 * MIN,
}

/** The shared cache file: written ten seconds ago by another session, unless said otherwise. */
const cacheFile = (over: Partial<Omit<ModalCache, 'data'>> = {}, data: Partial<ModalShared> = {}): string =>
  JSON.stringify({ ts: NOW - 10_000, by: 'sess-b', intervalMs: MIN, ...over, data: { ...SHARED, ...data } })

type Reply = string | { exitCode: number; stdout?: string; stderr?: string } | { deny: string }

type World = {
  /** How the Modal CLI runs on this machine (`modal`, `python3 -m modal`); null: not installed. */
  cli: string | null
  apps: Row[]
  /** What `app list --json` answers instead of the apps (a failure). */
  list: Reply | null
  billing: Reply
  /** What `app stop …` answers, by the words after the CLI. */
  stop: (rest: string) => Reply
  /** What `rg` finds in the project's Python files: an `import modal` (true), none (false), or no rg at all (null). */
  imports: boolean | null
  /** Files by absolute path: the project's dependency files, and the shared cache and lock under HOME. */
  files: Map<string, string>
  /** Holds `app list --json` for a while (a sleep on the test's clock): a slow Modal CLI. */
  slow: (() => Promise<void>) | null
  ran: string[]
  /** The Bash commands that reached the host beneath the plugin. */
  bash: string[]
  logs: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
}

type Setup = { env?: Record<string, string>; store?: Record<string, unknown> }

const answer = (reply: Reply) => {
  if (typeof reply === 'object' && 'deny' in reply) {
    return { deny: reply.deny }
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
}

/** Answers the host beneath the plugin: the Modal CLI and rg (faked, never run), files, the store, toasts, status and panes. */
const world = (on: On, cli: string | null = 'modal', setup: Setup = {}): World => {
  const w: World = {
    cli,
    apps: APPS(),
    list: null,
    billing: { exitCode: 2, stderr: NO_BILLING },
    stop: rest => {
      const id = rest.split(' ').pop() ?? ''
      w.apps = w.apps.map(row =>
        row['App ID'] === id ? { ...row, State: 'stopped', Tasks: '0', 'Stopped at': '2026-10-07 08:30:00-07:00' } : row,
      )
      return ''
    },
    imports: true,
    files: new Map(),
    slow: null,
    ran: [],
    bash: [],
    logs: [],
    toasts: [],
    statuses: [],
    opened: [],
  }
  mock.env(on, { HOME, ...setup.env })
  mock.store(on, setup.store)
  on('session.id', () => ({ value: 'sess-a' }))
  on('process.run', async (_$, e) => {
    const line = e.argv.join(' ')
    w.ran.push(line)
    if (e.argv[0] === 'rg') {
      if (w.imports === null) {
        return { deny: 'rg: command not found' }
      }
      return answer(w.imports ? `${CWD}/app.py\n` : { exitCode: 1 })
    }
    if (w.cli === null || !line.startsWith(`${w.cli} `)) {
      if (e.argv[0] === 'python3') {
        return answer({ exitCode: 1, stderr: '/usr/bin/python3: No module named modal\n' })
      }
      return { deny: `${e.argv[0]}: command not found` }
    }
    const rest = line.slice(w.cli.length + 1)
    if (rest === '--version') {
      return answer('modal client version: 1.2.6\n')
    }
    if (rest === 'app list --json') {
      if (w.slow) {
        await w.slow()
      }
      return answer(w.list ?? JSON.stringify(w.apps, null, 4))
    }
    if (rest === 'billing report --for today --json') {
      return answer(w.billing)
    }
    if (rest.startsWith('app stop ')) {
      return answer(w.stop(rest))
    }
    return answer({ exitCode: 2, stderr: `No such command '${rest}'` })
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...w.files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })),
  }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.bash.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
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
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return w
}

const START = { cwd: CWD, surface: 'terminal' as const, isInteractive: true }

const ran = (w: World, line: string) => w.ran.filter(one => one === line).length

/** The Modal CLI runs: everything but the project check's `rg`. */
const cliRuns = (w: World) => w.ran.filter(line => !line.startsWith('rg '))

/** The shared cache as the plugin last wrote it. */
const written = (w: World): ModalCache => JSON.parse(w.files.get(CACHE) ?? 'null') as ModalCache

test('the status line counts running apps and containers, and clears when nothing is active', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  expect(w.ran[0]).toBe(RG)
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')

  w.apps = w.apps.map(row => (row['App ID'] === WORKER ? { ...row, Tasks: '5' } : row))
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (5 containers) · 1 deployed')

  w.apps = w.apps.map(row => ({ ...row, State: 'stopped', Tasks: '0', 'Stopped at': '2026-10-07 08:05:00-07:00' }))
  await clock.advance(MIN)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts).toEqual([])
})

test('a long run toasts once past alertMinutes, then again only after another interval', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  // Up 10m at the start; exactly 30m after 20 polls is not yet longer than 30m.
  await clock.advance(20 * MIN)
  expect(w.toasts).toEqual([])

  await clock.advance(MIN)
  expect(w.toasts).toEqual(['Modal app image-worker has run 31m with 2 containers — /modal to stop it'])

  await clock.advance(29 * MIN)
  expect(w.toasts).toHaveLength(1)

  await clock.advance(MIN)
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toBe('Modal app image-worker has run 1h 1m with 2 containers — /modal to stop it')

  // The idle deployed trainer never alerted.
  expect(w.toasts.some(text => text.includes('trainer'))).toBe(false)
})

test('alertMinutes and pollSeconds come from the options', { options: { alertMinutes: 5, pollSeconds: 120 }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()
  // Already up 10m, past 5m: the first poll toasts.
  expect(w.toasts).toEqual(['Modal app image-worker has run 10m with 2 containers — /modal to stop it'])
  await clock.advance(2 * MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
  expect(w.toasts).toHaveLength(1)
  await clock.advance(4 * MIN)
  expect(w.toasts).toHaveLength(2)
})

test('the pane has a row per active app on both surfaces, idle deployed apps dimmed', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  const shown = await $.command.run(typed('modal', ''))
  expect(w.opened).toEqual(['modal-meter'])
  expect(shown.text?.split('\n')).toEqual([
    'Modal: 1 running (2 containers) · 1 deployed (read with `modal`)',
    '  image-worker · detached · 2 containers · up 10m',
    '  trainer · deployed · 0 containers · up 16d 22h (idle)',
    'Spend: not shown (this Modal CLI has no `billing report` command; Modal 1.3.3 and later have one)',
  ])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'modal-meter', surface, component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
    const worker = await ui.find({ type: 'Text', text: 'image-worker · detached · 2 containers · up 10m' })
    expect(worker?.props.dimColor).toBe(false)
    const trainer = await ui.find({ type: 'Text', text: /^trainer · deployed · 0 containers/ })
    expect(trainer?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: /old-sweep/ })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([`stop-${WORKER}`, `stop-${TRAINER}`])
    await ui.unmount()
  }
  // Spend never showed, and billing was asked once only (it does not exist in this CLI).
  expect(ran(w, 'modal billing report --for today --json')).toBe(1)
})

test('Stop asks to Confirm, and only Confirm runs app stop <id>, re-polls and toasts', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'modal-meter', surface, component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
    await ui.press({ key: `stop-${WORKER}` })
    expect(await ui.find({ type: 'Text', text: 'Stop image-worker?' })).toBeDefined()
    expect(await ui.find({ key: `confirm-${WORKER}` })).toBeDefined()
    await ui.press({ key: `cancel-${WORKER}` })
    expect(await ui.find({ key: `stop-${WORKER}` })).toBeDefined()
    expect(w.ran.some(line => line.includes('app stop'))).toBe(false)
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'modal-meter',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'modal-meter',
    props: PANE_PROPS,
  })
  await ui.press({ key: `stop-${WORKER}` })
  const lists = ran(w, 'modal app list --json')
  await ui.press({ key: `confirm-${WORKER}` })

  expect(w.ran.filter(line => line.includes('app stop'))).toEqual([`modal app stop ${WORKER}`])
  expect(ran(w, 'modal app list --json')).toBe(lists + 1)
  expect(w.toasts.at(-1)).toBe('Stopped Modal app image-worker')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /image-worker/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([`stop-${TRAINER}`])
  await ui.unmount()
})

test('a CLI that wants --yes to stop without a terminal gets it after Confirm', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const stopIt = w.stop
  w.stop = rest =>
    rest.includes('--yes')
      ? stopIt(rest)
      : {
          exitCode: 1,
          stdout: "Are you sure you want to stop App 'ap-…'? This will immediately terminate 2 running containers. [y/N]:\n",
          stderr: 'Aborted: no interactive terminal detected. Rerun with --yes (-y) to skip confirmation.\n',
        }
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  await ui.press({ key: `stop-${WORKER}` })
  await ui.press({ key: `confirm-${WORKER}` })
  await ui.unmount()

  expect(w.ran.filter(line => line.includes('app stop'))).toEqual([
    `modal app stop ${WORKER}`,
    `modal app stop --yes ${WORKER}`,
  ])
  expect(w.toasts.at(-1)).toBe('Stopped Modal app image-worker')
})

test('a stop that fails says why and leaves the app listed', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.stop = () => ({ exitCode: 1, stderr: '╭─ Error ─╮\n│ Permission denied for app. │\n╰─────────╯\n' })
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  await ui.press({ key: `stop-${WORKER}` })
  await ui.press({ key: `confirm-${WORKER}` })
  expect(w.toasts.at(-1)).toBe('Could not stop Modal app image-worker: Permission denied for app.')
  expect(await ui.find({ key: `stop-${WORKER}` })).toBeDefined()
  await ui.unmount()
})

test('with no Modal CLI the meter stays silent, and /modal says why', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, null)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(10 * MIN)

  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'python3 -m modal --version'])
  expect(w.ran.some(line => line.includes('app list'))).toBe(false)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toEqual([])

  const shown = await $.command.run(typed('modal', ''))
  expect(shown.text).toBe(
    'modal-meter is silent: no Modal CLI found (tried `modal` and `python3 -m modal`); set the modalCommand option to the command you run Modal with.',
  )
  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^modal-meter is silent: no Modal CLI found/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

test('with no Modal profile or token the meter stays silent', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.list = {
    exitCode: 1,
    stderr:
      'Token missing. Could not authenticate client. If you have token credentials, see modal.com/docs/reference/modal.config for setup help.\n',
  }
  w.apps = w.apps.map(row => ({ ...row, Tasks: '9', 'Created at': '2026-10-06 00:00:00-07:00' }))
  await $.session.start(START)
  await clock.settle()
  await clock.advance(5 * MIN)

  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toEqual([])
  expect((await $.command.run(typed('modal', ''))).text).toBe(
    'modal-meter is silent: Modal has no profile or token set up on this machine (run `modal setup`).',
  )
})

test('falls back from modal to python3 -m modal', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'python3 -m modal')
  await $.session.start(START)
  await clock.settle()

  expect(cliRuns(w).slice(0, 3)).toEqual(['modal --version', 'python3 -m modal --version', 'python3 -m modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  await clock.advance(MIN)
  // The CLI is found once, not on every poll.
  expect(ran(w, 'modal --version')).toBe(1)
  expect(ran(w, 'python3 -m modal app list --json')).toBe(2)
  expect((await $.command.run(typed('modal', ''))).text?.split('\n')[0]).toBe(
    'Modal: 1 running (2 containers) · 1 deployed (read with `python3 -m modal`)',
  )
})

test('modalCommand is run as given', { options: { modalCommand: 'uv run modal' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'uv run modal')
  await $.session.start(START)
  await clock.settle()
  expect(cliRuns(w).slice(0, 2)).toEqual(['uv run modal --version', 'uv run modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test("today's spend shows in /modal and the pane, and passing budgetToday toasts once", { options: { budgetToday: 2 }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const report = (costs: string[]) =>
    JSON.stringify(
      costs.map((cost, i) => ({
        object_id: i === 0 ? WORKER : TRAINER,
        description: i === 0 ? 'image-worker' : 'trainer',
        environment: 'main',
        interval_start: '2026-10-07',
        cost,
      })),
    )
  w.billing = report(['1.10', '0.15'])
  await $.session.start(START)
  await clock.settle()

  const shown = await $.command.run(typed('modal', ''))
  expect(shown.text?.split('\n').at(-1)).toBe('Spend today (UTC): $1.25 of a $2.00 daily budget')
  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Spend today (UTC): $1.25 of $2.00' })).toBeDefined()
  await ui.unmount()
  expect(w.toasts).toEqual([])

  w.billing = report(['2.20', '0.20'])
  await clock.advance(MIN)
  // Spend is asked every 5 minutes, not every poll.
  expect(w.toasts).toEqual([])
  await clock.advance(4 * MIN)
  expect(w.toasts).toEqual(['Modal spend today is $2.40, past your $2.00 daily budget — /modal to see what is running'])

  await clock.advance(10 * MIN)
  await $.command.run(typed('modal', ''))
  expect(w.toasts).toHaveLength(1)
})

test('a CLI that is not on PATH is skipped without spawning it', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'python3 -m modal', { env: { PATH: '/usr/local/bin:/usr/bin' } })
  on('fs.exists', (_$, e) => ({ value: e.path === '/usr/bin/python3' }))
  await $.session.start(START)
  await clock.settle()

  // No `modal --version` that could only fail: python3 is found on PATH and used straight away.
  expect(ran(w, 'modal --version')).toBe(0)
  expect(cliRuns(w).slice(0, 2)).toEqual(['python3 -m modal --version', 'python3 -m modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test('a project without Modal is not watched: the CLI never runs, the pane says so, the answer is kept', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = false
  await $.session.start(START)
  await clock.settle()
  await clock.advance(10 * MIN)

  // One look at the project's Python files, then nothing: no Modal CLI, no status line.
  expect(w.ran).toEqual([RG])
  expect(w.statuses).toEqual([])
  expect(w.toasts).toEqual([])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'modal-meter', surface, component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^Not watching Modal: this project does not use it\. \/modal starts watching/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }

  // The next start of this project (a reload, a new session) remembers the answer instead of looking again.
  await $.session.start(START)
  await clock.settle()
  expect(w.ran).toEqual([RG])
})

test('a remembered project answer is used for a day', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'modal', { store: { [`project:${CWD}`]: { usesModal: true, checkedAt: NOW - 23 * 60 * MIN } } })
  w.imports = false
  await $.session.start(START)
  await clock.settle()
  // Remembered as a Modal project: polling, and no rg.
  expect(w.ran.some(line => line.startsWith('rg '))).toBe(false)
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test('a project answer older than a day is checked again', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'modal', { store: { [`project:${CWD}`]: { usesModal: true, checkedAt: NOW - 25 * 60 * MIN } } })
  w.imports = false
  await $.session.start(START)
  await clock.settle()
  await clock.advance(5 * MIN)
  expect(w.ran).toEqual([RG])
  expect(w.statuses).toEqual([])
})

test('a project that names modal in its dependency files is watched', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = false
  w.files.set(`${CWD}/pyproject.toml`, '[project]\nname = "example-app"\ndependencies = ["numpy", "modal>=1.0"]\n')
  await $.session.start(START)
  await clock.settle()
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test('without rg the dependency files alone decide', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = null
  w.files.set(`${CWD}/requirements.txt`, 'numpy\nmodal==1.2.6\n')
  await $.session.start(START)
  await clock.settle()
  expect(w.ran[0]).toBe(RG)
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test('/modal starts watching a project that does not use Modal', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = false
  await $.session.start(START)
  await clock.settle()
  expect(cliRuns(w)).toEqual([])

  const shown = await $.command.run(typed('modal', ''))
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(shown.text?.split('\n')[0]).toBe('Modal: 1 running (2 containers) · 1 deployed (read with `modal`)')
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  // And keeps watching.
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
})

test('a Bash command that runs modal starts watching; one that only mentions it does not', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = false
  await $.session.start(START)
  await clock.settle()

  await $.tool.call({ tool: 'Bash', command: 'rg -n modal README.md' })
  await clock.settle()
  expect(cliRuns(w)).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'cd /work && python3 -m modal deploy app.py' })
  await clock.settle()
  expect(cliRuns(w).slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  // Both commands ran as typed.
  expect(w.bash).toEqual(['rg -n modal README.md', 'cd /work && python3 -m modal deploy app.py'])
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
})

test('alwaysPoll watches every project without looking at it', { options: { alwaysPoll: true }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.imports = false
  await $.session.start(START)
  await clock.settle()
  expect(w.ran.slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test("a fresh shared cache is shown without running the CLI, and the writer's CLI is adopted", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.files.set(CACHE, cacheFile())
  await $.session.start(START)
  await clock.settle()

  expect(cliRuns(w)).toEqual([])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  const shown = await $.command.run(typed('modal', ''))
  expect(cliRuns(w)).toEqual([])
  expect(shown.text?.split('\n')).toEqual([
    'Modal: 1 running (2 containers) · 1 deployed (read with `modal`)',
    '  image-worker · detached · 2 containers · up 10m',
    '  trainer · deployed · 0 containers · up 16d 22h (idle)',
    'Spend: not shown (this Modal CLI has no `billing report` command; Modal 1.3.3 and later have one)',
  ])
  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([`stop-${WORKER}`, `stop-${TRAINER}`])
  await ui.unmount()

  // A minute on the cache is stale and nobody holds the lock: this session polls, with the CLI the
  // cache named (no `--version`), and skips `billing report`, which the cache says this CLI lacks.
  await clock.advance(MIN)
  expect(cliRuns(w)).toEqual(['modal app list --json'])
  expect(written(w)).toMatchObject({ ts: NOW + MIN, by: 'sess-a', intervalMs: MIN })
  expect(JSON.parse(w.files.get(LOCK) ?? 'null')).toEqual({ ts: NOW + MIN, by: 'sess-a' })
})

test('while another session holds the lock the CLI is not run and the stale cache is shown', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.files.set(CACHE, cacheFile({ ts: NOW - 2 * MIN }))
  w.files.set(LOCK, JSON.stringify({ ts: NOW - 10_000, by: 'sess-b' }))
  await $.session.start(START)
  await clock.settle()

  expect(cliRuns(w)).toEqual([])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')

  // The holder's lock is good for its interval plus one probe timeout.
  await clock.advance(MIN)
  expect(cliRuns(w)).toEqual([])
  const ui = await $.ui.mount({ plugin: 'modal-meter', surface: 'terminal', component: 'Pane', requestId: 'modal-meter', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'image-worker · detached · 2 containers · up 11m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Last read 3m ago.' })).toBeDefined()
  await ui.unmount()

  // Then it is stale, and this session takes over.
  await clock.advance(MIN)
  expect(cliRuns(w)).toEqual(['modal app list --json'])
  expect(JSON.parse(w.files.get(LOCK) ?? 'null')).toEqual({ ts: NOW + 2 * MIN, by: 'sess-a' })
})

test('a CLI without billing report is remembered for every session for a day', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  // This session learned it and wrote it for the others.
  expect(ran(w, 'modal billing report --for today --json')).toBe(1)
  expect(written(w).data).toMatchObject({ billingUnsupportedAt: NOW, spendToday: null })
  expect(written(w).data.spendNote).toMatch(/^this Modal CLI has no `billing report` command/)

  // Another session's knowledge, 23 hours old, spares this one the try; a day old, it tries once more.
  w.files.set(CACHE, cacheFile({ ts: NOW - 2 * MIN }, { billingUnsupportedAt: NOW - 23 * 60 * MIN }))
  await clock.advance(MIN)
  expect(ran(w, 'modal billing report --for today --json')).toBe(1)
  w.files.set(CACHE, cacheFile({ ts: NOW - 2 * MIN }, { billingUnsupportedAt: NOW - 25 * 60 * MIN }))
  await clock.advance(MIN)
  expect(ran(w, 'modal billing report --for today --json')).toBe(2)
})

test('a slow app list doubles the interval, a fast one brings it back', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.slow = () => clock.sleep(3000)
  await $.session.start(START)
  await clock.settle()
  expect(ran(w, 'modal app list --json')).toBe(1)
  expect(w.statuses).toEqual([])

  await clock.advance(3000)
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  expect(w.logs.filter(line => line.includes('polling'))).toEqual(['modal-meter: polling every 2m (app list took 3s)'])
  expect(written(w).intervalMs).toBe(2 * MIN)

  // The minute tick is gone; the next poll comes two minutes after the slow one.
  w.slow = null
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(1)
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
  expect(w.logs.filter(line => line.includes('polling')).at(-1)).toBe('modal-meter: polling every 1m (app list took 0s)')

  // Fast again: back to the option.
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(3)
  expect(w.logs.filter(line => line.includes('polling'))).toHaveLength(2)
})

test('a timed-out app list doubles the interval too, and says so once', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.list = { deny: 'aborted: still running after 60000ms' }
  await $.session.start(START)
  await clock.settle()
  expect(ran(w, 'modal app list --json')).toBe(1)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.logs.filter(line => line.includes('polling'))).toEqual(['modal-meter: polling every 2m (app list timed out)'])

  w.list = null
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(1)
  await clock.advance(MIN)
  expect(ran(w, 'modal app list --json')).toBe(2)
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test('session.start returns before the first poll resolves', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.slow = () => clock.sleep(5000)
  await $.session.start(START)
  await clock.settle()

  // The poll is under way (the CLI was started) but nothing waited for it: a start that did would
  // have hung on the sleeping CLI and been let go, leaving a silent meter instead of no status at all.
  expect(ran(w, 'modal app list --json')).toBe(1)
  expect(w.statuses).toEqual([])
  await clock.advance(5000)
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})
