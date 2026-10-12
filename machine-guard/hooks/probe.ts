import type { AppMemory, Pressure, Reservation, SampleLock, SharedSample, Snapshot } from '../types'

/** Unused memory below this share is tight; below CRITICAL_BELOW_PCT with the swap this full, critical. */
export const TIGHT_BELOW_PCT = 20
export const CRITICAL_BELOW_PCT = 10
export const SWAP_FULL_RATIO = 0.95
/** How long one probe may run. */
export const PROBE_TIMEOUT_MS = 10_000
/** A process table this old still describes the machine; one is taken at most this often. */
export const TOP_FRESH_MS = 5 * 60_000
export const TOP_GAP_MS = 60_000

const GIB = 1024 ** 3
const round1 = (value: number): number => Math.round(value * 10) / 10
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * `sysctl -n hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`: one line each, told apart by their
 * shape (the memory size has ten digits or more, the level one or two, the swap line its `total = `).
 */
export const parseSysctl = (output: string): { level: number | null; totalGB: number | null; swapUsedGB: number; swapTotalGB: number } => {
  let level: number | null = null
  let totalGB: number | null = null
  let swap = ''
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (/^\d{10,}$/.test(line)) {
      totalGB = round1(Number(line) / GIB)
    } else if (/^\d{1,2}$/.test(line)) {
      level = Number(line)
    } else if (line.includes('total = ')) {
      swap = line
    }
  }
  const megabytes = (name: string) => Number(swap.match(new RegExp(`${name} = ([\\d.]+)M`))?.[1] ?? 0)
  return { level, totalGB, swapUsedGB: round1(megabytes('used') / 1024), swapTotalGB: round1(megabytes('total') / 1024) }
}

export type VmStat = { pageSize: number; free: number; inactive: number; speculative: number; compressorPages: number; compressedPages: number }

/** `vm_stat`: the page size from its header, and the page counts that matter. */
export const parseVmStat = (output: string): VmStat | null => {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1] ?? 0)
  if (pageSize <= 0) {
    return null
  }
  const pages = (name: string) => Number(output.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm'))?.[1] ?? 0)
  return {
    pageSize,
    free: pages('Pages free'),
    inactive: pages('Pages inactive'),
    speculative: pages('Pages speculative'),
    compressorPages: pages('Pages occupied by compressor'),
    compressedPages: pages('Pages stored in compressor'),
  }
}

/**
 * What a new job can take without pushing anyone out (free + inactive + speculative pages), as a share of the
 * memory and in GB, and the compressor: what it occupies and how much it stands for.
 */
export const memoryOf = (
  vm: VmStat | null,
  totalGB: number | null,
): { freePct: number | null; unusedGB: number | null; compressorGB: number | null; compressedGB: number | null } => {
  if (!vm) {
    return { freePct: null, unusedGB: null, compressorGB: null, compressedGB: null }
  }
  const unused = (vm.free + vm.inactive + vm.speculative) * vm.pageSize
  return {
    freePct: totalGB === null || totalGB <= 0 ? null : Math.round((unused / (totalGB * GIB)) * 100),
    unusedGB: round1(unused / GIB),
    compressorGB: round1((vm.compressorPages * vm.pageSize) / GIB),
    compressedGB: round1((vm.compressedPages * vm.pageSize) / GIB),
  }
}

/** `ioreg -r -d 1 -w 0 -c IOAccelerator`: the GPU's "Device Utilization %". */
export const parseGpu = (output: string): number | null => {
  const found = output.match(/"Device Utilization %"\s*=\s*(\d+)/)
  return found ? Number(found[1]) : null
}

const appName = (command: string): string => {
  const bundle = command.match(/\/([^/]+)\.app\//)
  if (bundle?.[1]) {
    return bundle[1]
  }
  const base = command.trim().split('/').pop() ?? command
  return base.replace(/^(python)\d[\d.]*$/, '$1')
}

/** `ps -axo rss=,comm=`: memory summed per app (an app's helpers count as the app), biggest first. */
export const parseTopApps = (output: string, count = 3): AppMemory[] => {
  const totals = new Map<string, number>()
  for (const line of output.split('\n')) {
    const found = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!found) {
      continue
    }
    const name = appName(found[2] ?? '')
    totals.set(name, (totals.get(name) ?? 0) + Number(found[1]))
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, kilobytes]) => ({ name, gb: Math.round((kilobytes / 1024 / 1024) * 10) / 10 }))
}

/**
 * macOS's level (1 normal, 2 warn, 4 critical), raised one step when unused memory and
 * swap say worse than the kernel's level does.
 */
