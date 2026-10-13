import type { EngineInterface, Register } from 'claude-code'

import type { Reservation, SampleLock, SharedSample, Snapshot } from '../types'
import {
  PROBE_TIMEOUT_MS,
  TOP_GAP_MS,
  biggestApps,
  criticalDenial,
  formatLeft,
  hasFreshTop,
  isHeavy,
  memoryOf,
  noTableText,
  parseDuration,
  parseGpu,
  parseLock,
  parseReservation,
  parseShared,
  parseSysctl,
  parseTopApps,
  parseVmStat,
  pressureOf,
  reservationDenial,
  statusLine,
  statusReport,
  coresContext,
  coresLine,
  coresToast,
  isParked,
  parseCores,
  warnContext,
} from './probe'

type Engine = EngineInterface

const SNAPSHOT = { plugin: 'machine-guard', key: 'snapshot' } as const
const PAUSED = { plugin: 'machine-guard', key: 'pausedUntil' } as const
const TOOL = 'mcp__machine-guard__machine_status'
/** A guard decision samples afresh when the last reading is older than this. */
const STALE_MS = 30_000
/** A sample slower than this, or with a probe that timed out, doubles the interval (up to the cap) and the next sample skips the GPU. */
const SLOW_MS = 2_000
const BACKOFF_CAP_MS = 120_000
/** The GPU (ioreg takes 10–40 s when the Mac swaps) is read on every third sample at most. */
const GPU_EVERY = 3
/** Another session's lock older than this is abandoned: a sample and its process table take two probe timeouts at most. */
const LOCK_STALE_MS = 2 * PROBE_TIMEOUT_MS

const TOOL_DESCRIPTION =
  "Memory, swap, GPU and the guard's verdict for this Mac from the sample all Claude sessions share, plus the apps holding the most memory: " +
  'whether heavy local work (training, inference, rendering, Docker, ffmpeg) may start now. ' +
  'Use this instead of running ps, top, vm_stat, memory_pressure or project scripts to check the load before launching heavy work: ' +
  'those take 10–40 s when the Mac is swapping and add to the load, while this reads the shared sample (and takes a process table at most once a minute).'

type Config = { sampleMs: number; blockOnCritical: boolean; busyMs: number; extra: RegExp | null }
type Probe = { text: string | null; isTimedOut: boolean }

let config: Config = { sampleMs: 15_000, blockOnCritical: true, busyMs: 4 * 3_600_000, extra: null }
/** The pace now: the configured interval, doubled after slow probes up to the cap. */
let intervalMs = config.sampleMs
let timer: { cancel: () => void } | null = null
let sampling: Promise<Snapshot | null> | null = null
/** This session's own count of samples and the last one's duration: what paces the GPU when the shared file cannot be read. */
let own = { n: 0, probeMs: 0 }
const fallbackId = `session-${Math.random().toString(36).slice(2, 10)}`

/** Runs one probe; a rejection (its timeout, or a command that cannot start) counts as timed out, the text left null. */
async function run($: Engine, argv: readonly string[]): Promise<Probe> {
  try {
    const out = await $.process.run(argv, { timeoutMs: PROBE_TIMEOUT_MS })
    return { text: out.exitCode === 0 ? out.stdout : null, isTimedOut: false }
  } catch {
    return { text: null, isTimedOut: true }
  }
}

