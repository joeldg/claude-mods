import { expect, mock, test } from 'claude-code/testing'
import type { On, RegisteredToolSpec } from 'claude-code'

import { projectKey } from '../hooks/servers'

const ROOT = '/Users/me/project'
const LOGS = `/Users/me/.claude/dev-servers/${projectKey(ROOT)}`
/** Where every session's scan meets. */
const SHARED = '/Users/me/.claude/dev-servers'
const CACHE = `${SHARED}/scan-cache.json`
const LOCK = `${SHARED}/scan-lock.json`
const TOOL = 'mcp__dev-servers__dev_servers'
/** These tests move a mocked clock through many dispatches; the machine running them is often loaded. */
const SLOW = { timeoutMs: 30_000 }

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

/** One process on the fake machine: what netstat, ps and lsof say about it, and how it takes signals. */
type Proc = {
  pid: number
  /** Its name as netstat's process column has it. */
  command: string
  ports: number[]
  cwd: string
  etime: string
  commandLine: string
  pgid?: number
  /** Ignores SIGTERM; only SIGKILL ends it. */
  isStubborn?: boolean
  /** How many scans still find its first port held after it exits. */
  lingers?: number
}

type World = {
  procs: Proc[]
  files: Record<string, string>
  /** Each file's modification time, for `fs.stat`. */
  mtimes: Record<string, number>
  /** The project folder's entries. */
  names: string[]
  /** Every command run, argv joined. */
  ran: string[]
  /** The commands that change something, and each listen scan with the ports it found held, in order. */
  events: string[]
  /** Each one-pid lookup, `ps <pid>` or `cwd <pid>`, in order. */
  lookups: string[]
  /** What `sh -c` was handed, with its cwd. */
  started: { argv: readonly string[]; cwd: string | undefined }[]
  /** What a start brings up. */
  onStart: () => void
  /** Runs before netstat answers: how a scan is made slow. */
  beforeScan: (() => Promise<void>) | null
  /** Whether netstat answers its table, is missing, or hangs until the timeout; whether ss answers or is missing. */
  netstat: 'table' | 'missing' | 'timeout'
  ss: 'table' | 'missing'
  sessionId: string
  /** Tools the settings deny, for `tool.check`. */
  denied: string[]
  tools: RegisteredToolSpec[]
  logs: string[]
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

const NETSTAT_HEAD = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs',
]
const netstatRow = (port: number, command: string, pid: number) =>
  `tcp4       0      0  127.0.0.1.${port}        *.*                    LISTEN                 0            0  131072  131072   ${command}:${pid}   00100 00000006 00000000012be366 00000001 00000800      1      0 000000`
const ESTABLISHED =
  'tcp4       0      0  10.0.0.5.55135         93.184.216.34.443      ESTABLISHED         2664        25531  131072  131072           node:4242  00102 00000000 00000000012e05f2 00000081 04000900      2      0 000000'
const SS_HEAD = 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process'
const ssRow = (port: number, command: string, pid: number) =>
  `LISTEN 0      511    127.0.0.1:${port}      0.0.0.0:*         users:(("${command}",pid=${pid},fd=18))`

type Row = (port: number, command: string, pid: number) => string
type Lingering = Map<number, { left: number; pid: number }>

/** The fake machine's processes, as the host commands see them. */
type Host = {
  alive: (pid: number) => Proc | undefined
  exit: (proc: Proc) => void
  /** The listening sockets now, one `row` each; a lingering port counts one scan down. */
  scan: (row: Row) => string[]
}

/** The listening sockets now, one `row` each, noted as a scan event with the ports held. */
const scanRows = (w: World, lingering: Lingering, row: Row): string[] => {
  const rows: string[] = []
  const held = new Set<number>()
  for (const proc of w.procs) {
    for (const port of proc.ports) {
      rows.push(row(port, proc.command, proc.pid))
      held.add(port)
    }
  }
  for (const [port, linger] of lingering) {
    if (linger.left > 0) {
      rows.push(row(port, 'node', linger.pid))
      held.add(port)
      linger.left -= 1
    }
  }
  w.events.push(`scan ${[...held].sort((a, b) => a - b).map(port => `:${port}`).join(' ') || '-'}`)
  return rows
}

