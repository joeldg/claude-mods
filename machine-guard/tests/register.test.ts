import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ToolSpec } from 'claude-code'

const HEAVY = '.venv/bin/python -m experiments.coarse_model.train --epochs 3'
const LIGHT = 'git status --porcelain'
const HOME = '/Users/me'
const RESERVATION = `${HOME}/.claude/machine-guard.json`
const SHARED = `${HOME}/.claude/machine-guard/sample.json`
const LOCK = `${HOME}/.claude/machine-guard/lock.json`
const TOOL = 'mcp__machine-guard__machine_status'
const SLOW = { timeoutMs: 30_000 }

const MEMSIZE = 51_539_607_552
const PAGE = 16_384
const SWAP = 'total = 8192.00M  used = 7987.20M  free = 204.80M  (encrypted)'
const PS = ` 32505856 ${HOME}/app/.venv/bin/python3.12\n 9437184 /Applications/Claude.app/Contents/MacOS/Claude\n`

type World = {
  level: number
  freePct: number
  gpu: number
  /** kern.sched_recommended_cores: 65535 is all sixteen CPUs, 15 the four efficiency cores alone. */
  mask: number
  /** Milliseconds a probe (by command) takes before answering. */
  slow: Record<string, number>
  /** Probes (by command) that never answer within their timeout. */
  timesOut: Set<string>
  sessionId: string
  files: Map<string, string>
  toasts: string[]
  statuses: (string | undefined)[]
  logs: { text: string; to: string }[]
  tools: ToolSpec[]
  /** Every probe's command, in order; and when each sample's sysctl was asked. */
  probes: string[]
  probeAt: number[]
  ran: string[]
}

/** vm_stat as macOS prints it, with free + inactive + speculative pages making up `freePct` of the memory. */
const vmStat = (freePct: number): string => {
  const unused = Math.round((freePct / 100) * (MEMSIZE / PAGE))
  return [
    `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)`,
    `Pages free:                               ${unused - 20_000}.`,
    'Pages active:                            1031321.',
    'Pages inactive:                            15000.',
    'Pages speculative:                          5000.',
    'Pages throttled:                               0.',
    'Pages wired down:                         550553.',
    'Pages purgeable:                            4521.',
    'Pages stored in compressor:              1849732.',
    'Pages occupied by compressor:             451287.',
    'Swapins:                                21611010.',
    '',
  ].join('\n')
}

/** Answers the host beneath the plugin: macOS probes, files, the session, toasts, the status line and the log. */
const world = (on: On, clock: MockClock): World => {
  const w: World = {
    level: 1,
    freePct: 40,
    gpu: 91,
    mask: 65535,
    slow: {},
    timesOut: new Set(),
    sessionId: 'sess-a',
    files: new Map(),
    toasts: [],
    statuses: [],
    logs: [],
    tools: [],
    probes: [],
    probeAt: [],
    ran: [],
  }
  mock.env(on, { HOME })
  on('process.run', async (_$, e) => {
    // The CPU read is a second sysctl call, told apart by its keys and recorded as `cores`.
    const command = e.argv[0] === 'sysctl' && e.argv.includes('hw.ncpu') ? 'cores' : (e.argv[0] ?? '')
    w.probes.push(command)
    if (command === 'sysctl') {
      w.probeAt.push(clock.now())
    }
    const delay = w.slow[command] ?? 0
    if (delay > 0) {
      await clock.sleep(delay)
    }
    if (w.timesOut.has(command)) {
      return { deny: `${command} aborted: still running after 10000ms` }
    }
    const outputs: Record<string, string> = {
      sysctl: `${MEMSIZE}\n${SWAP}\n${w.level}\n`,
      cores: `16\n${w.mask}\n`,
      vm_stat: vmStat(w.freePct),
      ps: PS,
      ioreg: `"Device Utilization %"=${w.gpu}`,
    }
    const stdout = outputs[command] ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.sessionId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__machine-guard__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  return w
}

/** An interactive session's start; the first sample has run once the clock settled. */
const start = async ($: Engine, clock: MockClock) => {
  await $.session.start({ cwd: `${HOME}/app`, surface: 'terminal', isInteractive: true })
  await clock.settle()
}

const count = (w: World, command: string) => w.probes.filter(probe => probe === command).length

const shared = (w: World) => JSON.parse(w.files.get(SHARED) ?? 'null') as { ts: number; by: string; ttlMs: number; probeMs: number; n: number; data: { at: number; gpuPct: number | null } } | null

type Outcome = { deny?: string; isError?: boolean; text?: string }

/** Whether the call was refused, and why: a deny, or the errored result a deny becomes. */
const refusal = (outcome: Outcome): string | undefined =>
  outcome.deny ?? (outcome.isError === true ? outcome.text : undefined)

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

test('refuses a heavy job while memory is critical and lets light commands through', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.level = 4

  const refused = refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))
  expect(refused).toMatch(/memory pressure is critical .*biggest: python 31 GB, Claude 9 GB/)
  expect(refused).toMatch(/\/guard pause 15m/)
  expect(w.toasts).toContain('machine-guard blocked a heavy job: memory is critical')

  await $.tool.call({ tool: 'Bash', command: LIGHT })
  expect(w.ran).toEqual([LIGHT])
  expect(w.statuses.at(-1)).toBe('RAM CRITICAL 40% free · swap 7.8/8G · top python 31G · GPU 91%')
})

