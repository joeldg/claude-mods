import type { AppMemory, Pressure, Reservation, Snapshot } from '../types'

/** `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage`: the level, then the swap line. */
export const parseSysctl = (output: string): { level: number | null; swapUsedGB: number; swapTotalGB: number } => {
  const [levelLine = '', ...rest] = output.trim().split('\n')
  const swap = rest.join(' ')
  const megabytes = (name: string) => Number(swap.match(new RegExp(`${name} = ([\\d.]+)M`))?.[1] ?? 0)
  const level = /^\d+$/.test(levelLine.trim()) ? Number(levelLine.trim()) : null
  return {
    level,
    swapUsedGB: Math.round((megabytes('used') / 1024) * 10) / 10,
    swapTotalGB: Math.round((megabytes('total') / 1024) * 10) / 10,
  }
}

/** `memory_pressure -Q`: "System-wide memory free percentage: 37%". */
export const parseFreePct = (output: string): number | null => {
  const found = output.match(/free percentage:\s*(\d+)%/)
  return found ? Number(found[1]) : null
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
 * macOS's level (1 normal, 2 warn, 4 critical), raised one step when free memory and
 * swap say worse than the kernel's level does.
 */
export const pressureOf = (level: number | null, freePct: number | null, swapUsedGB: number, swapTotalGB: number): Pressure => {
  const isSwapFull = swapTotalGB > 0 && swapUsedGB / swapTotalGB >= 0.95
  if (level === 4 || (freePct !== null && freePct < 10 && isSwapFull)) {
    return 'critical'
  }
  if (level === 2 || (freePct !== null && freePct < 20)) {
    return 'warn'
  }
  return 'normal'
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

const biggest = (snapshot: Snapshot): string =>
  snapshot.top.map(app => `${app.name} ${app.gb} GB`).join(', ')

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

const quoted = (command: string): string => {
  const line = command.replace(/\s+/g, ' ').trim()
  return `\`${line.length > 120 ? `${line.slice(0, 119)}…` : line}\``
}

export const criticalDenial = (snapshot: Snapshot, command: string): string =>
  `machine-guard: memory pressure is critical on this Mac (${snapshot.freePct ?? '?'}% free, swap ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB; biggest: ${biggest(snapshot)}), so this heavy job was not started: ${quoted(command)}. ` +
  'Wait for a running job to finish or free memory and retry, run it remotely (e.g. Modal), or ask the user, who can override with /guard pause 15m.'

export const reservationDenial = (reservation: Reservation, command: string, now: number): string =>
  `machine-guard: the user has reserved this Mac for "${reservation.reason}" for ${formatLeft(reservation.until - now)} more, so heavy local jobs are blocked: ${quoted(command)}. ` +
  'Do other work meanwhile, run it remotely (e.g. Modal), or ask the user, who can lift the reservation with /busy off.'

export const warnContext = (snapshot: Snapshot): string =>
  `machine-guard: memory is tight on this Mac (${snapshot.freePct ?? '?'}% free, swap ${snapshot.swapUsedGB} of ${snapshot.swapTotalGB} GB; biggest: ${biggest(snapshot)}). Avoid starting more heavy jobs in parallel; prefer running one at a time.`