/** Answers `$.process.run`: netstat, ss and lsof for the listen scan, ps and lsof for one pid, kill, sh and tail. */
const answerProcess = async (w: World, host: Host, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
  const argv = e.argv
  const [tool, ...args] = argv
  w.ran.push(argv.join(' '))
  if (tool === 'git') {
    return out(`${ROOT}\n`)
  }
  if (tool === 'netstat') {
    if (w.beforeScan) {
      await w.beforeScan()
    }
    if (w.netstat === 'missing') {
      return { deny: 'netstat: command not found' }
    }
    if (w.netstat === 'timeout') {
      return { deny: '$.process.run(netstat) aborted: still running after 10000ms' }
    }
    return out([...NETSTAT_HEAD, ...host.scan(netstatRow), ESTABLISHED, ''].join('\n'))
  }
  if (tool === 'ss') {
    return w.ss === 'missing' ? { deny: 'ss: command not found' } : out([SS_HEAD, ...host.scan(ssRow), ''].join('\n'))
  }
  if (tool === 'lsof' && args.includes('-Fpcn')) {
    // The last-resort listen scan, in lsof's field form.
    const rows = host.scan((port, command, pid) => `p${pid}\nc${command}\nf20\nn*:${port}`)
    return out(rows.join('\n'), rows.length === 0 ? 1 : 0)
  }
  if (tool === 'lsof') {
    const at = args.indexOf('-p')
    const target = at < 0 ? '' : (args[at + 1] ?? '')
    if (at < 0 || !args.includes('cwd')) {
      return { deny: 'lsof: only `lsof -a -p <pid> -d cwd -Fn` is faked; the listen scan is netstat' }
    }
    if (target.includes(',')) {
      return { deny: 'lsof: one pid at a time' }
    }
    w.lookups.push(`cwd ${target}`)
    const proc = host.alive(Number(target))
    return proc ? out(`p${proc.pid}\nfcwd\nn${proc.cwd}\n`) : out('', 1)
  }
  if (tool === 'ps' && args.includes('pgid=')) {
    const proc = host.alive(Number(args.at(-1)))
    return proc ? out(` ${proc.pgid ?? 1}\n`) : out('', 1)
  }
  if (tool === 'ps') {
    const target = args.at(-1) ?? ''
    if (target.includes(',')) {
      return { deny: 'ps: one pid at a time' }
    }
    w.lookups.push(`ps ${target}`)
    const proc = host.alive(Number(target))
    return out(proc ? `${String(proc.pid).padStart(5)} ${proc.etime.padStart(11)} ${proc.commandLine}\n` : '')
  }
  if (tool === 'kill') {
    const [sig = '', ...rest] = args
    const target = rest.filter(arg => arg !== '--')[0] ?? ''
    if (sig === '-0') {
      return out('', host.alive(Number(target)) ? 0 : 1)
    }
    w.events.push(`${sig.slice(1)} ${target}`)
    const proc = host.alive(Math.abs(Number(target)))
    if (!proc) {
      return out('', 1)
    }
    if (sig === '-KILL' || (sig === '-TERM' && !proc.isStubborn)) {
      host.exit(proc)
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
}

/** Answers the host beneath the plugin: the commands, the project's and the shared files, toasts, status and panes. */
const world = (on: On, procs: Proc[]): World => {
  const w: World = {
    procs: procs.map(proc => ({ ...proc })),
    files: { [`${ROOT}/package.json`]: PACKAGE },
    mtimes: {},
    names: ['package.json', 'pnpm-lock.yaml', 'src'],
    ran: [],
    events: [],
    lookups: [],
    started: [],
    onStart: () => {},
    beforeScan: null,
    netstat: 'table',
    ss: 'missing',
    sessionId: 'session-a',
    denied: [],
    tools: [],
    logs: [],
    toasts: [],
    statuses: [],
    opened: [],
  }
  /** Ports still held after their process exited, with how many scans they hold out for. */
  const lingering: Lingering = new Map()
  const host: Host = {
    alive: pid => w.procs.find(proc => proc.pid === pid),
    exit: proc => {
      w.procs = w.procs.filter(one => one !== proc)
      const [port] = proc.ports
      if (port !== undefined && proc.lingers) {
        lingering.set(port, { left: proc.lingers, pid: proc.pid })
      }
    },
    scan: row => scanRows(w, lingering, row),
  }
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__dev-servers__${e.name}` } }
  })
  on('tool.check', (_$, e) =>
    w.denied.includes(e.tool) ? { decision: 'deny' as const, reason: 'denied in settings' } : { decision: 'ask' as const },
  )
  on('fs.list', () => ({
    value: w.names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$, e) => {
    const text = w.files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    const text = w.files[e.path]
    return text === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: w.mtimes[e.path] ?? 0, isLink: false } }
  })
  on('process.run', (_$, e) => answerProcess(w, host, e))
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

const start = ($: any) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

/** The listen scans run so far. */
const scans = (w: World) => w.ran.filter(command => command.startsWith('netstat'))

test('the pane lists running and stopped servers on both surfaces', SLOW, async ($, on) => {
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
      '2 other listeners on this machine.',
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
    expect(shown).toContain('2 other listeners on this machine')

    const buttons = (await ui.findAll({ type: 'Button' })).map((found: { key: string }) => found.key)
    expect(buttons).toEqual(['restart-4242', 'stop-4242', 'log-4242', 'stop-7001', 'start-dev-api', 'start-preview'])
    await ui.unmount()
  }
  // Drawing and polling never start or stop anything.
  expect(w.events.filter(event => !event.startsWith('scan'))).toEqual([])
})

test('Start runs the command detached in the project root and reports the port', SLOW, async ($, on) => {
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
  // The port was checked free, in a scan, right before the start; the next scan finds the server on it.
  const started = w.events.indexOf('start')
  expect(w.events[started - 1]).toMatch(/^scan /)
  expect(w.events[started - 1]).not.toContain(':4000')
  expect(w.events.slice(started + 1).some(event => event.includes(':4000'))).toBe(true)
})

test('Start without a known port finds the new server by its command line', SLOW, async ($, on) => {
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

test('Start refuses a port another process holds, and names it', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...POSTGRES, pid: 8000, command: 'node', ports: [4000], cwd: '/Users/me/other', etime: '02:00:00' }])
  await $.command.run(typed('servers'))
  const ui = await mountPane($)
  await pressFor(ui, clock, 'start-dev-api', 1000)
  expect(w.toasts.at(-1)).toBe('dev:api was not started: Port 4000 is held by node (pid 8000, up 2h, in /Users/me/other)')
  expect(w.started).toEqual([])
  await ui.unmount()
})

test('Stop sends SIGTERM to the server and its process group, then reports', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, pgid: 4242 }, MOCK_API])
  await $.command.run(typed('servers'))

  const ui = await mountPane($)
  await pressFor(ui, clock, 'stop-4242', 1000)
  expect(w.events.filter(event => !event.startsWith('scan'))).toEqual(['TERM 4242', 'TERM -4242'])
  expect(w.toasts).toEqual(['Stopped dev (pid 4242)'])
  expect(w.statuses.at(-1)).toBe('servers: :9229')
  expect(await ui.find({ key: 'stop-4242' })).toBeUndefined()
  // dev is now a known entry that is not running.
  expect(await ui.find({ key: 'start-dev' })).toBeDefined()
  await ui.unmount()
})

test('Stop never signals a pid that now runs something else', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  await $.command.run(typed('servers'))
  const ui = await mountPane($)

  // The pane drew pid 4242 as vite; since then the pid was reused.
  w.procs[0] = { ...w.procs[0]!, ports: [], commandLine: '/usr/bin/some-other-tool' }
  await pressFor(ui, clock, 'stop-4242', 1000)
  expect(w.events.filter(event => !event.startsWith('scan'))).toEqual([])
  expect(w.toasts).toEqual(['pid 4242 no longer runs dev; nothing was signalled'])
  expect(await ui.find({ key: 'stop-4242' })).toBeUndefined()
  await ui.unmount()
})

test('a server that ignores SIGTERM is force stopped only on a second press within 10s', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, isStubborn: true }])
  await $.command.run(typed('servers'))

  for (const surface of SURFACES) {
    w.events = []
    const ui = await mountPane($, surface)
    await pressFor(ui, clock, 'stop-4242', 6000)
    expect(w.events.filter(event => !event.startsWith('scan'))).toEqual(['TERM 4242'])
    expect(w.toasts.at(-1)).toBe(
      'dev (pid 4242) is still running 5s after SIGTERM. Press Stop again within 10s to force stop it.',
    )
    expect((await ui.find({ key: 'stop-4242' }))?.props.label).toBe('Force stop?')

    // The window closes: the next press is a plain SIGTERM again.
    await elapse(clock, 11_000)
    expect((await ui.find({ key: 'stop-4242' }))?.props.label).toBe('Stop')
    await pressFor(ui, clock, 'stop-4242', 6000)
    expect(w.events.filter(event => !event.startsWith('scan'))).toEqual(['TERM 4242', 'TERM 4242'])

    if (surface === 'desktop') {
      // Pressed again inside the window: SIGKILL.
      await pressFor(ui, clock, 'stop-4242', 3000)
      expect(w.events.filter(event => !event.startsWith('scan'))).toEqual(['TERM 4242', 'TERM 4242', 'KILL 4242'])
      expect(w.toasts.at(-1)).toBe('Force stopped dev (pid 4242) with SIGKILL')
      expect(w.statuses.at(-1)).toBeUndefined()
    } else {
      await elapse(clock, 11_000)
    }
    await ui.unmount()
  }
})

test('Restart stops, waits for the port to be free, then starts', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [{ ...VITE, lingers: 3 }])
  w.onStart = () => {
    w.procs.push({ ...VITE, pid: 6200, etime: '00:01', lingers: 0 })
  }
  await $.command.run(typed('servers'))
  const ui = await mountPane($)
  await pressFor(ui, clock, 'restart-4242', 5000)

  expect(w.events.filter(event => event === 'TERM 4242')).toHaveLength(1)
  const after = w.events.slice(w.events.indexOf('TERM 4242') + 1)
  const started = after.indexOf('start')
  expect(started).toBeGreaterThan(0)
  // The old server's port lingers for three scans after it exits; the wait sees it freed, and the start checks once more.
  const seen = after
    .slice(0, started)
    .filter(event => event.startsWith('scan'))
    .map(event => (event.includes(':5173') ? 'held' : 'free'))
  expect(seen).toEqual(['held', 'held', 'held', 'free', 'free'])
  // Then the new server listens.
  expect(after.slice(started + 1).some(event => event.startsWith('scan') && event.includes(':5173'))).toBe(true)
  expect(w.toasts).toEqual(['Restarted dev on :5173 (pid 6200)'])
  expect(w.started[0]?.argv[2]).toContain('nohup pnpm run dev > ')
  expect((await texts(ui)).some(text => text.includes('dev · :5173 :24678 · pid 6200'))).toBe(true)
  await ui.unmount()
})

test('Log toasts the last three lines of the log a pane start wrote', SLOW, async ($, on) => {
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

test('EADDRINUSE in Bash output adds a note naming the holder', SLOW, async ($, on) => {
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
  // The holder is looked up without lsof's listen scan: netstat for the port, then ps and lsof for that one pid.
  expect(w.ran.some(command => command.includes('-iTCP'))).toBe(false)
  expect(w.lookups).toEqual(['ps 123', 'cwd 123'])

  // No port in the message: the command's own --port names it; this holder is one of the project's own.
  w.procs[0] = { ...w.procs[0]!, pid: 124, ports: [8001], cwd: `${ROOT}/docs` }
  answer = { result: { stdout: '', stderr: '' }, text: 'OSError: [Errno 48] Address already in use' }
  const python = await $.tool.call({ tool: 'Bash', command: 'python3 -m http.server --port 8001' })
  expect(python.context).toEqual([
    `dev-servers: Port 8001 is held by node (pid 124, up 2h, in ${ROOT}/docs). It is one of this project's servers; /servers can restart or stop it.`,
  ])

  answer = { result: { stdout: 'ok', stderr: '' }, text: 'ready on http://localhost:3000' }
  const fine = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(fine.context).toBeUndefined()
  expect(w.toasts).toHaveLength(2)
})

