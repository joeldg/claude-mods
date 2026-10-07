import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { projectKey } from '../hooks/servers'

const ROOT = '/Users/me/project'
const LOGS = `/Users/me/.claude/dev-servers/${projectKey(ROOT)}`

const PANE_PROPS = {
  title: 'Servers',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

/** A slash command as the person types it. */
const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const PACKAGE = JSON.stringify({
  name: 'web',
  scripts: {
    build: 'vite build',
    dev: 'vite --port 5173',
    'dev:api': 'PORT=4000 node server/index.js',
    preview: 'vite preview',
  },
})

/** One process on the fake Mac: what lsof and ps say about it, and how it takes signals. */
type Proc = {
  pid: number
  command: string
  ports: number[]
  cwd: string
  etime: string
  commandLine: string
  pgid?: number
  /** Ignores SIGTERM; only SIGKILL ends it. */
  isStubborn?: boolean
  /** How many port checks still find its first port held after it exits. */
  lingers?: number
}

type World = {
  procs: Proc[]
  files: Record<string, string>
  /** The project folder's entries. */
  names: string[]
  /** Every command run, argv joined. */
  ran: string[]
  /** The commands that change something, and each port check's answer, in order. */
  events: string[]
  /** What `sh -c` was handed, with its cwd. */
  started: { argv: readonly string[]; cwd: string | undefined }[]
  /** What a start brings up. */
  onStart: () => void
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
}

const out = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const VITE: Proc = {
  pid: 4242,
  command: 'node',
  ports: [5173, 24678],
  cwd: ROOT,
  etime: '02:10:00',
  commandLine: `node ${ROOT}/node_modules/.bin/vite --port 5173`,
}
const MOCK_API: Proc = {
  pid: 7001,
  command: 'node',
  ports: [9229],
  cwd: `${ROOT}/tools`,
  etime: '05:00',
  commandLine: 'node --inspect tools/mock.js',
}
const POSTGRES: Proc = {
  pid: 986,
  command: 'postgres',
  ports: [5432],
  cwd: '/opt/homebrew/var/postgresql',
  etime: '5-07:27:45',
  commandLine: '/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql',
}
const RAPPORTD: Proc = { pid: 646, command: 'rapportd', ports: [53480], cwd: '/', etime: '5-07:27:48', commandLine: '/usr/libexec/rapportd' }

/** Answers the host beneath the plugin: lsof, ps, kill, sh, the project's files, toasts, status and panes. */
const world = (on: On, procs: Proc[]): World => {
  const w: World = {
    procs: procs.map(proc => ({ ...proc })),
    files: { [`${ROOT}/package.json`]: PACKAGE },
    names: ['package.json', 'pnpm-lock.yaml', 'src'],
    ran: [],
    events: [],
    started: [],
    onStart: () => {},
    toasts: [],
    statuses: [],
    opened: [],
  }
  /** Ports still held by processes that exited, with how many checks they hold out for. */
  const lingering = new Map<number, number>()
  const alive = (pid: number) => w.procs.find(proc => proc.pid === pid)
  const exit = (proc: Proc) => {
    w.procs = w.procs.filter(one => one !== proc)
    const [port] = proc.ports
    if (port !== undefined && proc.lingers) {
      lingering.set(port, proc.lingers)
    }
  }
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({
    value: w.names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$, e) => {
    const text = w.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv
    const [tool, ...args] = argv
    w.ran.push(argv.join(' '))
    if (tool === 'git') {
      return out(`${ROOT}\n`)
    }
    if (tool === 'lsof' && args.includes('-Fpcn')) {
      return out(
        w.procs
          .filter(proc => proc.ports.length > 0)
          .map(proc => [`p${proc.pid}`, `c${proc.command}`, ...proc.ports.map((port, i) => `f${20 + i}\nn*:${port}`)].join('\n'))
          .join('\n'),
      )
    }
    if (tool === 'lsof' && args.includes('cwd')) {
      const pids = (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number)
      return out(
        pids
          .map(alive)
          .filter(proc => proc !== undefined)
          .map(proc => `p${proc.pid}\nfcwd\nn${proc.cwd}`)
          .join('\n'),
      )
    }
    const portArg = args.find(arg => arg.startsWith('-iTCP:'))
    if (tool === 'lsof' && portArg) {
      const port = Number(portArg.slice('-iTCP:'.length))
      const holder = w.procs.find(proc => proc.ports.includes(port))
      const left = lingering.get(port) ?? 0
      if (!holder && left > 0) {
        lingering.set(port, left - 1)
      }
      const isHeld = holder !== undefined || left > 0
      w.events.push(`port ${port} ${isHeld ? 'held' : 'free'}`)
      if (!isHeld) {
        return out('', 1)
      }
      const pid = holder?.pid ?? 4242
      return out(
        `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n${holder?.command ?? 'node'} ${pid} me 23u IPv6 0x1 0t0 TCP *:${port} (LISTEN)\n`,
      )
    }
    if (tool === 'ps' && args.includes('pgid=')) {
      const proc = alive(Number(args.at(-1)))
      return proc ? out(` ${proc.pgid ?? 1}\n`) : out('', 1)
    }
    if (tool === 'ps') {
      const pids = (args.at(-1) ?? '').split(',').map(Number)
      return out(
        pids
          .map(alive)
          .filter(proc => proc !== undefined)
          .map(proc => `${String(proc.pid).padStart(5)} ${proc.etime.padStart(11)} ${proc.commandLine}`)
          .join('\n'),
      )
    }
    if (tool === 'kill') {
      const [sig = '', ...rest] = args
      const target = rest.filter(arg => arg !== '--')[0] ?? ''
      if (sig === '-0') {
        return out('', alive(Number(target)) ? 0 : 1)
      }
      w.events.push(`${sig.slice(1)} ${target}`)
      const proc = alive(Math.abs(Number(target)))
      if (!proc) {
        return out('', 1)
      }
      if (sig === '-KILL' || (sig === '-TERM' && !proc.isStubborn)) {
        exit(proc)
      }
      return out('')
    }
    if (tool === 'sh') {
      w.events.push('start')
      w.started.push({ argv, cwd: e.init?.cwd })
      w.onStart()
      return out('')
    }
    if (tool === 'tail') {
      const text = w.files[args.at(-1) ?? '']
      return text === undefined ? { value: { ...out('', 1).value, stderr: 'tail: No such file or directory' } } : out(text)
    }
    return { deny: `${tool}: not faked` }
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
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return w
}

type Clock = { advance: (ms: number) => Promise<void> }

/** Moves the clock on in small steps, so work that sleeps in between keeps up. */
const elapse = async (clock: Clock, ms: number) => {
  for (let left = ms; left > 0; left -= 250) {
    await clock.advance(Math.min(250, left))
  }
}

type Ui = { press: (target: { key: string }) => Promise<unknown> }

/** Presses a Button and lets the clock run while the work it started waits. */
const pressFor = async (ui: Ui, clock: Clock, key: string, ms: number) => {
  const pressing = ui.press({ key })
  await elapse(clock, ms)
  await pressing
}

const mountPane = ($: any, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: 'dev-servers', surface, component: 'Pane', requestId: 'dev-servers', props: PANE_PROPS })

/** Every Text the pane draws, one string per element. */
const texts = async (ui: any): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map((found: { text: string }) => found.text)

test('the pane lists running and stopped servers on both surfaces', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, MOCK_API, POSTGRES, RAPPORTD])

  const ran = await $.command.run(typed('servers'))
  expect(w.opened).toEqual(['dev-servers'])
  expect(ran.text).toBe(
    [
      `Running in ${ROOT}:`,
      '  dev · :5173 :24678 · pid 4242 · up 2h',
      '  node · :9229 · pid 7001 · up 5m',
      'Not running: dev:api (pnpm run dev:api), preview (pnpm run preview)',
      '2 other listeners on this Mac.',
    ].join('\n'),
  )
  expect(w.statuses.at(-1)).toBe('servers: :5173 :9229 :24678')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const shown = await texts(ui)
    expect(shown).toContain(ROOT)
    expect(shown.some(text => text.includes('dev · :5173 :24678 · pid 4242 · up 2h'))).toBe(true)
    expect(shown.some(text => text.includes('node · :9229 · pid 7001 · up 5m'))).toBe(true)
    expect(shown.some(text => text.includes('dev:api · pnpm run dev:api · :4000'))).toBe(true)
    expect(shown.some(text => text.includes('preview · pnpm run preview'))).toBe(true)
    expect(shown).toContain('2 other listeners on this Mac')

    const buttons = (await ui.findAll({ type: 'Button' })).map((found: { key: string }) => found.key)
    expect(buttons).toEqual(['restart-4242', 'stop-4242', 'log-4242', 'stop-7001', 'start-dev-api', 'start-preview'])
    await ui.unmount()
  }
  // Drawing and polling never start or stop anything.
  expect(w.events.filter(event => !event.startsWith('port'))).toEqual([])
})

