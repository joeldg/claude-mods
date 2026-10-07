import type { ModalApp, ModalAppKind, ModalMeter, ModalTracked } from '../types'

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** The command candidates to try, in order: the option split into argv, else `modal` then `python3 -m modal`. */
export const cliCandidates = (option: string): string[][] => {
  const own = splitCommand(option)
  return own.length > 0 ? [own] : [['modal'], ['python3', '-m', 'modal']]
}

/** Splits a command line on spaces, keeping "quoted words" whole. */
export const splitCommand = (text: string): string[] =>
  text.match(/"[^"]*"|'[^']*'|\S+/g)?.map(word => word.replace(/^(["'])(.*)\1$/, '$2')) ?? []

/** A Modal CLI JSON key in one spelling: `App ID` (CLI before 1.5) and `app_id` (1.5 on) both read `app_id`. */
export const jsonKey = (key: string): string =>
  key
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')

/** The first JSON array in `text`, ANSI styling stripped (rich adds it when FORCE_COLOR is set); null when there is none. */
const jsonArray = (text: string): unknown[] | null => {
  const plain = text.replace(ANSI, '')
  const start = plain.indexOf('[')
  const end = plain.lastIndexOf(']')
  if (start < 0 || end < start) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(plain.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const normalized = (row: unknown): Record<string, unknown> | null => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return null
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[jsonKey(key)] = value
  }
  return out
}

const pick = (row: Record<string, unknown>, keys: readonly string[]): unknown =>
  keys.map(key => row[key]).find(value => value !== undefined && value !== null && value !== '')

/**
 * A Modal timestamp in epoch ms: `2026-10-07 07:50:00-07:00` (the CLI's JSON), any ISO
 * string, or epoch seconds or ms. Null when absent or unreadable.
 */
export const parseTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseTimestamp(Number(text))
  }
  const ms = Date.parse(text.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
  return Number.isFinite(ms) ? ms : null
}

/** Modal's state label in one short word: `ephemeral (detached)` → `detached`, `initializing...` → `initializing`. */
export const normalizeState = (value: unknown): string => {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/\.+$|…$/g, '')
    .trim()
  if (!text) {
    return 'unknown'
  }
  return /detached/.test(text) ? 'detached' : text
}

const count = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * The apps in `modal app list --json`, whatever the CLI's key spelling (`App ID`,
 * `Description`, `State`, `Tasks`, `Created at`, `Stopped at`; snake_case from 1.5 on).
 * Rows with no id are dropped. Null when the text holds no JSON array.
 */
export const parseAppList = (text: string): ModalApp[] | null => {
  const rows = jsonArray(text)
  if (rows === null) {
    return null
  }
  const apps: ModalApp[] = []
  for (const raw of rows) {
    const row = normalized(raw)
    if (!row) {
      continue
    }
    const id = pick(row, ['app_id', 'id', 'appid'])
    if (typeof id !== 'string' || !id.trim()) {
      continue
    }
    const name = pick(row, ['description', 'name', 'app_name'])
    apps.push({
      id: id.trim(),
      name: typeof name === 'string' && name.trim() ? name.trim() : id.trim(),
      state: normalizeState(pick(row, ['state', 'status'])),
      containers: count(pick(row, ['tasks', 'n_running_tasks', 'running_tasks', 'containers'])),
      createdAt: parseTimestamp(pick(row, ['created_at', 'created'])),
      stoppedAt: parseTimestamp(pick(row, ['stopped_at', 'stopped'])),
    })
  }
  return apps
}

/** States a `modal run` is in while its local process lives: worth counting even before containers start. */
const LIVE_STATES = new Set(['ephemeral', 'detached', 'initializing', 'running'])
const GONE_STATES = new Set(['stopped', 'disabled'])

export const kindOf = (app: ModalApp): ModalAppKind => {
  if (app.containers > 0) {
    return 'running'
  }
  if (GONE_STATES.has(app.state) || app.state === 'stopping' || app.stoppedAt !== null) {
    return 'stopped'
  }
  return LIVE_STATES.has(app.state) ? 'running' : 'idle'
}

/** The apps worth a row: everything not stopped, running ones first, most containers first, then by name. */
export const activeApps = (apps: readonly ModalApp[]): ModalApp[] =>
  apps
    .filter(app => kindOf(app) !== 'stopped')
    .sort(
      (a, b) =>
        Number(kindOf(b) === 'running') - Number(kindOf(a) === 'running') ||
        b.containers - a.containers ||
        a.name.localeCompare(b.name),
    )

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const containersText = (n: number): string => plural(n, 'container')

/** `Modal: 1 running (2 containers) · 1 deployed`; undefined when nothing is active. */
/**
 * `Modal: 1 running (2 containers) · 1 deployed`; with `includeIdle` false (the status line),
 * deployed apps with no containers are left out, since they cost nothing.
 */
export const statusText = (apps: readonly ModalApp[], includeIdle = true): string | undefined => {
  const active = activeApps(apps)
  const running = active.filter(app => kindOf(app) === 'running')
  const idle = active.length - running.length
  const containers = running.reduce((sum, app) => sum + app.containers, 0)
  const parts: string[] = []
  if (running.length > 0) {
    parts.push(`${running.length} running${containers > 0 ? ` (${containersText(containers)})` : ''}`)
  }
  if (idle > 0 && (includeIdle || running.length > 0)) {
    parts.push(`${idle} deployed`)
  }
  return parts.length > 0 ? `Modal: ${parts.join(' · ')}` : undefined
}