test('the status line follows the project servers as the poll sees them', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, POSTGRES])
  await start($)
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

// ---------------------------------------------------------------------------
// The scan itself: never awaited at the start, netstat instead of lsof, one pid at a time, paced
// ---------------------------------------------------------------------------

test('starting the session never waits for the scan', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  w.beforeScan = () => clock.sleep(4_000)
  await start($)
  // Back at once, the scan still to answer.
  expect(w.statuses).toEqual([])
  await elapse(clock, 4_000)
  expect(scans(w)).toEqual(['netstat -anv -p tcp'])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
})

test('the poll reads netstat, and asks ps and lsof about each new pid once, one pid at a time', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, POSTGRES, RAPPORTD])
  await start($)
  await clock.settle()
  expect(scans(w)).toEqual(['netstat -anv -p tcp'])
  expect(w.ran.some(command => command.startsWith('lsof -nP') || command.includes('-iTCP'))).toBe(false)
  // ps for every pid, the one on a known port first; lsof only where the command line does not settle it
  // (rapportd lives in /usr/libexec: the system's, never this project's).
  expect(w.lookups).toEqual(['ps 4242', 'cwd 4242', 'ps 986', 'cwd 986', 'ps 646'])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])

  // The next poll asks nothing about the pids it knows.
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(2)
  expect(w.lookups).toHaveLength(5)

  // A new pid is looked up once; a vanished one is forgotten, so it is asked about again when it comes back.
  w.procs = [...w.procs.filter(proc => proc.pid !== POSTGRES.pid), { ...MOCK_API, cwd: ROOT }]
  await elapse(clock, 15_000)
  expect(w.lookups.slice(5)).toEqual(['ps 7001', 'cwd 7001'])
  expect(w.statuses.at(-1)).toBe('servers: :5173 :9229 :24678')
  w.procs.push(POSTGRES)
  await elapse(clock, 15_000)
  expect(w.lookups.slice(7)).toEqual(['ps 986', 'cwd 986'])
  expect(w.ran.some(command => command.startsWith('kill') || command.startsWith('sh'))).toBe(false)
})