export const pressureOf = (level: number | null, freePct: number | null, swapUsedGB: number, swapTotalGB: number): Pressure => {
  const isSwapFull = swapTotalGB > 0 && swapUsedGB / swapTotalGB >= SWAP_FULL_RATIO
  if (level === 4 || (freePct !== null && freePct < CRITICAL_BELOW_PCT && isSwapFull)) {
    return 'critical'
  }
  if (level === 2 || (freePct !== null && freePct < TIGHT_BELOW_PCT)) {
    return 'warn'
  }
  return 'normal'
}

const isAppMemory = (value: unknown): value is AppMemory =>
  typeof value === 'object' && value !== null && typeof (value as AppMemory).name === 'string' && typeof (value as AppMemory).gb === 'number'

/** The shared sample as its file holds it, fields an older build left out filled in; null when absent or malformed. */
export const parseShared = (text: string | null): SharedSample | null => {
  if (!text) {
    return null
  }
  try {
    const value = JSON.parse(text) as Partial<SharedSample>
    const data = value.data as Partial<Snapshot> | undefined
    if (typeof value.ts !== 'number' || typeof value.ttlMs !== 'number' || !data || typeof data.at !== 'number') {
      return null
    }
    return {
      ts: value.ts,
      by: String(value.by ?? ''),
      ttlMs: value.ttlMs,
      probeMs: Number(value.probeMs ?? 0),
      n: Number(value.n ?? 0),
      data: {
        at: data.at,
        pressure: data.pressure === 'warn' || data.pressure === 'critical' ? data.pressure : 'normal',
        level: numberOrNull(data.level),
        freePct: numberOrNull(data.freePct),
        unusedGB: numberOrNull(data.unusedGB),
        totalGB: numberOrNull(data.totalGB),
        compressorGB: numberOrNull(data.compressorGB),
        compressedGB: numberOrNull(data.compressedGB),
        swapUsedGB: Number(data.swapUsedGB ?? 0),
        swapTotalGB: Number(data.swapTotalGB ?? 0),
        gpuPct: numberOrNull(data.gpuPct),
        gpuAt: numberOrNull(data.gpuAt),
        top: Array.isArray(data.top) ? data.top.filter(isAppMemory) : [],
        topAt: numberOrNull(data.topAt),
        topTriedAt: numberOrNull(data.topTriedAt),
      },
    }
  } catch {
    return null
  }
}

/** The lock as its file holds it; null when absent or malformed. */
export const parseLock = (text: string | null): SampleLock | null => {
  if (!text) {
    return null
  }
  try {
    const value = JSON.parse(text) as Partial<SampleLock>
    return typeof value.ts === 'number' ? { ts: value.ts, by: String(value.by ?? '') } : null
  } catch {
    return null
  }
}