/**
 * Since when an app with containers counts as up: a `modal run` app from its creation;
 * a deployed app from when the meter first saw it with containers (its creation is the
 * deploy, which can be weeks old).
 */
const busyStart = (app: ModalApp, now: number): number =>
  LIVE_STATES.has(app.state) && app.createdAt !== null && app.createdAt <= now ? app.createdAt : now

/**
 * The tracking carried to this poll: every listed app that is not stopped keeps its
 * last alert time; `busySince` starts when containers appear and clears when they go.
 */
export const trackApps = (
  previous: Readonly<Record<string, ModalTracked>>,
  apps: readonly ModalApp[],
  now: number,
): Record<string, ModalTracked> => {
  const next: Record<string, ModalTracked> = {}
  for (const app of apps) {
    if (kindOf(app) === 'stopped') {
      continue
    }
    const before = previous[app.id]
    next[app.id] = {
      busySince: app.containers > 0 ? (before?.busySince ?? busyStart(app, now)) : null,
      alertedAt: before?.alertedAt ?? null,
    }
  }
  return next
}

/**
 * The apps due a long-running toast: containers up for longer than `alertMs`, and no
 * toast for them in the last `alertMs`.
 */
export const dueAlerts = (
  apps: readonly ModalApp[],
  tracked: Readonly<Record<string, ModalTracked>>,
  now: number,
  alertMs: number,
): ModalApp[] =>
  apps.filter(app => {
    const one = tracked[app.id]
    if (!one || one.busySince === null || app.containers === 0) {
      return false
    }
    return now - one.busySince > alertMs && (one.alertedAt === null || now - one.alertedAt >= alertMs)
  })

/** `45s`, `45m`, `2h 5m`, `3d 4h`. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  }
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

export const alertText = (app: ModalApp, upMs: number): string =>
  `Modal app ${app.name} has run ${formatDuration(upMs)} with ${containersText(app.containers)} — /modal to stop it`

/** How long an app has been up: since its containers started, else since it was created. */
export const upFor = (app: ModalApp, tracked: ModalTracked | undefined, now: number): number | null => {
  const since = tracked?.busySince ?? app.createdAt
  return since === null ? null : Math.max(0, now - since)
}

/** `image-worker · ephemeral · 2 containers · up 45m`. */
export const rowText = (app: ModalApp, tracked: ModalTracked | undefined, now: number): string => {
  const up = upFor(app, tracked, now)
  return [app.name, app.state, containersText(app.containers), up === null ? null : `up ${formatDuration(up)}`]
    .filter(Boolean)
    .join(' · ')
}

/** `$1.23`. */
export const usd = (amount: number): string => `$${amount.toFixed(2)}`

/**
 * Today's spend from `modal billing report --for today --json`: the sum of its rows'
 * `cost` (a decimal string). Null when the text holds no JSON array.
 */
export const parseSpend = (text: string): number | null => {
  const rows = jsonArray(text)
  if (rows === null) {
    return null
  }
  let total = 0
  for (const raw of rows) {
    const row = normalized(raw)
    const cost = row ? Number(pick(row, ['cost', 'total_cost', 'amount'])) : Number.NaN
    if (Number.isFinite(cost)) {
      total += cost
    }
  }
  return Math.round(total * 1e6) / 1e6
}

/** The CLI said it has no `billing` command (Modal before 1.3.3). */
export const lacksBilling = (output: string): boolean => /no such command\W+billing/i.test(output)

/** The CLI could not authenticate: no profile or token set up on this machine. */
export const isAuthProblem = (output: string): boolean =>
  /token|authenticat|credential|not logged in|modal setup|no modal profile|profile.*not found/i.test(output)

/** A Modal that runs at all but has no `modal` package behind `python3 -m modal`. */
export const isMissingModule = (output: string): boolean => /no module named '?modal/i.test(output)

/** `modal app stop` refused to run without a terminal and asked for `--yes` (Modal 1.4.2 on). */
export const wantsYes = (output: string): boolean => /--yes\b/.test(output)

/** The first line worth showing from a failed command's output. */
export const firstLine = (output: string): string =>
  output
    .replace(ANSI, '')
    .split('\n')
    .map(line => line.replace(/^[\s│╭╰─┃|]+|[\s│╮╯─┃|]+$/g, '').trim())
    .find(line => line && !/^(error|usage:.*|try '.*)$/i.test(line))
    ?.slice(0, 160) ?? 'no output'

/** The UTC day of `ms`, `2026-10-07`: the day Modal's `--for today` reports. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The meter's state in words: what `/modal` answers. */
export const summaryText = (
  meter: ModalMeter,
  tracked: Readonly<Record<string, ModalTracked>>,
  now: number,
  budget: number,
): string => {
  if (meter.problem !== null) {
    return `modal-meter is silent: ${meter.problem}.`
  }
  if (meter.polledAt === null) {
    return 'modal-meter has not read Modal yet.'
  }
  const apps = activeApps(meter.apps)
  const lines = [`${statusText(meter.apps) ?? 'Modal: nothing running or deployed'} (read with \`${meter.cli ?? 'modal'}\`)`]
  for (const app of apps) {
    lines.push(`  ${rowText(app, tracked[app.id], now)}${kindOf(app) === 'idle' ? ' (idle)' : ''}`)
  }
  lines.push(
    meter.spendToday !== null
      ? `Spend today (UTC): ${usd(meter.spendToday)}${budget > 0 ? ` of a ${usd(budget)} daily budget` : ''}`
      : `Spend: not shown (${meter.spendNote ?? 'not read yet'})`,
  )
  return lines.join('\n')
}