test('a slow scan doubles the poll interval, up to five minutes; a fast one resets it', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  w.beforeScan = () => clock.sleep(3_000)
  await start($)
  await clock.settle()
  // The first scan takes 3s: slow, so the next comes 30s after it ends (t=33s), not 15s after the start.
  await elapse(clock, 3_000)
  expect(scans(w)).toHaveLength(1)
  await elapse(clock, 20_000)
  expect(scans(w)).toHaveLength(1)
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(2)
  // Slow again (it ends at 36s): 60s, so the next is at 96s.
  w.beforeScan = null
  await elapse(clock, 55_000)
  expect(scans(w)).toHaveLength(2)
  await elapse(clock, 5_000)
  expect(scans(w)).toHaveLength(3)
  // That one was fast: back to every 15s.
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(4)
  // Each change is said once, in the debug log.
  expect(w.logs.filter(line => line.includes('polling every')).map(line => /every (\d+)s/.exec(line)?.[1])).toEqual(['30', '60', '15'])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
})

test('a scan that times out keeps the last snapshot, backs off, and never falls back to lsof', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE])
  await start($)
  await clock.settle()
  expect(w.statuses).toEqual(['servers: :5173 :24678'])

  w.netstat = 'timeout'
  w.procs = []
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(2)
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
  expect(w.ran.some(command => command.startsWith('ss') || command.startsWith('lsof -nP'))).toBe(false)

  // The interval doubled: nothing at 30s, the next scan at 45s sees the server gone.
  w.netstat = 'table'
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(2)
  await elapse(clock, 15_000)
  expect(scans(w)).toHaveLength(3)
  expect(w.statuses).toEqual(['servers: :5173 :24678', undefined])
  expect(w.logs.filter(line => line.includes('polling every')).map(line => /every (\d+)s/.exec(line)?.[1])).toEqual(['30', '15'])
})