test('Start runs the command detached in the project root and reports the port', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  w.onStart = () => {
    w.procs.push({ pid: 6000, command: 'node', ports: [4000], cwd: ROOT, etime: '00:01', commandLine: 'node server/index.js' })
  }
  await $.command.run(typed('servers'))

  for (const surface of SURFACES) {
    w.procs = w.procs.filter(proc => proc.pid !== 6000)
    await $.command.run(typed('servers'))
    const ui = await mountPane($, surface)
    await pressFor(ui, clock, 'start-dev-api', 2000)
    expect(w.toasts.at(-1)).toBe('Started dev:api on :4000 (pid 6000)')
    const shown = await texts(ui)
    expect(shown.some(text => text.includes('dev:api · :4000 · pid 6000'))).toBe(true)
    expect(await ui.find({ key: 'start-dev-api' })).toBeUndefined()
    await ui.unmount()
  }

  expect(w.started[0]).toEqual({
    argv: [
      'sh',
      '-c',
      `mkdir -p ${LOGS} && cd ${ROOT} && nohup pnpm run dev:api > ${LOGS}/dev-api.log 2>&1 < /dev/null &`,
    ],
    cwd: ROOT,
  })
  // The port was checked free before the start.
  expect(w.events.slice(0, 2)).toEqual(['port 4000 free', 'start'])
})