test('warns the model when memory is tight but runs the job', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.level = 2

  const ran = await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
  expect(ran.context?.join('\n')).toMatch(/memory is tight .*one at a time/)
})

test('/busy blocks heavy jobs until /busy off, whatever the memory', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)

  const reserved = await $.command.run(typed('busy', '2h training a vision model'))
  expect(reserved.text).toMatch(/^Reserved this Mac for "training a vision model" for 2h00m/)
  expect(JSON.parse(w.files.get(RESERVATION) ?? '{}')).toEqual({
    reason: 'training a vision model',
    until: 1_000_000 + 7_200_000,
    setAt: 1_000_000,
  })

  const refused = refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))
  expect(refused).toMatch(/reserved this Mac for "training a vision model" for 2h00m more/)
  expect(refused).toMatch(/\/busy off/)
  expect(w.ran).toEqual([])

  await $.command.run(typed('busy', 'off'))
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
})

test('a reservation written by another session is honoured, and runs out', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock)
  w.files.set(RESERVATION, JSON.stringify({ reason: 'overnight training', until: 600_000, setAt: 0 }))

  expect(refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))).toBeDefined()
  await clock.advance(600_001)
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
})

test('/guard pause lets a heavy job through until it runs out', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock)
  w.level = 4

  const paused = await $.command.run(typed('guard', 'pause 15m'))
  expect(paused.text).toBe('Guard paused for 15m in this session.')
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])

  await clock.advance(16 * 60_000)
  expect(refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))).toBeDefined()
})

test('/guard reports what it sees, taking a process table on demand', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock)
  w.level = 2
  w.freePct = 12
  const shown = await $.command.run(typed('guard', ''))
  expect(shown.text).toBe(
    [
      'Memory pressure: warn (12% free)',
      'Swap: 7.8 of 8 GB',
      'GPU: 91%',
      'CPU cores: 16 of 16 available.',
      'Biggest: python 31 GB, Claude 9 GB',
      'Not reserved (/busy [2h] [reason] reserves it)',
      'Guard on (/guard pause 15m pauses it)',
    ].join('\n'),
  )
  expect(count(w, 'ps')).toBe(1)
  expect(count(w, 'memory_pressure')).toBe(0)
})

test('the regular sample reads kernel counters only: the GPU every third time, the process table never', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  await start($, clock)

  // The first sample: memory size, swap and pressure level in one sysctl call, vm_stat, and the GPU.
  expect(w.probes).toEqual(['sysctl', 'cores', 'vm_stat', 'ioreg'])
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')

  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(count(w, 'sysctl')).toBe(3)
  expect(count(w, 'ioreg')).toBe(1)
  await clock.advance(15_000)
  expect(count(w, 'sysctl')).toBe(4)
  expect(count(w, 'ioreg')).toBe(2)
  expect(count(w, 'ps')).toBe(0)
  expect(count(w, 'memory_pressure')).toBe(0)
  // The GPU reading is carried between reads.
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')
})