test('without netstat the scan uses ss, and remembers to', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, POSTGRES])
  w.netstat = 'missing'
  w.ss = 'table'
  await start($)
  await clock.settle()
  expect(w.ran.filter(command => /^(netstat|ss|lsof -nP)/.test(command))).toEqual(['netstat -anv -p tcp', 'ss -ltnp'])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
  expect(w.logs.some(line => line.includes('netstat') && line.includes('ss'))).toBe(true)
  await elapse(clock, 15_000)
  expect(w.ran.filter(command => /^(netstat|ss|lsof -nP)/.test(command))).toEqual(['netstat -anv -p tcp', 'ss -ltnp', 'ss -ltnp'])
})

test('without netstat or ss the scan falls back to lsof, and remembers to', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, POSTGRES])
  w.netstat = 'missing'
  await start($)
  await clock.settle()
  const listed = () => w.ran.filter(command => /^(netstat|ss|lsof -nP)/.test(command))
  expect(listed()).toEqual(['netstat -anv -p tcp', 'ss -ltnp', 'lsof -nP -iTCP -sTCP:LISTEN -Fpcn'])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
  await elapse(clock, 15_000)
  expect(listed().slice(3)).toEqual(['lsof -nP -iTCP -sTCP:LISTEN -Fpcn'])
})