const LAUNCHERS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|nohup\s+|nice\s+(?:-n\s*\d+\s+)?|caffeinate\s+(?:-\S+\s+)*|time\s+|exec\s+)*/
const REMOTE = /^(?:modal\s+(?:run|deploy|serve|shell)|ssh|gh|git|curl|scp|rsync)\b/
/** Tools that only read, edit or move text and files: a script name in their arguments is not a launch. */
const TEXT_TOOLS =
  /^(?:sed|rg|grep|egrep|awk|cat|head|tail|less|echo|printf|ls|find|fd|jq|wc|sort|cut|tr|diff|cp|mv|rm|mkdir|touch|chmod|ln|tee|git|gh|claude|open|which|file|stat|du|df|ps|pgrep|kill|pkill|sleep|test|\[)\b/
const NOT_HEAVY = /\b(?:pytest|ruff|mypy|black|flake8|pip3?\s+(?:install|download|show|list)|--help|--version)\b/
const HEAVY: readonly RegExp[] = [
  /\b(?:python[\d.]*|uv\s+run|poetry\s+run|conda\s+run)\b.*\b(?:train|finetune|fine_tune|fit|infer|inference|predict|generate|render|bake|reconstruct|extract|eval|evaluate|benchmark|bench|dedup|mesh_build|build_\w*data)/i,
  /\b\w*(?:train|render|bake|infer)\w*\.(?:py|sh)\b/i,
  /\b(?:torchrun|deepspeed|accelerate\s+launch)\b/,
  /(?:^|\/|\s)blender(?:\s|$)|Blender\.app/i,
  /\bdocker\s+(?:run|build|compose\s+up)\b/,
  /\bffmpeg\b/,
  /\b(?:ollama\s+(?:run|serve)|llama-server|llama-cli|mlx_lm\.\w+)\b/,
]

/**
 * The command with what is only data taken out: heredoc bodies and single-quoted text dropped,
 * double-quoted text kept but never split on its `|`, `;` or `&`.
 */
const withoutLiterals = (command: string): string => {
  const noHeredocs = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ')
  let out = ''
  let quote: string | null = null
  for (const ch of noHeredocs) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"') {
        out += /[|;&\n]/.test(ch) ? ' ' : ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** Whether a Bash command starts something heavy on this Mac (not remotely, not a test run). */
export const isHeavy = (command: string, extra: RegExp | null = null): boolean =>
  withoutLiterals(command)
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map(segment => segment.trim().replace(/^cd\s+\S+$/, ''))
    .filter(Boolean)
    .some(segment => {
      const body = segment.replace(LAUNCHERS, '')
      if (REMOTE.test(body) || TEXT_TOOLS.test(body) || NOT_HEAVY.test(body)) {
        return false
      }
      return HEAVY.some(pattern => pattern.test(body)) || (extra?.test(body) ?? false)
    })

/** `30m`, `2h`, `1.5h`, `1d` in milliseconds; null for anything else. */
export const parseDuration = (text: string): number | null => {
  const found = text.match(/^(\d+(?:\.\d+)?)(m|h|d)$/)
  if (!found) {
    return null
  }
  const unit = found[2] === 'm' ? 60_000 : found[2] === 'h' ? 3_600_000 : 86_400_000
  return Math.round(Number(found[1]) * unit)
}

export const formatLeft = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 90 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** "just now", "12 s ago", "5m ago". */
export const agoText = (ms: number): string => (ms < 1000 ? 'just now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${formatLeft(ms)} ago`)

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`

/** A reservation read from its file, or null when there is none, it is malformed, or it ran out. */
export const parseReservation = (text: string | null, now: number): Reservation | null => {
  if (!text) {
    return null
  }
  try {
    const value = JSON.parse(text) as Partial<Reservation>
    return typeof value.until === 'number' && value.until > now
      ? { reason: String(value.reason ?? 'busy'), until: value.until, setAt: Number(value.setAt ?? now) }
      : null
  } catch {
    return null
  }
}

export const biggestApps = (snapshot: Snapshot): string => snapshot.top.map(app => `${app.name} ${app.gb} GB`).join(', ')

/** Whether the snapshot's process table is recent enough to name the biggest apps. */
export const hasFreshTop = (snapshot: Snapshot, now: number): boolean =>
  snapshot.topAt !== null && snapshot.top.length > 0 && now - snapshot.topAt <= TOP_FRESH_MS

/** Why there is no process table to show, and how to get one. */
export const noTableText = (snapshot: Snapshot, now: number): string =>
  snapshot.topTriedAt !== null && now - snapshot.topTriedAt < TOP_GAP_MS
    ? `no process table — ps did not answer within ${seconds(PROBE_TIMEOUT_MS)} (tried ${agoText(now - snapshot.topTriedAt)}; the Mac is that loaded). ` +
      'machine_status and /guard try again at most once a minute, or run `ps -axo rss=,comm= | sort -rn | head -5` yourself.'
    : 'no process table from the last 5 min; machine_status or /guard takes one (ps, at most once a minute).'

/** The status line: memory first, GPU, and the reservation or pause when there is one. */
export const statusLine = (snapshot: Snapshot | null, reservation: Reservation | null, pausedLeftMs: number): string => {
  const parts: string[] = []
  if (snapshot) {
    const free = snapshot.freePct === null ? '' : `${snapshot.freePct}% free`
    const swap = snapshot.swapTotalGB > 0 ? `swap ${snapshot.swapUsedGB}/${snapshot.swapTotalGB}G` : ''
    const head =
      snapshot.pressure === 'critical' ? 'RAM CRITICAL' : snapshot.pressure === 'warn' ? 'RAM tight' : 'RAM'
    parts.push([head, free].filter(Boolean).join(' '))
    if (swap) {
      parts.push(swap)
    }
    if (snapshot.pressure !== 'normal' && snapshot.top[0]) {
      parts.push(`top ${snapshot.top[0].name} ${snapshot.top[0].gb}G`)
    }
    if (snapshot.gpuPct !== null) {
      parts.push(`GPU ${snapshot.gpuPct}%`)
    }
  }
  if (reservation) {
    parts.push(`reserved ${formatLeft(reservation.until - (snapshot?.at ?? reservation.setAt))}: ${reservation.reason}`)
  }
  if (pausedLeftMs > 0) {
    parts.push(`guard paused ${formatLeft(pausedLeftMs)}`)
  }
  return parts.join(' · ')
}

export type Cadence = { sampleMs: number; intervalMs: number; blockOnCritical: boolean }

const RULES =
  `Rules: blocked when memory is critical (kernel level 4, or under ${CRITICAL_BELOW_PCT}% free with swap ${Math.round(SWAP_FULL_RATIO * 100)}% full) or while /busy reserves the Mac; ` +
  `when memory is tight (under ${TIGHT_BELOW_PCT}% free, or kernel level 2) the job runs with a note to run one at a time.`

/** The guard's verdict, in the order the Bash hook decides: a pause first, then the reservation, then memory. */
const verdict = (snapshot: Snapshot | null, reservation: Reservation | null, pausedLeftMs: number, now: number, cadence: Cadence): string => {
  if (pausedLeftMs > 0) {
    return `Verdict: ok — the guard is paused for ${formatLeft(pausedLeftMs)} in this session: heavy jobs run even while memory is critical.`
  }
  if (reservation) {
    return `Verdict: busy — the Mac is reserved for "${reservation.reason}" for ${formatLeft(reservation.until - now)} more: heavy local jobs are blocked (/busy off lifts it).`
  }
  if (snapshot?.pressure === 'critical') {
    return cadence.blockOnCritical
      ? 'Verdict: busy — memory is critical: heavy local jobs are blocked (the user can lift this with /guard pause 15m).'
      : 'Verdict: ok — memory is critical but blocking is off: start nothing heavy unless the user asks for it.'
  }
  if (snapshot?.pressure === 'warn') {
    return 'Verdict: ok — memory is tight: run one heavy job at a time.'
  }
  return 'Verdict: ok — heavy local jobs may start.'
}

/** What the machine_status tool tells the model: the sample and its age, the figures, the biggest apps, the verdict and the rules. */
export const statusReport = (snapshot: Snapshot | null, reservation: Reservation | null, pausedLeftMs: number, now: number, cadence: Cadence): string => {
  if (!snapshot) {
    return ['machine-guard · no sample yet: the Mac’s memory counters could not be read.', verdict(null, reservation, pausedLeftMs, now, cadence)].join('\n')
  }
  const pace = `every ${seconds(cadence.intervalMs)}${cadence.intervalMs > cadence.sampleMs ? ' (backed off: probes were slow)' : ''}`
  const ram =
    snapshot.unusedGB === null
      ? `RAM: free memory unknown (vm_stat did not answer)${snapshot.totalGB === null ? '' : ` · ${snapshot.totalGB} GB in all`}`
      : `RAM: ${snapshot.freePct ?? '?'}% free · ${snapshot.unusedGB} of ${snapshot.totalGB ?? '?'} GB unused (free + inactive + speculative pages)` +
        ` · compressor holds ${snapshot.compressedGB} GB in ${snapshot.compressorGB} GB`
  const gpu =
    snapshot.gpuPct === null
      ? 'GPU: n/a'
      : `GPU: ${snapshot.gpuPct}%${snapshot.gpuAt !== null && now - snapshot.gpuAt >= 1000 ? ` (read ${agoText(now - snapshot.gpuAt)})` : ''}`
  const top = hasFreshTop(snapshot, now)
    ? `Biggest apps (ps ${agoText(now - (snapshot.topAt ?? now))}): ${biggestApps(snapshot)}`
    : `Biggest apps: ${noTableText(snapshot, now)}`
  return [
    `machine-guard · sampled ${agoText(now - snapshot.at)} · ${pace}, one sample shared by all sessions`,
    ram,
    `Swap: ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB used`,
    gpu,
    `Pressure: ${snapshot.pressure} (kernel level ${snapshot.level ?? 'unknown'})`,
    top,
    verdict(snapshot, reservation, pausedLeftMs, now, cadence),
    RULES,
  ].join('\n')
}

const quoted = (command: string): string => {
  const line = command.replace(/\s+/g, ' ').trim()
  return `\`${line.length > 120 ? `${line.slice(0, 119)}…` : line}\``
}

/** "6% free, swap 7.9 of 8 GB; biggest: python 31 GB": the biggest apps only when a table was taken. */
const figures = (snapshot: Snapshot): string =>
  `${snapshot.freePct ?? '?'}% free, swap ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB${snapshot.top.length > 0 ? `; biggest: ${biggestApps(snapshot)}` : ''}`

export const criticalDenial = (snapshot: Snapshot, command: string): string =>
  `machine-guard: memory pressure is critical on this Mac (${figures(snapshot)}), so this heavy job was not started: ${quoted(command)}. ` +
  'Wait for a running job to finish or free memory and retry, run it remotely (e.g. Modal), or ask the user, who can override with /guard pause 15m.'

export const reservationDenial = (reservation: Reservation, command: string, now: number): string =>
  `machine-guard: the user has reserved this Mac for "${reservation.reason}" for ${formatLeft(reservation.until - now)} more, so heavy local jobs are blocked: ${quoted(command)}. ` +
  'Do other work meanwhile, run it remotely (e.g. Modal), or ask the user, who can lift the reservation with /busy off.'

export const warnContext = (snapshot: Snapshot): string =>
  `machine-guard: memory is tight on this Mac (${figures(snapshot)}). Avoid starting more heavy jobs in parallel; prefer running one at a time.`