test('the process table is taken when a sample shows pressure, at most once a minute', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.level = 2
  await start($, clock)

  expect(count(w, 'ps')).toBe(1)
  expect(w.statuses.at(-1)).toBe('RAM tight 40% free · swap 7.8/8G · top python 31G · GPU 91%')
  await clock.advance(15_000)
  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(count(w, 'sysctl')).toBe(4)
  expect(count(w, 'ps')).toBe(1)
  await clock.advance(15_000)
  expect(count(w, 'ps')).toBe(2)

  // Back to normal: no more tables, and the status line drops the biggest app.
  w.level = 1
  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(count(w, 'ps')).toBe(2)
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')
})

test('a slow probe doubles the interval up to two minutes; a fast one resets it', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock)
  w.slow.vm_stat = 3_000
  await start($, clock)
  expect(w.probeAt).toEqual([0])
  expect(w.statuses).toEqual([])
  await clock.advance(3_000)
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')

  // 15 s → 30 s → 60 s → 120 s, then the cap.
  await clock.advance(30_000)
  await clock.advance(3_000)
  await clock.advance(60_000)
  await clock.advance(3_000)
  await clock.advance(120_000)
  await clock.advance(3_000)
  await clock.advance(120_000)
  expect(w.probeAt).toEqual([0, 33_000, 96_000, 219_000, 342_000])
  await clock.advance(3_000)

  // Fast again: the interval is the configured one from the next sample on.
  w.slow = {}
  await clock.advance(120_000)
  expect(w.probeAt).toEqual([0, 33_000, 96_000, 219_000, 342_000, 465_000])
  await clock.advance(15_000)
  expect(w.probeAt.at(-1)).toBe(480_000)

  // Each change of pace is logged once, to the debug log.
  expect(w.logs.map(line => line.to)).toEqual(['debug', 'debug', 'debug', 'debug'])
  expect(w.logs.map(line => line.text)).toEqual([
    'machine-guard: probes took 3.0 s; sampling every 30 s until they are fast again',
    'machine-guard: probes took 3.0 s; sampling every 60 s until they are fast again',
    'machine-guard: probes took 3.0 s; sampling every 120 s until they are fast again',
    'machine-guard: probes are fast again; sampling every 15 s',
  ])
})

test('a probe that times out counts as slow, and the GPU is skipped after a slow sample', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock)
  w.timesOut.add('vm_stat')
  await start($, clock)
  // Swap and the level still come from sysctl; the status line does without the free percentage.
  expect(w.statuses.at(-1)).toBe('RAM · swap 7.8/8G · GPU 91%')
  expect(w.logs.map(line => line.text)).toEqual(['machine-guard: a probe timed out; sampling every 30 s until they are fast again'])
  await clock.advance(15_000)
  expect(w.probeAt).toEqual([0])
  await clock.advance(15_000)
  expect(w.probeAt).toEqual([0, 30_000])

  // The GPU's turn comes on the fourth sample, but the third was slow: ioreg is skipped until a fast sample.
  w.timesOut.clear()
  w.slow.vm_stat = 2_500
  await clock.advance(60_000)
  await clock.advance(2_500)
  expect(w.probeAt).toEqual([0, 30_000, 90_000])
  w.slow = {}
  await clock.advance(120_000)
  expect(w.probeAt).toEqual([0, 30_000, 90_000, 212_500])
  expect(count(w, 'ioreg')).toBe(1)
  await clock.advance(15_000)
  await clock.advance(15_000)
  await clock.advance(15_000)
  expect(w.probeAt).toHaveLength(7)
  expect(count(w, 'ioreg')).toBe(2)
})