// ---------------------------------------------------------------------------
// Sessions sharing one scan, and the tool the model gets
// ---------------------------------------------------------------------------

test('sessions share one scan: a fresh cache is shown as it is, a lock defers to the session scanning, a scan is written back', SLOW, async ($, on) => {
  const now = 1_000_000
  const clock = mock.clock(on, { now })
  const w = world(on, [VITE, POSTGRES])
  const cached = (ts: number, by: string, listeners: unknown[]) => JSON.stringify({ ts, by, data: { listeners } })
  const vite = {
    pid: 4242,
    command: 'node',
    ports: [5173, 24678],
    detail: { commandLine: VITE.commandLine, startedAt: now - 7_800_000, cwd: ROOT },
  }

  // Another session scanned 5s ago: its findings are shown, and nothing is run.
  w.files[CACHE] = cached(now - 5_000, 'session-b', [vite, { pid: 986, command: 'postgres', ports: [5432], detail: null }])
  await start($)
  await clock.settle()
  expect(scans(w)).toEqual([])
  expect(w.lookups).toEqual([])
  expect(w.statuses).toEqual(['servers: :5173 :24678'])
  const ui = await mountPane($)
  const shown = await texts(ui)
  expect(shown.some(text => text.includes('dev · :5173 :24678 · pid 4242 · up 2h'))).toBe(true)
  expect(shown).toContain('1 other listener on this machine')

  // By the next tick the cache is 14s old, but session-b took the lock 2s ago: wait for its scan, showing what there is.
  w.files[CACHE] = cached(now + 1_000, 'session-b', [{ ...vite, ports: [5173] }])
  w.files[LOCK] = JSON.stringify({ ts: now + 13_000, by: 'session-b' })
  await elapse(clock, 15_000)
  expect(scans(w)).toEqual([])
  expect(w.statuses.at(-1)).toBe('servers: :5173')
  expect(JSON.parse(w.files[LOCK] ?? '{}')).toEqual({ ts: now + 13_000, by: 'session-b' })

  // By the tick after, its lock is 60s old: a scan that never finished. This session scans and writes lock and cache for the others.
  w.files[LOCK] = JSON.stringify({ ts: now + 30_000 - 60_000, by: 'session-b' })
  await elapse(clock, 15_000)
  expect(scans(w)).toEqual(['netstat -anv -p tcp'])
  // Only the pid the cache did not know is looked up.
  expect(w.lookups).toEqual(['ps 986', 'cwd 986'])
  expect(w.statuses.at(-1)).toBe('servers: :5173 :24678')
  expect(JSON.parse(w.files[LOCK] ?? '{}')).toEqual({ ts: now + 30_000, by: 'session-a' })
  expect(JSON.parse(w.files[CACHE] ?? '{}')).toEqual({
    ts: now + 30_000,
    by: 'session-a',
    data: {
      listeners: [
        vite,
        {
          pid: 986,
          command: 'postgres',
          ports: [5432],
          detail: { commandLine: POSTGRES.commandLine, startedAt: now + 30_000 - 458_865_000, cwd: '/opt/homebrew/var/postgresql' },
        },
      ],
    },
  })
  await ui.unmount()
})

