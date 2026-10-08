import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const NOW = Date.parse('2026-10-07T15:00:00Z')

const WORKER = 'ap-0123456789abcdefABCDEF'
const TRAINER = 'ap-fedcba9876543210FEDCBA'
const SWEEP = 'ap-00000000000000000000zz'

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

type Reply = string | { exitCode: number; stdout?: string; stderr?: string }

type World = {
  /** How the Modal CLI runs on this machine (`modal`, `python3 -m modal`); null: not installed. */
  cli: string | null
  apps: Row[]
  /** What `app list --json` answers instead of the apps (a failure). */
  list: Reply | null
  billing: Reply
  /** What `app stop …` answers, by the words after the CLI. */
  stop: (rest: string) => Reply
  ran: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
}

const answer = (reply: Reply) => {
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

/** Answers the host beneath the plugin: the Modal CLI (faked, never run), toasts, status and panes. */
const world = (on: On, cli: string | null = 'modal'): World => {
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
    ran: [],
    toasts: [],
    statuses: [],
    opened: [],
  }
  on('process.run', (_$, e) => {
    const line = e.argv.join(' ')
    w.ran.push(line)
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
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return w
}

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }

const ran = (w: World, line: string) => w.ran.filter(one => one === line).length

test('the status line counts running apps and containers, and clears when nothing is active', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start(START)
  await clock.settle()

  expect(w.ran.slice(0, 2)).toEqual(['modal --version', 'modal app list --json'])
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

test('a long run toasts once past alertMinutes, then again only after another interval', async ($, on) => {
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

test('alertMinutes and pollSeconds come from the options', { options: { alertMinutes: 5, pollSeconds: 120 } }, async ($, on) => {
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

test('the pane has a row per active app on both surfaces, idle deployed apps dimmed', async ($, on) => {
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

test('Stop asks to Confirm, and only Confirm runs app stop <id>, re-polls and toasts', async ($, on) => {
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

test('a CLI that wants --yes to stop without a terminal gets it after Confirm', async ($, on) => {
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

test('a stop that fails says why and leaves the app listed', async ($, on) => {
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

test('with no Modal CLI the meter stays silent, and /modal says why', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, null)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(10 * MIN)

  expect(w.ran.slice(0, 2)).toEqual(['modal --version', 'python3 -m modal --version'])
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

test('with no Modal profile or token the meter stays silent', async ($, on) => {
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

test('falls back from modal to python3 -m modal', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'python3 -m modal')
  await $.session.start(START)
  await clock.settle()

  expect(w.ran.slice(0, 3)).toEqual(['modal --version', 'python3 -m modal --version', 'python3 -m modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  await clock.advance(MIN)
  // The CLI is found once, not on every poll.
  expect(ran(w, 'modal --version')).toBe(1)
  expect(ran(w, 'python3 -m modal app list --json')).toBe(2)
  expect((await $.command.run(typed('modal', ''))).text?.split('\n')[0]).toBe(
    'Modal: 1 running (2 containers) · 1 deployed (read with `python3 -m modal`)',
  )
})

test('modalCommand is run as given', { options: { modalCommand: 'uv run modal' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'uv run modal')
  await $.session.start(START)
  await clock.settle()
  expect(w.ran.slice(0, 2)).toEqual(['uv run modal --version', 'uv run modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})

test("today's spend shows in /modal and the pane, and passing budgetToday toasts once", { options: { budgetToday: 2 } }, async ($, on) => {
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

test('a CLI that is not on PATH is skipped without spawning it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'python3 -m modal')
  mock.env(on, { PATH: '/usr/local/bin:/usr/bin' })
  on('fs.exists', (_$, e) => ({ value: e.path === '/usr/bin/python3' }))
  await $.session.start(START)
  await clock.settle()

  // No `modal --version` that could only fail: python3 is found on PATH and used straight away.
  expect(ran(w, 'modal --version')).toBe(0)
  expect(w.ran.slice(0, 2)).toEqual(['python3 -m modal --version', 'python3 -m modal app list --json'])
  expect(w.statuses.at(-1)).toBe('Modal: 1 running (2 containers) · 1 deployed')
})