test('Start without a known port finds the new server by its command line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [])
  w.onStart = () => {
    w.procs.push({
      pid: 6100,
      command: 'node',
      ports: [4173],
      cwd: ROOT,
      etime: '00:01',
      commandLine: `node ${ROOT}/node_modules/.bin/vite preview`,
    })
  }
  await $.command.run(typed('servers'))
  const ui = await mountPane($)
  await pressFor(ui, clock, 'start-preview', 3000)
  expect(w.toasts.at(-1)).toBe('Started preview on :4173 (pid 6100)')
  expect(w.statuses.at(-1)).toBe('servers: :4173')
  await ui.unmount()
})

test('Start refuses a port another process holds, and names it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...POSTGRES, pid: 8000, command: 'node', ports: [4000], cwd: '/Users/me/other', etime: '02:00:00' }])
  await $.command.run(typed('servers'))
  const ui = await mountPane($)
  await pressFor(ui, clock, 'start-dev-api', 1000)
  expect(w.toasts.at(-1)).toBe('dev:api was not started: Port 4000 is held by node (pid 8000, up 2h, in /Users/me/other)')
  expect(w.started).toEqual([])
  await ui.unmount()
})

test('Stop sends SIGTERM to the server and its process group, then reports', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, pgid: 4242 }, MOCK_API])
  await $.command.run(typed('servers'))

  const ui = await mountPane($)
  await pressFor(ui, clock, 'stop-4242', 1000)
  expect(w.events.filter(event => !event.startsWith('port'))).toEqual(['TERM 4242', 'TERM -4242'])
  expect(w.toasts).toEqual(['Stopped dev (pid 4242)'])
  expect(w.statuses.at(-1)).toBe('servers: :9229')
  expect(await ui.find({ key: 'stop-4242' })).toBeUndefined()
  // dev is now a known entry that is not running.
  expect(await ui.find({ key: 'start-dev' })).toBeDefined()
  await ui.unmount()
})

test('Stop never signals a pid that now runs something else', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  await $.command.run(typed('servers'))
  const ui = await mountPane($)

  // The pane drew pid 4242 as vite; since then the pid was reused.
  w.procs[0] = { ...w.procs[0]!, ports: [], commandLine: '/usr/bin/some-other-tool' }
  await pressFor(ui, clock, 'stop-4242', 1000)
  expect(w.events.filter(event => !event.startsWith('port'))).toEqual([])
  expect(w.toasts).toEqual(['pid 4242 no longer runs dev; nothing was signalled'])
  expect(await ui.find({ key: 'stop-4242' })).toBeUndefined()
  await ui.unmount()
})

test('a server that ignores SIGTERM is force stopped only on a second press within 10s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, isStubborn: true }])
  await $.command.run(typed('servers'))

  for (const surface of SURFACES) {
    w.events = []
    const ui = await mountPane($, surface)
    await pressFor(ui, clock, 'stop-4242', 6000)
    expect(w.events.filter(event => !event.startsWith('port'))).toEqual(['TERM 4242'])
    expect(w.toasts.at(-1)).toBe(
      'dev (pid 4242) is still running 5s after SIGTERM. Press Stop again within 10s to force stop it.',
    )
    expect((await ui.find({ key: 'stop-4242' }))?.props.label).toBe('Force stop?')

    // The window closes: the next press is a plain SIGTERM again.
    await elapse(clock, 11_000)
    expect((await ui.find({ key: 'stop-4242' }))?.props.label).toBe('Stop')
    await pressFor(ui, clock, 'stop-4242', 6000)
    expect(w.events.filter(event => !event.startsWith('port'))).toEqual(['TERM 4242', 'TERM 4242'])

    if (surface === 'desktop') {
      // Pressed again inside the window: SIGKILL.
      await pressFor(ui, clock, 'stop-4242', 3000)
      expect(w.events.filter(event => !event.startsWith('port'))).toEqual(['TERM 4242', 'TERM 4242', 'KILL 4242'])
      expect(w.toasts.at(-1)).toBe('Force stopped dev (pid 4242) with SIGKILL')
      expect(w.statuses.at(-1)).toBeUndefined()
    } else {
      await elapse(clock, 11_000)
    }
    await ui.unmount()
  }
})