async function homePath($: Engine, tail: string): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/${tail}` : null
}

async function reservationPath($: Engine): Promise<string | null> {
  return homePath($, '.claude/machine-guard.json')
}

async function readText($: Engine, path: string | null): Promise<string | null> {
  return path ? $.fs.read(path).catch(() => null) : null
}

async function writeJson($: Engine, path: string | null, value: unknown): Promise<void> {
  if (path) {
    await $.fs.write(path, `${JSON.stringify(value)}\n`).catch(() => undefined)
  }
}

async function readReservation($: Engine, now: number): Promise<Reservation | null> {
  return parseReservation(await readText($, await reservationPath($)), now)
}

async function readShared($: Engine): Promise<SharedSample | null> {
  return parseShared(await readText($, await homePath($, '.claude/machine-guard/sample.json')))
}

async function writeShared($: Engine, shared: SharedSample): Promise<void> {
  await writeJson($, await homePath($, '.claude/machine-guard/sample.json'), shared)
}

async function readLock($: Engine): Promise<SampleLock | null> {
  return parseLock(await readText($, await homePath($, '.claude/machine-guard/lock.json')))
}

async function writeLock($: Engine, lock: SampleLock): Promise<void> {
  await writeJson($, await homePath($, '.claude/machine-guard/lock.json'), lock)
}

async function sessionId($: Engine): Promise<string> {
  return $.session.id().catch(() => fallbackId)
}

async function pausedLeft($: Engine, now: number): Promise<number> {
  const { value = 0 } = await $.state.get(PAUSED)
  return Math.max(0, value - now)
}

async function showStatus($: Engine, snapshot: Snapshot | null, now: number) {
  const reservation = await readReservation($, now)
  $.ui.status(statusLine(snapshot, reservation, await pausedLeft($, now)) || undefined)
}

/** Sets the pace from how the last probes went, and logs each change once. */
function setPace($: Engine, probeMs: number, isTimedOut: boolean) {
  const isSlow = isTimedOut || probeMs > SLOW_MS
  const next = isSlow ? Math.min(intervalMs * 2, BACKOFF_CAP_MS) : config.sampleMs
  if (next === intervalMs) {
    return
  }
  intervalMs = next
  const every = `sampling every ${intervalMs / 1000} s`
  $.ui.log(
    isSlow
      ? `machine-guard: ${isTimedOut ? 'a probe timed out' : `probes took ${(probeMs / 1000).toFixed(1)} s`}; ${every} until they are fast again`
      : `machine-guard: probes are fast again; ${every}`,
    { to: 'debug' },
  )
}

/** Follows the pace the sampling session set (its interval is the shared sample's ttl), within the configured interval and the cap. */
function followPace($: Engine, ttlMs: number) {
  const next = Math.min(Math.max(ttlMs, config.sampleMs), BACKOFF_CAP_MS)
  if (next !== intervalMs) {
    intervalMs = next
    $.ui.log(`machine-guard: following another session's pace; sampling every ${intervalMs / 1000} s`, { to: 'debug' })
  }
}

function schedule($: Engine, delayMs = intervalMs) {
  timer?.cancel()
  timer = $.clock.after(delayMs, () => void tick($))
}

async function tick($: Engine) {
  await sample($)
  schedule($)
}

function ensureTimer($: Engine) {
  if (!timer) {
    schedule($)
  }
}

const isTopDue = (snapshot: Snapshot, now: number): boolean => snapshot.topTriedAt === null || now - snapshot.topTriedAt >= TOP_GAP_MS

/** The snapshot with the process table ps answered, or with the try noted when it did not. */
const withTable = (snapshot: Snapshot, ps: Probe, now: number): Snapshot => {
  const top = ps.text === null ? [] : parseTopApps(ps.text)
  return top.length > 0 ? { ...snapshot, top, topAt: now, topTriedAt: now } : { ...snapshot, topTriedAt: now }
}

/** Takes a snapshot in: this session's state and status line, and the toast when memory turned critical. */
async function adopt($: Engine, snapshot: Snapshot, previous: Snapshot | null, now: number): Promise<Snapshot> {
  await $.state.set(SNAPSHOT, snapshot)
  if (snapshot.pressure === 'critical' && previous?.pressure !== 'critical') {
    $.ui.toast(
      `Memory critical: ${snapshot.freePct ?? '?'}% free, swap ${snapshot.swapUsedGB}/${snapshot.swapTotalGB} GB.` +
        (snapshot.top.length > 0 ? ` Biggest: ${biggestApps(snapshot)}.` : '') +
        (config.blockOnCritical ? ' Heavy jobs are blocked.' : ''),
      { timeoutMs: 12_000 },
    )
  }
  // The performance cores parked, or back: one toast per change, in every session.
  if (snapshot.cpuTotal !== null && isParked(snapshot) !== isParked(previous)) {
    $.ui.toast(coresToast(snapshot), { timeoutMs: 12_000 })
  }
  await showStatus($, snapshot, now)
  return snapshot
}

