import type { EngineInterface, Register } from 'claude-code'

import type { Reservation, Snapshot } from '../types'
import {
  criticalDenial,
  formatLeft,
  isHeavy,
  parseDuration,
  parseFreePct,
  parseGpu,
  parseReservation,
  parseSysctl,
  parseTopApps,
  pressureOf,
  reservationDenial,
  statusLine,
  warnContext,
} from './probe'

type Engine = EngineInterface

const SNAPSHOT = { plugin: 'machine-guard', key: 'snapshot' } as const
const PAUSED = { plugin: 'machine-guard', key: 'pausedUntil' } as const
/** A guard decision samples afresh when the last reading is older than this. */
const STALE_MS = 30_000

type Config = { sampleMs: number; blockOnCritical: boolean; busyMs: number; extra: RegExp | null }

let config: Config = { sampleMs: 15_000, blockOnCritical: true, busyMs: 4 * 3_600_000, extra: null }
let timer: { cancel: () => void } | null = null
let isSampling = false

async function run($: Engine, argv: readonly string[]): Promise<string | null> {
  const out = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null)
  return out && out.exitCode === 0 ? out.stdout : null
}

async function reservationPath($: Engine): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/machine-guard.json` : null
}

async function readReservation($: Engine, now: number): Promise<Reservation | null> {
  const path = await reservationPath($)
  if (!path) {
    return null
  }
  const text = await $.fs.read(path).catch(() => null)
  return parseReservation(text, now)
}

async function pausedLeft($: Engine, now: number): Promise<number> {
  const { value = 0 } = await $.state.get(PAUSED)
  return Math.max(0, value - now)
}

async function showStatus($: Engine, snapshot: Snapshot | null, now: number) {
  const reservation = await readReservation($, now)
  $.ui.status(statusLine(snapshot, reservation, await pausedLeft($, now)) || undefined)
}

async function sample($: Engine): Promise<Snapshot | null> {
  const { value: previous = null } = await $.state.get(SNAPSHOT)
  if (isSampling) {
    return previous
  }
  isSampling = true
  try {
    const [sysctl, free, ps, gpu] = await Promise.all([
      run($, ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']),
      run($, ['memory_pressure', '-Q']),
      run($, ['ps', '-axo', 'rss=,comm=']),
      run($, ['ioreg', '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
    ])
    if (sysctl === null && free === null) {
      return previous
    }
    const memory = parseSysctl(sysctl ?? '')
    const freePct = parseFreePct(free ?? '')
    const now = await $.clock.now()
    const snapshot: Snapshot = {
      at: now,
      pressure: pressureOf(memory.level, freePct, memory.swapUsedGB, memory.swapTotalGB),
      freePct,
      swapUsedGB: memory.swapUsedGB,
      swapTotalGB: memory.swapTotalGB,
      gpuPct: parseGpu(gpu ?? ''),
      top: parseTopApps(ps ?? ''),
    }
    await $.state.set(SNAPSHOT, snapshot)
    if (snapshot.pressure === 'critical' && previous?.pressure !== 'critical') {
      const top = snapshot.top.map(app => `${app.name} ${app.gb} GB`).join(', ')
      $.ui.toast(
        `Memory critical: ${snapshot.freePct ?? '?'}% free, swap ${snapshot.swapUsedGB}/${snapshot.swapTotalGB} GB. Biggest: ${top}.` +
          (config.blockOnCritical ? ' Heavy jobs are blocked.' : ''),
        { timeoutMs: 12_000 },
      )
    }
    await showStatus($, snapshot, now)
    return snapshot
  } finally {
    isSampling = false
  }
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.sampleMs, () => void sample($))
  }
}

async function freshSnapshot($: Engine, now: number): Promise<Snapshot | null> {
  const { value = null } = await $.state.get(SNAPSHOT)
  return value && now - value.at <= STALE_MS ? value : sample($)
}

async function describe($: Engine): Promise<string> {
  const snapshot = await sample($)
  const now = await $.clock.now()
  const reservation = await readReservation($, now)
  const paused = await pausedLeft($, now)
  const lines = snapshot
    ? [
        `Memory pressure: ${snapshot.pressure}${snapshot.freePct === null ? '' : ` (${snapshot.freePct}% free)`}`,
        `Swap: ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB`,
        `GPU: ${snapshot.gpuPct === null ? 'unknown' : `${snapshot.gpuPct}%`}`,
        `Biggest: ${snapshot.top.map(app => `${app.name} ${app.gb} GB`).join(', ')}`,
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
  timer = null

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
    ensureTimer($)
    const now = await $.clock.now()
    const reservation = await readReservation($, now)
    if (reservation) {
      $.ui.toast(`This Mac is reserved for "${reservation.reason}" for ${formatLeft(reservation.until - now)}: heavy jobs are blocked.`)
    }
    void sample($)
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
    if (snapshot?.pressure === 'warn' && ran.deny === undefined) {
      return { ...ran, context: [...(ran.context ?? []), warnContext(snapshot)] }
    }
    return ran
  })

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