test('sessions share one sample: a fresh one is shown without probing, a stale one is retaken under a lock', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  const data = {
    at: 995_000,
    pressure: 'normal',
    level: 1,
    freePct: 21,
    unusedGB: 10.1,
    totalGB: 48,
    compressorGB: 6.9,
    compressedGB: 28.2,
    swapUsedGB: 16.7,
    swapTotalGB: 18,
    gpuPct: 3,
    gpuAt: 995_000,
    top: [],
    topAt: null,
    topTriedAt: null,
  }
  w.files.set(SHARED, JSON.stringify({ ts: 995_000, by: 'sess-b', ttlMs: 15_000, probeMs: 120, n: 7, data }))
  await start($, clock)

  expect(w.probes).toEqual([])
  expect(w.statuses.at(-1)).toBe('RAM 21% free · swap 16.7/18G · GPU 3%')
  expect(w.files.has(LOCK)).toBe(false)

  // 20 s after the other session's sample it is stale: this session takes the lock and the next one.
  await clock.advance(15_000)
  expect(w.probes).toEqual(['sysctl', 'cores', 'vm_stat'])
  expect(JSON.parse(w.files.get(LOCK) ?? '{}')).toEqual({ ts: 1_015_000, by: 'sess-a' })
  expect(shared(w)).toMatchObject({ ts: 1_015_000, by: 'sess-a', ttlMs: 15_000, probeMs: 0, n: 8, data: { at: 1_015_000, gpuPct: 3 } })
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 3%')
})

test('a lock another session holds defers the sample until it is abandoned', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.files.set(LOCK, JSON.stringify({ ts: 999_500, by: 'sess-b' }))
  await start($, clock)
  expect(w.probes).toEqual([])
  await clock.advance(15_000)
  expect(w.probes).toEqual([])
  // Older than two probe timeouts (20 s): abandoned.
  await clock.advance(15_000)
  expect(w.probes).toEqual(['sysctl', 'cores', 'vm_stat', 'ioreg'])
  expect(JSON.parse(w.files.get(LOCK) ?? '{}')).toEqual({ ts: 1_030_000, by: 'sess-a' })
})

test('a session whose own lock is left behind still samples', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.files.set(LOCK, JSON.stringify({ ts: 999_500, by: 'sess-a' }))
  await start($, clock)
  expect(w.probes).toEqual(['sysctl', 'cores', 'vm_stat', 'ioreg'])
})

test('session.start does not wait for the first sample', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.slow.vm_stat = 5_000

  let isStarted = false
  const starting = $.session.start({ cwd: `${HOME}/app`, surface: 'terminal', isInteractive: true }).then(() => {
    isStarted = true
  })
  await clock.settle()
  expect(isStarted).toBe(true)
  expect(w.probes).toEqual(['sysctl', 'cores', 'vm_stat', 'ioreg'])
  expect(w.statuses).toEqual([])
  await clock.advance(5_000)
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')
  await starting
})