/**
 * One sample: another session's when it is fresh, else this session's own, under the shared lock, from the kernel's
 * counters alone (one sysctl call and vm_stat); the GPU on every third sample unless the last one was slow, and the
 * process table only under pressure, at most once a minute.
 */
async function takeSample($: Engine): Promise<Snapshot | null> {
  const { value: previous = null } = await $.state.get(SNAPSHOT)
  const now = await $.clock.now()
  const shared = await readShared($)
  // Fresh: written within the sampler's interval (a ts in the future is nonsense and is sampled over).
  if (shared && now - shared.ts >= 0 && now - shared.ts < shared.ttlMs) {
    followPace($, shared.ttlMs)
    return adopt($, shared.data, previous, now)
  }
  const me = await sessionId($)
  const lock = await readLock($)
  if (lock && lock.by !== me && now - lock.ts < LOCK_STALE_MS) {
    // Another session is probing: show what there is and wait for its sample.
    return shared ? adopt($, shared.data, previous, now) : previous
  }
  await writeLock($, { ts: now, by: me })
  const prior = shared ?? { n: own.n, probeMs: own.probeMs, data: previous }
  const n = prior.n + 1
  const isGpuDue = (n - 1) % GPU_EVERY === 0 && prior.probeMs <= SLOW_MS
  const [sysctl, cores, vm, gpu] = await Promise.all([
    run($, ['sysctl', '-n', 'hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
    run($, ['sysctl', '-n', 'hw.ncpu', 'kern.sched_recommended_cores']),
    run($, ['vm_stat']),
    isGpuDue ? run($, ['ioreg', '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']) : Promise.resolve<Probe | null>(null),
  ])
  const at = await $.clock.now()
  let isTimedOut = sysctl.isTimedOut || cores.isTimedOut || vm.isTimedOut || (gpu?.isTimedOut ?? false)
  if (sysctl.text === null && vm.text === null) {
    own = { n: prior.n, probeMs: at - now }
    setPace($, at - now, isTimedOut)
    return previous
  }
  const memory = parseSysctl(sysctl.text ?? '')
  const figures = memoryOf(parseVmStat(vm.text ?? ''), memory.totalGB)
  const last = prior.data
  const gpuPct = gpu?.text ? parseGpu(gpu.text) : null
  const hasTop = last !== null && hasFreshTop(last, at)
  let snapshot: Snapshot = {
    at,
    pressure: pressureOf(memory.level, figures.freePct, memory.swapUsedGB, memory.swapTotalGB),
    level: memory.level,
    ...figures,
    totalGB: memory.totalGB,
    swapUsedGB: memory.swapUsedGB,
    swapTotalGB: memory.swapTotalGB,
    gpuPct: gpuPct ?? last?.gpuPct ?? null,
    gpuAt: gpuPct === null ? (last?.gpuAt ?? null) : at,
    // The cores the scheduler may use; carried from the last sample when the read fails.
    ...(parseCores(cores.text ?? '') ?? { cpuTotal: last?.cpuTotal ?? null, cpuRecommended: last?.cpuRecommended ?? null, cpuMask: last?.cpuMask ?? null }),
    top: hasTop && last ? last.top : [],
    topAt: hasTop && last ? last.topAt : null,
    topTriedAt: last?.topTriedAt ?? null,
  }
  // What is eating memory is asked only under pressure, at most once a minute: ps is the slowest probe of all.
  if (snapshot.pressure !== 'normal' && isTopDue(snapshot, at)) {
    await showStatus($, snapshot, at)
    const ps = await run($, ['ps', '-axo', 'rss=,comm='])
    isTimedOut = isTimedOut || ps.isTimedOut
    snapshot = withTable(snapshot, ps, await $.clock.now())
  }
  const done = await $.clock.now()
  own = { n, probeMs: done - now }
  setPace($, done - now, isTimedOut)
  await writeShared($, { ts: at, by: me, ttlMs: intervalMs, probeMs: done - now, n, data: snapshot })
  return adopt($, snapshot, previous, done)
}

/** The latest reading, one sample at a time: callers while one is under way get that one. */
function sample($: Engine): Promise<Snapshot | null> {
  if (!sampling) {
    sampling = takeSample($).finally(() => {
      sampling = null
    })
  }
  return sampling
}

/** The latest reading with a process table taken when one is due: what /guard and machine_status show. */
async function inspect($: Engine): Promise<Snapshot | null> {
  const sampled = await sample($)
  if (!sampled) {
    return null
  }
  const now = await $.clock.now()
  if (!isTopDue(sampled, now)) {
    return sampled
  }
  const ps = await run($, ['ps', '-axo', 'rss=,comm='])
  const after = await $.clock.now()
  const snapshot = withTable(sampled, ps, after)
  if (ps.isTimedOut || after - now > SLOW_MS) {
    setPace($, after - now, ps.isTimedOut)
  }
  const shared = await readShared($)
  if (shared && shared.data.at === snapshot.at) {
    await writeShared($, { ...shared, probeMs: Math.max(shared.probeMs, after - now), data: snapshot })
  }
  await $.state.set(SNAPSHOT, snapshot)
  await showStatus($, snapshot, after)
  return snapshot
}

async function freshSnapshot($: Engine, now: number): Promise<Snapshot | null> {
  const { value = null } = await $.state.get(SNAPSHOT)
  return value && now - value.at <= STALE_MS ? value : sample($)
}

async function describe($: Engine): Promise<string> {
  const snapshot = await inspect($)
  const now = await $.clock.now()
  const reservation = await readReservation($, now)
  const paused = await pausedLeft($, now)
  const lines = snapshot
    ? [
        `Memory pressure: ${snapshot.pressure}${snapshot.freePct === null ? '' : ` (${snapshot.freePct}% free)`}`,
        `Swap: ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB`,
        `GPU: ${snapshot.gpuPct === null ? 'unknown' : `${snapshot.gpuPct}%`}`,
        coresLine(snapshot),
        `Biggest: ${hasFreshTop(snapshot, now) ? biggestApps(snapshot) : noTableText(snapshot, now)}`,
      ]
    : ['Memory could not be read on this machine.']
  lines.push(
    reservation
      ? `Reserved for "${reservation.reason}" for ${formatLeft(reservation.until - now)} more (/busy off lifts it)`
      : 'Not reserved (/busy [2h] [reason] reserves it)',
    paused > 0 ? `Guard paused for ${formatLeft(paused)} (/guard on resumes)` : 'Guard on (/guard pause 15m pauses it)',
  )
  return lines.join('\n')
}

async function machineStatus($: Engine): Promise<string> {
  const snapshot = await inspect($)
  const now = await $.clock.now()
  const reservation = await readReservation($, now)
  const paused = await pausedLeft($, now)
  return statusReport(snapshot, reservation, paused, now, { sampleMs: config.sampleMs, intervalMs, blockOnCritical: config.blockOnCritical })
}

export const register: Register = (on, options) => {
  let extra: RegExp | null = null
  try {
    extra = options.extraHeavy ? new RegExp(String(options.extraHeavy), 'i') : null
  } catch {
    extra = null
  }
  config = {
    sampleMs: Math.max(5, Number(options.sampleSeconds ?? 15)) * 1000,
    blockOnCritical: options.blockOnCritical !== false,
    busyMs: Math.max(0.1, Number(options.busyHours ?? 4)) * 3_600_000,
    extra,
  }
  intervalMs = config.sampleMs
  timer = null
  sampling = null
  own = { n: 0, probeMs: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'busy',
      description: 'Reserve this Mac: block heavy local jobs in every Claude session',
      argumentHint: '[2h] [reason] | off',
      immediate: true,
    })
    await $.command.register({
      name: 'guard',
      description: 'Show memory, swap, GPU and the guard; pause or resume it',
      argumentHint: '[pause 15m | on]',
      immediate: true,
    })
    await $.tool
      .register({ name: 'machine_status', description: TOOL_DESCRIPTION, inputSchema: { type: 'object', properties: {} }, isDeferred: false })
      .catch(error => $.ui.log(`machine-guard: the machine_status tool did not register: ${String(error)}`, { to: 'debug' }))
    const now = await $.clock.now()
    const reservation = await readReservation($, now)
    if (reservation) {
      $.ui.toast(`This Mac is reserved for "${reservation.reason}" for ${formatLeft(reservation.until - now)}: heavy jobs are blocked.`)
    }
    // The first sample runs on a timer of its own, never awaited here: a probe takes 10–40 s when the Mac swaps.
    schedule($, 0)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isHeavy(e.command, config.extra)) {
      return next(e)
    }
    ensureTimer($)
    const now = await $.clock.now()
    if ((await pausedLeft($, now)) > 0) {
      return next(e)
    }
    const reservation = await readReservation($, now)
    if (reservation) {
      $.ui.toast(`machine-guard blocked a heavy job: the Mac is reserved for "${reservation.reason}"`)
      return { deny: reservationDenial(reservation, e.command, now) }
    }
    const snapshot = await freshSnapshot($, now)
    if (snapshot?.pressure === 'critical' && config.blockOnCritical) {
      $.ui.toast('machine-guard blocked a heavy job: memory is critical')
      return { deny: criticalDenial(snapshot, e.command) }
    }
    const ran = await next(e)
    if (!snapshot || ran.deny !== undefined) {
      return ran
    }
    // Notes for the model: tight memory, and parked cores, when either holds.
    const notes = [...(snapshot.pressure === 'warn' ? [warnContext(snapshot)] : []), ...(isParked(snapshot) ? [coresContext(snapshot)] : [])]
    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  })

  on('tool.check', { tool: TOOL }, async ($, e, next) => {
    const verdict = await next(e)
    // The tool only reads the shared sample: it never needs to ask, though a deny in settings stands.
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'machine-guard: reads the shared memory sample' }
  })

  on('tool.call', { tool: TOOL }, async $ => ({ result: await machineStatus($) }))

  on('command.run', { command: 'busy' }, async ($, e) => {
    const now = await $.clock.now()
    const args = e.args.trim()
    const path = await reservationPath($)
    if (!path) {
      return { text: 'machine-guard: HOME is not set, so the reservation cannot be saved.' }
    }
    const { value: snapshot = null } = await $.state.get(SNAPSHOT)
    if (args === '') {
      const reservation = await readReservation($, now)
      return {
        text: reservation
          ? `Reserved for "${reservation.reason}" for ${formatLeft(reservation.until - now)} more. /busy off lifts it.`
          : 'Not reserved. /busy [2h] [reason] reserves this Mac.',
      }
    }
    if (/^(off|done|clear|free)$/i.test(args)) {
      await $.fs.write(path, '{}\n')
      await showStatus($, snapshot, now)
      return { text: 'Reservation lifted: heavy jobs can run again.' }
    }
    const [first = '', ...rest] = args.split(/\s+/)
    const duration = parseDuration(first)
    const reason = (duration === null ? args : rest.join(' ')) || 'busy'
    const reservation: Reservation = { reason, until: now + (duration ?? config.busyMs), setAt: now }
    await $.fs.write(path, `${JSON.stringify(reservation, null, 2)}\n`)
    await showStatus($, snapshot, now)
    return {
      text: `Reserved this Mac for "${reason}" for ${formatLeft(reservation.until - now)}. Heavy local jobs are blocked in every Claude session until then; /busy off lifts it.`,
    }
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const [verb = '', amount = ''] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    const { value: snapshot = null } = await $.state.get(SNAPSHOT)
    if (verb === 'pause') {
      const ms = parseDuration(amount || '15m')
      if (ms === null) {
        return { text: 'Usage: /guard pause 15m (or 2h)' }
      }
      await $.state.set(PAUSED, now + ms)
      await showStatus($, snapshot, now)
      return { text: `Guard paused for ${formatLeft(ms)} in this session.` }
    }
    if (verb === 'on' || verb === 'resume') {
      await $.state.set(PAUSED, 0)
      await showStatus($, snapshot, now)
      return { text: 'Guard on.' }
    }
    return { text: await describe($) }
  })
}