test('the dev_servers tool is registered for the model, allowed without asking, and lists servers, logs, stopped entries and other listeners', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, [VITE, MOCK_API, POSTGRES, RAPPORTD])
  await start($)
  await clock.settle()

  expect(w.tools.map(tool => tool.name)).toEqual(['dev_servers'])
  const [spec] = w.tools
  expect(spec?.isDeferred).toBe(false)
  expect(spec?.inputSchema).toMatchObject({ type: 'object', properties: { all: { type: 'boolean' } } })
  for (const word of ['lsof', 'netstat', 'ps', 'port', 'Read-only', '/servers']) {
    expect(spec?.description).toContain(word)
  }
  expect(await $.tool.check({ tool: TOOL, input: {} })).toMatchObject({ decision: 'allow' })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
  // A deny in settings stands.
  w.denied = [TOOL]
  expect(await $.tool.check({ tool: TOOL, input: {} })).toMatchObject({ decision: 'deny', reason: 'denied in settings' })
  w.denied = []

  // dev was started from the pane: its log has been written since the process started.
  w.files[`${LOGS}/dev.log`] = 'VITE ready'
  w.mtimes[`${LOGS}/dev.log`] = 1_000_000 - 7_000_000
  const ran = await $.tool.call({ tool: TOOL })
  expect(ran.result).toBe(
    [
      `Running in ${ROOT}:`,
      `  dev · :5173 :24678 · pid 4242 · up 2h · log ${LOGS}/dev.log`,
      '  node · :9229 · pid 7001 · up 5m',
      'Not running: dev:api (pnpm run dev:api, :4000), preview (pnpm run preview).',
      '2 other listeners on this machine (all: true lists them).',
      "Scanned 0s ago. Starting, stopping and restarting are the Servers pane's buttons (/servers); this tool only lists.",
    ].join('\n'),
  )

  // An older log is another run's; all: true lists every other listener with its port and process.
  w.mtimes[`${LOGS}/dev.log`] = 1_000_000 - 8_000_000
  const everything = String((await $.tool.call({ tool: TOOL, all: true })).result)
  expect(everything).not.toContain('· log ')
  expect(everything).toContain(
    ['Other listeners on this machine:', '  :5432 · postgres · pid 986 · in /opt/homebrew/var/postgresql', '  :53480 · rapportd · pid 646'].join('\n'),
  )
  // It only lists: nothing was signalled or started.
  expect(w.events.filter(event => !event.startsWith('scan'))).toEqual([])
})