test('machine_status gives the model the numbers, the verdict and the biggest apps without a permission prompt', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  await start($, clock)

  expect(w.tools).toHaveLength(1)
  const [spec] = w.tools
  expect(spec).toMatchObject({ name: 'machine_status', isDeferred: false, inputSchema: { type: 'object', properties: {} } })
  expect(spec?.description).toMatch(/instead of .*ps.*top.*vm_stat.*memory_pressure.*project scripts/)
  expect(await $.tool.check({ tool: TOOL, input: {} })).toMatchObject({ decision: 'allow' })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')

  const first = await $.tool.call({ tool: TOOL })
  expect(first.result).toBe(
    [
      'machine-guard · sampled just now · every 15 s, one sample shared by all sessions',
      'RAM: 40% free · 19.2 of 48 GB unused (free + inactive + speculative pages) · compressor holds 28.2 GB in 6.9 GB',
      'Swap: 7.8 of 8 GB used',
      'GPU: 91%',
      'CPU cores: 16 of 16 available.',
      'Pressure: normal (kernel level 1)',
      'Biggest apps (ps just now): python 31 GB, Claude 9 GB',
      'Verdict: ok — heavy local jobs may start.',
      'Rules: blocked when memory is critical (kernel level 4, or under 10% free with swap 95% full) or while /busy reserves the Mac; when memory is tight (under 20% free, or kernel level 2) the job runs with a note to run one at a time.',
    ].join('\n'),
  )
  expect(count(w, 'ps')).toBe(1)

  // Ten seconds on: the shared sample is fresh, the table is recent; nothing is probed again.
  await clock.advance(10_000)
  const again = String((await $.tool.call({ tool: TOOL })).result).split('\n')
  expect(again[0]).toBe('machine-guard · sampled 10 s ago · every 15 s, one sample shared by all sessions')
  expect(again[3]).toBe('GPU: 91% (read 10 s ago)')
  expect(again[6]).toBe('Biggest apps (ps 10 s ago): python 31 GB, Claude 9 GB')
  expect(count(w, 'sysctl')).toBe(1)
  expect(count(w, 'ps')).toBe(1)

  // Memory turns critical: the next sample says so and the verdict is busy.
  w.level = 4
  await clock.advance(5_000)
  expect(w.toasts.at(-1)).toBe('Memory critical: 40% free, swap 7.8/8 GB. Biggest: python 31 GB, Claude 9 GB. Heavy jobs are blocked.')
  const busy = String((await $.tool.call({ tool: TOOL })).result).split('\n')
  expect(busy[5]).toBe('Pressure: critical (kernel level 4)')
  expect(busy[7]).toBe('Verdict: busy — memory is critical: heavy local jobs are blocked (the user can lift this with /guard pause 15m).')
  expect(count(w, 'ps')).toBe(1)
})

test('machine_status says how to get a process table when ps does not answer', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.timesOut.add('ps')
  w.files.set(RESERVATION, JSON.stringify({ reason: 'overnight training', until: 1_600_000, setAt: 1_000_000 }))
  await start($, clock)

  const lines = String((await $.tool.call({ tool: TOOL })).result).split('\n')
  expect(count(w, 'ps')).toBe(1)
  expect(lines[6]).toBe(
    'Biggest apps: no process table — ps did not answer within 10 s (tried just now; the Mac is that loaded). machine_status and /guard try again at most once a minute, or run `ps -axo rss=,comm= | sort -rn | head -5` yourself.',
  )
  expect(lines[7]).toBe('Verdict: busy — the Mac is reserved for "overnight training" for 10m more: heavy local jobs are blocked (/busy off lifts it).')

  // Asked again within the minute, it does not try again.
  await clock.advance(30_000)
  await $.tool.call({ tool: TOOL })
  expect(count(w, 'ps')).toBe(1)
  await clock.advance(30_000)
  await $.tool.call({ tool: TOOL })
  expect(count(w, 'ps')).toBe(2)
})

test('parked performance cores show on the status line and toast once per episode', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.mask = 15
  await start($, clock)

  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91% · CPU 4/16 cores')
  const parked = () => w.toasts.filter(text => text.startsWith('macOS has parked the performance cores'))
  expect(parked()).toHaveLength(1)
  expect(parked()[0]).toMatch(/4 of 16 CPUs \(kern\.sched_recommended_cores = 15\)/)

  // The controller lets one core per cluster back: still parked, no second toast.
  w.mask = 1055
  await clock.advance(15_000)
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91% · CPU 6/16 cores')
  expect(parked()).toHaveLength(1)

  // All cores back: one toast, and the segment leaves the status line.
  w.mask = 65535
  await clock.advance(15_000)
  expect(w.statuses.at(-1)).toBe('RAM 40% free · swap 7.8/8G · GPU 91%')
  expect(w.toasts.filter(text => text === 'All 16 CPU cores are back.')).toHaveLength(1)

  // Parked again: a new episode, a new toast.
  w.mask = 15
  await clock.advance(15_000)
  expect(parked()).toHaveLength(2)
})

test('tells the model when it starts heavy work while the cores are parked', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock)
  w.mask = 15
  await start($, clock)

  const ran = await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
  expect(ran.context?.join('\n')).toMatch(/scheduling on 4 of 16 CPU cores right now/)
  const light = await $.tool.call({ tool: 'Bash', command: LIGHT })
  expect(light.context ?? []).toEqual([])
})