test('Restart stops, waits for the port to be free, then starts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, lingers: 3 }])
  w.onStart = () => {
    w.procs.push({ ...VITE, pid: 6200, etime: '00:01', lingers: 0 })
  }
  await $.command.run(typed('servers'))
  const ui = await mountPane($)
  await pressFor(ui, clock, 'restart-4242', 5000)

  const order = w.events.filter(event => event === 'TERM 4242' || event === 'start' || event.startsWith('port 5173'))
  expect(order).toEqual([
    'TERM 4242',
    // The old server's port lingers for three checks after it exits.
    'port 5173 held',
    'port 5173 held',
    'port 5173 held',
    'port 5173 free',
    // The start's own check, then the start, then the new server listening.
    'port 5173 free',
    'start',
    'port 5173 held',
  ])
  expect(w.toasts).toEqual(['Restarted dev on :5173 (pid 6200)'])
  expect(w.started[0]?.argv[2]).toContain('nohup pnpm run dev > ')
  expect((await texts(ui)).some(text => text.includes('dev · :5173 :24678 · pid 6200'))).toBe(true)
  await ui.unmount()
})

test('Log toasts the last three lines of the log a pane start wrote', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  await $.command.run(typed('servers'))
  const ui = await mountPane($)

  await pressFor(ui, clock, 'log-4242', 500)
  expect(w.toasts.at(-1)).toBe(`No log for dev: only servers started from this pane write one (${LOGS}/dev.log)`)

  w.files[`${LOGS}/dev.log`] = '\n  VITE v5.2.0  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n12:00:01 [vite] page reload src/App.tsx\n'
  await pressFor(ui, clock, 'log-4242', 500)
  expect(w.toasts.at(-1)).toBe(
    'dev:   ➜  Local:   http://localhost:5173/ |   ➜  Network: use --host to expose | 12:00:01 [vite] page reload src/App.tsx',
  )
  await ui.unmount()
})

test('EADDRINUSE in Bash output adds a note naming the holder', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...POSTGRES, pid: 123, command: 'node', ports: [4000], cwd: '/Users/me/other', etime: '02:00:00' }])
  let answer: { isError?: true; result: unknown; text: string } = { result: {}, text: '' }
  on('tool.call', { tool: 'Bash' }, () => answer)

  answer = {
    isError: true,
    result: 'Error: listen EADDRINUSE: address already in use :::4000',
    text: 'Error: listen EADDRINUSE: address already in use :::4000\n    at Server.setupListenHandle [as _listen2] (node:net:1872:16)',
  }
  const failed = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(failed.context).toEqual(['dev-servers: Port 4000 is held by node (pid 123, up 2h, in /Users/me/other).'])
  expect(w.toasts).toEqual(['Port 4000 is held by node (pid 123, up 2h, in /Users/me/other)'])

  // No port in the message: the command's own --port names it.
  w.procs[0] = { ...w.procs[0]!, ports: [8001], cwd: `${ROOT}/docs` }
  answer = { result: { stdout: '', stderr: '' }, text: 'OSError: [Errno 48] Address already in use' }
  const python = await $.tool.call({ tool: 'Bash', command: 'python3 -m http.server --port 8001' })
  expect(python.context).toEqual([
    `dev-servers: Port 8001 is held by node (pid 123, up 2h, in ${ROOT}/docs). It is one of this project's servers; /servers can restart or stop it.`,
  ])

  answer = { result: { stdout: 'ok', stderr: '' }, text: 'ready on http://localhost:3000' }
  const fine = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(fine.context).toBeUndefined()
  expect(w.toasts).toHaveLength(2)
})

test('the status line follows the project servers as the poll sees them', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, POSTGRES])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.statuses).toEqual(['servers: :5173 :24678'])

  w.procs = w.procs.filter(proc => proc.pid !== VITE.pid)
  await elapse(clock, 15_000)
  expect(w.statuses).toEqual(['servers: :5173 :24678', undefined])

  w.procs.push({ ...MOCK_API, cwd: ROOT })
  await elapse(clock, 15_000)
  expect(w.statuses.at(-1)).toBe('servers: :9229')
  // Polling only reads: no signal sent, nothing started.
  expect(w.ran.some(command => command.startsWith('kill') || command.startsWith('sh'))).toBe(false)
})
