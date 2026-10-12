import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { CachedListener, Holder, KnownEntry, Listener, ProcessDetail, ScanCache, ScanLock, Server, Snapshot } from '../types'
import {
  describe,
  detectManager,
  expandHome,
  findConflict,
  holderNote,
  isFresh,
  isInside,
  isSystemProgram,
  knownEntries,
  lastLines,
  LOCKFILES,
  logPath,
  matchServers,
  MAX_POLL_MS,
  mayScan,
  nextPollMs,
  packageScripts,
  parseCwds,
  parseListeners,
  parseNetstat,
  parseProcesses,
  parseScanCache,
  parseScanLock,
  parseSs,
  portFromCommand,
  portList,
  programOf,
  serverLine,
  SLOW_MS,
  startScript,
  statusLine,
  toolText,
  upSince,
} from './servers'

type Engine = EngineInterface

const PANE = 'dev-servers'
const TITLE = 'Servers'
/** The read-only tool the model gets, listed as `mcp__dev-servers__dev_servers`. */
const TOOL = 'dev_servers'
/** How often a wait (a stop, a free port, a start) looks again. */
const STEP_MS = 500
/** How long a start waits for its port before saying it is not up. */
const START_WAIT_MS = 10_000
/** How long a restart waits for the stopped server's ports to be free. */
const FREE_WAIT_MS = 10_000
/** How long after Stop a second press force stops (SIGKILL). */
const FORCE_WINDOW_MS = 10_000
/** How long a force stop waits for the process to go. */
const KILL_WAIT_MS = 2_000
/** Pane widths below this draw a row's buttons on a line of their own. */
const STACK_BELOW = 64
/** How long the listen scan (netstat, ss or lsof) may take. */
const SCAN_TIMEOUT_MS = 10_000
/** How long one pid's ps or lsof may take. */
const DETAIL_TIMEOUT_MS = 3_000
/** How long one scan spends on pids it has not seen; the rest wait for the next scan. */
const DETAIL_BUDGET_MS = 6_000
/** A lock older than this was left by a scan that never finished. */
const LOCK_STALE_MS = SCAN_TIMEOUT_MS + DETAIL_BUDGET_MS + DETAIL_TIMEOUT_MS
/** A cache this much younger than the poll interval still stands at a session's next tick. */
const CACHE_SLACK_MS = 2_000
/** A log written this close to a server's start (ps counts whole seconds) is that server's own. */
const LOG_SLACK_MS = 5_000
/** Where every session's scan meets, beside the logs: the cache and the lock. */
const SHARED_DIR = '~/.claude/dev-servers'
const CACHE_FILE = 'scan-cache.json'
const LOCK_FILE = 'scan-lock.json'
/** The commands that list listening TCP ports, tried in order; the first whose table parses is kept for the session. */
const SCANNERS: readonly { argv: readonly string[]; parse: (text: string) => Listener[] | null }[] = [
  { argv: ['netstat', '-anv', '-p', 'tcp'], parse: parseNetstat },
  { argv: ['ss', '-ltnp'], parse: parseSs },
  { argv: ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], parse: parseListeners },
]

const TOOL_DESCRIPTION = [
  "Lists this project's dev servers: which are running (name, port, pid, uptime, and the log file when it was started from the Servers pane) and which known start commands (package.json scripts, .claude/launch.json, Procfile) are not running. With all: true it also lists every other TCP listener on this machine, with its port and process.",
  'Use it instead of running lsof, netstat, ss or ps in Bash to learn what is listening on which port, whether a dev server is up, or who holds a port: it answers from a scan every open session shares, where lsof alone can take 10s or more on a loaded machine.',
  'Read-only: it never starts, stops or restarts anything; the person does that with the Start, Stop and Restart buttons of the Servers pane (/servers).',
].join(' ')

/** What the model gets with `$.tool.register`: the tool, in the prompt's list from the start so it is reached for. */
const TOOL_SPEC = {
  name: TOOL,
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      all: {
        type: 'boolean',
        description: 'Also list the listeners outside this project, each with its port and process (to find who holds a port).',
      },
    },
  },
  isDeferred: false,
}

const snapshot = atom({ plugin: 'dev-servers', key: 'snapshot' } as const, null)
const busy = atom({ plugin: 'dev-servers', key: 'busy' } as const, {})
const armed = atom({ plugin: 'dev-servers', key: 'armed' } as const, {})

type Config = { pollMs: number; logDir: string; graceMs: number }

let config: Config = { pollMs: 15_000, logDir: '~/.claude/dev-servers', graceMs: 5_000 }
let timer: { cancel: () => void } | null = null
/** The poll interval now: the configured one, doubled while scans are slow. */
let pollMs = config.pollMs
/** The scan under way, and whether it was asked to look past the shared cache. */
let inflight: { promise: Promise<Snapshot | null>; isForced: boolean } | null = null
/** The status line last shown; null before the first. */
let shownStatus: string | undefined | null = null
let rootFor: { cwd: string; root: string } | null = null
/** Which of SCANNERS lists ports on this machine. */
let scanner = 0
/** What ps and lsof said about each listening pid, kept while it listens and shared through the cache. */
const details = new Map<number, ProcessDetail>()
let sessionId: string | null = null
let warnedWrite = false

/** A host command's result, or null when it could not start or timed out. */
async function run($: Engine, argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult | null> {
  return $.process.run(argv, { timeoutMs: 10_000, ...init }).catch(() => null)
}

/** A host command's result, or why there is none: still running at `timeoutMs`, or it could not start (missing, refused). */
async function attempt($: Engine, argv: readonly string[], timeoutMs: number): Promise<ProcessRunResult | 'timeout' | 'failed'> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (error) {
    return /still running/.test(String(error)) ? 'timeout' : 'failed'
  }
}

/** The git top level of the session's folder, else the folder itself. */
async function projectRoot($: Engine): Promise<string> {
  const cwd = await $.session.cwd()
  if (rootFor?.cwd === cwd) {
    return rootFor.root
  }
  const out = await run($, ['git', 'rev-parse', '--show-toplevel'], { cwd })
  const top = out?.exitCode === 0 ? out.stdout.trim() : ''
  rootFor = { cwd, root: top || cwd }
  return rootFor.root
}

async function readText($: Engine, path: string): Promise<string | null> {
  return $.fs.read(path).catch(() => null)
}

/** package.json server scripts, .claude/launch.json configurations and Procfile lines. */
async function readEntries($: Engine, root: string): Promise<KnownEntry[]> {
  const names = new Set((await $.fs.list(root).catch(() => [])).map(entry => entry.name))
  const [packageJson, launchJson, procfile] = await Promise.all([
    names.has('package.json') ? readText($, `${root}/package.json`) : null,
    names.has('.claude') ? readText($, `${root}/.claude/launch.json`) : null,
    names.has('Procfile') ? readText($, `${root}/Procfile`) : null,
  ])
  const lockfiles = LOCKFILES.map(([file]) => file).filter(file => names.has(file))
  const manager = detectManager(lockfiles, packageJson === null ? undefined : packageScripts(packageJson)?.packageManager)
  return knownEntries({ packageJson, launchJson, procfile, manager })
}

function showStatus($: Engine, servers: readonly Server[]) {
  const text = statusLine(servers)
  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
}

/** `dir` with `~` expanded; a folder under /tmp when there is no home to expand it with. */
async function resolvedDir($: Engine, dir: string): Promise<string> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const expanded = expandHome(dir, home)
  return expanded.startsWith('~') ? '/tmp/dev-servers' : expanded
}

/** `~/.claude/dev-servers/<name>`: a file every session reads and writes. */
async function sharedPath($: Engine, name: string): Promise<string> {
  return `${(await resolvedDir($, SHARED_DIR)).replace(/\/+$/, '')}/${name}`
}

async function whoAmI($: Engine): Promise<string> {
  if (sessionId === null) {
    sessionId = await $.session.id().catch(() => 'unknown')
  }
  return sessionId
}

/** Writes a shared file; a failure is said once, in the debug log, never every tick. */
async function writeShared($: Engine, path: string, value: ScanCache | ScanLock) {
  try {
    await $.fs.write(path, JSON.stringify(value))
  } catch (error) {
    if (!warnedWrite) {
      warnedWrite = true
      $.ui.log(`dev-servers: could not write ${path}: ${String(error)}`, { to: 'debug' })
    }
  }
}

// ---------------------------------------------------------------------------
// The scan: netstat for the ports, ps and lsof once per new pid
// ---------------------------------------------------------------------------

/** The listening pids as the first scanner that works here lists them, and how long it took; null when none answered in time. */
async function scanListeners($: Engine): Promise<{ listeners: Listener[]; tookMs: number } | null> {
  const began = await $.clock.now()
  for (;;) {
    const step = SCANNERS[scanner]
    if (step === undefined) {
      return null
    }
    const out = await attempt($, step.argv, SCAN_TIMEOUT_MS)
    if (out === 'timeout') {
      return null
    }
    const listeners = out === 'failed' ? null : step.parse(out.stdout)
    if (listeners !== null) {
      return { listeners, tookMs: (await $.clock.now()) - began }
    }
    const next = SCANNERS[scanner + 1]
    if (next === undefined) {
      return null
    }
    $.ui.log(`dev-servers: ${step.argv[0]} does not list ports here; trying ${next.argv[0]}`, { to: 'debug' })
    scanner += 1
  }
}

/** The first process listening on `port`, from the listen scan. */
async function listenerOn($: Engine, port: number): Promise<Listener | null> {
  const scanned = await scanListeners($)
  return scanned?.listeners.find(listener => listener.ports.includes(port)) ?? null
}

/**
 * What ps and lsof say about one pid: its command line and start from ps, then its working directory from
 * lsof, unless the program is the system's own or already gone. 'timeout' when either did not answer in time.
 */
async function lookupDetail($: Engine, pid: number): Promise<ProcessDetail | 'timeout'> {
  const ps = await attempt($, ['ps', '-o', 'pid=,etime=,command=', '-p', String(pid)], DETAIL_TIMEOUT_MS)
  if (ps === 'timeout') {
    return 'timeout'
  }
  const row = ps === 'failed' ? undefined : parseProcesses(ps.stdout).get(pid)
  if (row === undefined) {
    return { commandLine: null, startedAt: null, cwd: null }
  }
  const startedAt = row.upSeconds === null ? null : (await $.clock.now()) - row.upSeconds * 1000
  if (isSystemProgram(row.commandLine)) {
    return { commandLine: row.commandLine, startedAt, cwd: null }
  }
  const cwd = await attempt($, ['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], DETAIL_TIMEOUT_MS)
  if (cwd === 'timeout') {
    return 'timeout'
  }
  return { commandLine: row.commandLine, startedAt, cwd: cwd === 'failed' ? null : (parseCwds(cwd.stdout).get(pid) ?? null) }
}

/** One pid's detail: as known, else looked up now and kept; null when the lookup timed out. */
async function detailOf($: Engine, pid: number): Promise<ProcessDetail | null> {
  const known = details.get(pid)
  if (known !== undefined) {
    return known
  }
  const found = await lookupDetail($, pid)
  if (found === 'timeout') {
    return null
  }
  details.set(pid, found)
  return found
}

/** Who holds `port`: its process, how long it has run and in which folder. */
async function holderOf($: Engine, port: number): Promise<Holder | null> {
  const first = await listenerOn($, port)
  if (first === null) {
    return null
  }
  const detail = await detailOf($, first.pid)
  return {
    pid: first.pid,
    command: first.command || programOf(detail?.commandLine ?? '') || `pid ${first.pid}`,
    upSeconds: upSince(detail?.startedAt ?? null, await $.clock.now()),
    cwd: detail?.cwd ?? null,
  }
}

/** Whether none of `ports` is listened on; false as well when the scan did not answer. */
async function portsFree($: Engine, ports: readonly number[]): Promise<boolean> {
  const scanned = await scanListeners($)
  return scanned !== null && ports.every(port => !scanned.listeners.some(listener => listener.ports.includes(port)))
}

/** Doubles the poll interval after a slow scan, to five minutes; the configured one again after a fast one. Says so once per change. */
function pace($: Engine, isSlow: boolean, tookMs: number | null) {
  const next = nextPollMs(pollMs, config.pollMs, isSlow)
  if (next === pollMs) {
    return
  }
  const why = !isSlow ? 'is fast again' : tookMs === null ? 'did not answer in time' : `was slow (${tookMs}ms)`
  $.ui.log(`dev-servers: the port scan ${why}; polling every ${Math.round(next / 1000)}s (at most ${MAX_POLL_MS / 60_000}m)`, {
    to: 'debug',
  })
  pollMs = next
  timer?.cancel()
  timer = $.clock.every(pollMs, () => void refresh($, false))
}

/** Pids on a known entry's port first: the likeliest to be this project's. */
function prioritized(listeners: readonly Listener[], entries: readonly KnownEntry[]): Listener[] {
  const ports = new Set(entries.map(entry => entry.port).filter((port): port is number => port !== null))
  const onKnownPort = (listener: Listener) => listener.ports.some(port => ports.has(port))
  return [...listeners].sort((a, b) => Number(onKnownPort(b)) - Number(onKnownPort(a)))
}

/**
 * Lists the listeners now: the scan, then ps and lsof for each pid not seen before, one pid at a time and
 * within a time budget (the rest wait for the next scan). Paces the poll by how the scan went.
 */
async function scanNow($: Engine, entries: readonly KnownEntry[]): Promise<CachedListener[] | null> {
  const scanned = await scanListeners($)
  if (scanned === null) {
    pace($, true, null)
    return null
  }
  const until = (await $.clock.now()) + DETAIL_BUDGET_MS
  let timedOut = false
  for (const listener of prioritized(scanned.listeners, entries)) {
    if (details.has(listener.pid)) {
      continue
    }
    if ((await $.clock.now()) > until) {
      break
    }
    const found = await lookupDetail($, listener.pid)
    if (found === 'timeout') {
      timedOut = true
      break
    }
    details.set(listener.pid, found)
  }
  const listening = new Set(scanned.listeners.map(listener => listener.pid))
  for (const pid of [...details.keys()]) {
    if (!listening.has(pid)) {
      details.delete(pid)
    }
  }
  pace($, timedOut || scanned.tookMs > SLOW_MS, scanned.tookMs)
  return scanned.listeners.map(listener => ({ ...listener, detail: details.get(listener.pid) ?? null }))
}

/** Takes what another session learned about pids lately as our own: as good as a lookup, and spares one. */
function adoptDetails(cache: ScanCache | null, now: number) {
  if (cache === null || now - cache.ts >= MAX_POLL_MS) {
    return
  }
  for (const listener of cache.data.listeners) {
    if (listener.detail !== null && !details.has(listener.pid)) {
      details.set(listener.pid, listener.detail)
    }
  }
}

/**
 * Every session's view of the listeners: a fresh shared cache as it is; else, unless another session is
 * scanning, a scan of our own, written back for the others. `force` scans whatever the cache says.
 */
async function sharedListeners(
  $: Engine,
  entries: readonly KnownEntry[],
  force: boolean,
): Promise<{ listeners: CachedListener[]; scannedAt: number } | null> {
  const [cachePath, lockPath, me, now] = await Promise.all([
    sharedPath($, CACHE_FILE),
    sharedPath($, LOCK_FILE),
    whoAmI($),
    $.clock.now(),
  ])
  const [cache, lock] = await Promise.all([readText($, cachePath).then(parseScanCache), readText($, lockPath).then(parseScanLock)])
  const cached = cache === null ? null : { listeners: cache.data.listeners, scannedAt: cache.ts }
  adoptDetails(cache, now)
  if (!force) {
    if (cache !== null && isFresh(cache.ts, now, Math.max(1_000, config.pollMs - CACHE_SLACK_MS))) {
      return cached
    }
    if (!mayScan(lock, now, me, LOCK_STALE_MS)) {
      return cached
    }
  }
  await writeShared($, lockPath, { ts: now, by: me })
  const listeners = await scanNow($, entries)
  if (listeners === null) {
    return null
  }
  await writeShared($, cachePath, { ts: now, by: me, data: { listeners } })
  return { listeners, scannedAt: now }
}

/** One scan: every TCP listener (shared across sessions), which of them run inside the project, and the known entries. */
async function collect($: Engine, force: boolean): Promise<Snapshot | null> {
  const root = await projectRoot($)
  const entries = await readEntries($, root)
  const shared = await sharedListeners($, entries, force)
  if (shared === null) {
    return read($, snapshot)
  }
  const now = await $.clock.now()
  const isMine = (listener: CachedListener) =>
    listener.detail !== null && listener.detail.cwd !== null && isInside(listener.detail.cwd, root)
  const mine = shared.listeners.filter(isMine)
  const servers: Server[] = mine.map(listener => {
    const commandLine = listener.detail?.commandLine ?? ''
    return {
      pid: listener.pid,
      name: programOf(commandLine) || listener.command || `pid ${listener.pid}`,
      entryId: null,
      ports: listener.ports,
      cwd: listener.detail?.cwd ?? root,
      upSeconds: upSince(listener.detail?.startedAt ?? null, now),
      commandLine: commandLine || listener.command,
    }
  })
  const matched = matchServers(servers, entries)
  const fresh: Snapshot = {
    root,
    servers: matched.servers,
    entries,
    stopped: matched.stopped,
    others: shared.listeners.length - mine.length,
    otherListeners: shared.listeners.filter(listener => !isMine(listener)),
    scannedAt: shared.scannedAt,
    at: now,
  }
  await update($, snapshot, () => fresh)
  showStatus($, fresh.servers)
  return fresh
}

/**
 * Scans now and draws the result; a scan already under way is shared, not repeated. A forced scan (a press,
 * a command, the tool) looks past the shared cache, and follows one under way that did not.
 */
function refresh($: Engine, force: boolean): Promise<Snapshot | null> {
  if (inflight !== null && (inflight.isForced || !force)) {
    return inflight.promise
  }
  const previous = inflight?.promise ?? Promise.resolve(null)
  const promise: Promise<Snapshot | null> = previous
    .then(() => collect($, force))
    .catch(() => null)
    .finally(() => {
      if (inflight?.promise === promise) {
        inflight = null
      }
    })
  inflight = { promise, isForced: force }
  return promise
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(pollMs, () => void refresh($, false))
  }
}

// ---------------------------------------------------------------------------
// Starting, stopping, logs
// ---------------------------------------------------------------------------

/** Calls `check` every `stepMs` until it answers true (true) or `ms` has passed (false). */
async function waitFor($: Engine, ms: number, stepMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const until = (await $.clock.now()) + ms
  for (;;) {
    if (await check()) {
      return true
    }
    const now = await $.clock.now()
    if (now >= until) {
      return false
    }
    await $.clock.sleep(Math.min(stepMs, until - now))
  }
}

async function setBusy($: Engine, key: string, label: string | null) {
  await update($, busy, all => {
    const next = { ...all }
    if (label === null) {
      delete next[key]
    } else {
      next[key] = label
    }
    return next
  })
}

async function pruneArmed($: Engine) {
  const now = await $.clock.now()
  await update($, armed, all => Object.fromEntries(Object.entries(all).filter(([, until]) => until > now)))
}

/** Opens the force-stop window for `pid`: a Stop pressed before it ends sends SIGKILL. */
async function arm($: Engine, pid: number) {
  const until = (await $.clock.now()) + FORCE_WINDOW_MS
  await update($, armed, all => ({ ...all, [String(pid)]: until }))
  $.clock.after(FORCE_WINDOW_MS, () => void pruneArmed($))
}

async function disarm($: Engine, pid: number) {
  await update($, armed, all => Object.fromEntries(Object.entries(all).filter(([key]) => key !== String(pid))))
}

async function isGone($: Engine, pid: number): Promise<boolean> {
  const out = await run($, ['kill', '-0', String(pid)])
  return out !== null && out.exitCode !== 0
}

/** Sends `signal` to `pid`, and to its process group when it leads one; whether the pid took it. */
async function signal($: Engine, pid: number, name: 'TERM' | 'KILL'): Promise<boolean> {
  const group = await run($, ['ps', '-o', 'pgid=', '-p', String(pid)])
  const leads = group?.exitCode === 0 && Number(group.stdout.trim()) === pid
  const out = await run($, ['kill', `-${name}`, String(pid)])
  if (leads) {
    await run($, ['kill', `-${name}`, '--', `-${pid}`])
  }
  return out?.exitCode === 0
}

/** Whether `pid` still runs the command line the pane drew it with: a pid reused since is never signalled. */
async function pidState($: Engine, server: Server): Promise<'same' | 'gone' | 'other'> {
  const out = await run($, ['ps', '-o', 'pid=,etime=,command=', '-p', String(server.pid)])
  const now = parseProcesses(out?.stdout ?? '').get(server.pid)
  return now === undefined ? 'gone' : now.commandLine === server.commandLine ? 'same' : 'other'
}

/** Whether the pid may be signalled; when it is gone or now runs something else, says so and refreshes. */
async function mayStop($: Engine, server: Server, quiet: boolean): Promise<'same' | 'gone' | 'other'> {
  const state = await pidState($, server)
  if (state === 'other') {
    $.ui.toast(`pid ${server.pid} no longer runs ${server.name}; nothing was signalled`)
  } else if (state === 'gone' && !quiet) {
    $.ui.toast(`${server.name} (pid ${server.pid}) has already stopped`)
  }
  if (state !== 'same') {
    void refresh($, true)
  }
  return state
}

/** SIGTERM, then up to the grace period for it to exit. True once it is gone. */
async function stopServer($: Engine, server: Server, quiet: boolean): Promise<boolean> {
  const key = `pid-${server.pid}`
  const state = await mayStop($, server, quiet)
  if (state !== 'same') {
    return state === 'gone'
  }
  await arm($, server.pid)
  await setBusy($, key, 'stopping')
  try {
    const took = await signal($, server.pid, 'TERM')
    const gone = await waitFor($, config.graceMs, STEP_MS, () => isGone($, server.pid))
    if (gone) {
      // A force stop pressed meanwhile disarmed it and says so itself.
      const stillArmed = (await read($, armed))[String(server.pid)] !== undefined
      await disarm($, server.pid)
      if (stillArmed && !quiet) {
        $.ui.toast(`Stopped ${server.name} (pid ${server.pid})`)
      }
      return true
    }
    if (!took) {
      await disarm($, server.pid)
      $.ui.toast(`Could not signal ${server.name} (pid ${server.pid}): kill was refused`)
      return false
    }
    await arm($, server.pid)
    $.ui.toast(
      `${server.name} (pid ${server.pid}) is still running ${Math.round(config.graceMs / 1000)}s after SIGTERM. Press Stop again within ${FORCE_WINDOW_MS / 1000}s to force stop it.`,
      { timeoutMs: FORCE_WINDOW_MS },
    )
    return false
  } finally {
    await setBusy($, key, null)
    void refresh($, true)
  }
}

/** SIGKILL: only ever from a second Stop press inside the force window. */
async function forceStop($: Engine, server: Server) {
  const key = `pid-${server.pid}`
  await disarm($, server.pid)
  if ((await mayStop($, server, false)) !== 'same') {
    return
  }
  await setBusy($, key, 'force stopping')
  try {
    await signal($, server.pid, 'KILL')
    const gone = await waitFor($, KILL_WAIT_MS, STEP_MS, () => isGone($, server.pid))
    $.ui.toast(
      gone
        ? `Force stopped ${server.name} (pid ${server.pid}) with SIGKILL`
        : `${server.name} (pid ${server.pid}) is still there after SIGKILL`,
    )
  } finally {
    await setBusy($, key, null)
    void refresh($, true)
  }
}

async function pressStop($: Engine, server: Server) {
  const until = (await read($, armed))[String(server.pid)]
  if (until !== undefined && (await $.clock.now()) <= until) {
    await forceStop($, server)
    return
  }
  if ((await read($, busy))[`pid-${server.pid}`] !== undefined) {
    return
  }
  await stopServer($, server, false)
}

async function logFile($: Engine, root: string, entry: KnownEntry): Promise<string> {
  return logPath(await resolvedDir($, config.logDir), root, entry)
}

async function lastLogLine($: Engine, log: string): Promise<string> {
  const out = await run($, ['tail', '-n', '20', log])
  return out?.exitCode === 0 ? (lastLines(out.stdout, 1)[0] ?? '') : ''
}

/** A server matched to `entry` that was not running before, by its port or the next scan. */
async function startedServer(
  $: Engine,
  entry: KnownEntry,
  before: ReadonlySet<number>,
): Promise<{ pid: number; ports: number[] } | null> {
  if (entry.port !== null) {
    const first = await listenerOn($, entry.port)
    return first === null ? null : { pid: first.pid, ports: [entry.port] }
  }
  const fresh = await refresh($, true)
  const server = fresh?.servers.find(one => one.entryId === entry.id && !before.has(one.pid))
  return server === undefined ? null : { pid: server.pid, ports: server.ports }
}

/** Starts `entry` detached (nohup, output to its log), then waits up to 10s for it to listen. */
async function startEntry($: Engine, entry: KnownEntry, verb: 'Started' | 'Restarted'): Promise<boolean> {
  const key = `entry-${entry.id}`
  await setBusy($, key, 'starting')
  try {
    if (entry.port !== null) {
      const holder = await holderOf($, entry.port)
      if (holder !== null) {
        $.ui.toast(`${entry.name} was not started: ${holderNote(entry.port, holder)}`, { timeoutMs: 10_000 })
        return false
      }
    }
    const root = await projectRoot($)
    const log = await logFile($, root, entry)
    const before = new Set(((await read($, snapshot))?.servers ?? []).map(server => server.pid))
    const out = await run($, ['sh', '-c', startScript(root, entry.command, log)], { cwd: root })
    if (out === null || out.exitCode !== 0) {
      const reason = out?.stderr.trim().split('\n').pop() || 'sh did not run'
      $.ui.toast(`Could not start ${entry.name}: ${reason}`)
      return false
    }
    const seen: { server: { pid: number; ports: number[] } | null } = { server: null }
    await waitFor($, START_WAIT_MS, entry.port === null ? 1000 : STEP_MS, async () => {
      seen.server = await startedServer($, entry, before)
      return seen.server !== null
    })
    if (seen.server !== null) {
      $.ui.toast(`${verb} ${entry.name} on ${portList(seen.server.ports)} (pid ${seen.server.pid})`)
      return true
    }
    const last = await lastLogLine($, log)
    const waiting =
      entry.port === null
        ? `${verb} ${entry.name}, but no new port is listening after ${START_WAIT_MS / 1000}s.`
        : `${entry.name} has not opened :${entry.port} after ${START_WAIT_MS / 1000}s.`
    $.ui.toast(last ? `${waiting} Log: ${last}` : `${waiting} Log: ${log}`, { timeoutMs: 10_000 })
    return false
  } finally {
    await setBusy($, key, null)
    void refresh($, true)
  }
}

async function pressStart($: Engine, entry: KnownEntry) {
  if ((await read($, busy))[`entry-${entry.id}`] === undefined) {
    await startEntry($, entry, 'Started')
  }
}

/** Stop, wait until its ports are free, start: never a start while the old one still holds the port. */
async function restartServer($: Engine, server: Server, entry: KnownEntry) {
  const working = await read($, busy)
  if (working[`entry-${entry.id}`] !== undefined || working[`pid-${server.pid}`] !== undefined) {
    return
  }
  const stopped = await stopServer($, server, true)
  if (!stopped) {
    return
  }
  const free = await waitFor($, FREE_WAIT_MS, STEP_MS, () => portsFree($, server.ports))
  if (!free) {
    $.ui.toast(
      `${server.name} stopped, but ${portList(server.ports)} is still in use after ${FREE_WAIT_MS / 1000}s; not restarting`,
      { timeoutMs: 10_000 },
    )
    return
  }
  await startEntry($, entry, 'Restarted')
}

/** Toasts the last three lines of the log a pane start wrote. */
async function showLog($: Engine, entry: KnownEntry) {
  const root = await projectRoot($)
  const log = await logFile($, root, entry)
  const out = await run($, ['tail', '-n', '50', log])
  if (out === null || out.exitCode !== 0) {
    $.ui.toast(`No log for ${entry.name}: only servers started from this pane write one (${log})`, { timeoutMs: 8_000 })
    return
  }
  const lines = lastLines(out.stdout, 3)
  $.ui.toast(lines.length > 0 ? `${entry.name}: ${lines.join(' | ')}` : `${entry.name}: the log is empty`, {
    timeoutMs: 10_000,
  })
}

/** The log of each running server that was started from the pane: its entry's log, written since the server started. */
async function paneLogs($: Engine, fresh: Snapshot): Promise<Map<number, string>> {
  const logs = new Map<number, string>()
  for (const server of fresh.servers) {
    const entry = fresh.entries.find(one => one.id === server.entryId)
    if (entry === undefined) {
      continue
    }
    const log = await logFile($, fresh.root, entry)
    const stat = await $.fs.stat(log).catch(() => null)
    const startedAt = server.upSeconds === null ? null : fresh.at - server.upSeconds * 1000
    if (stat !== null && (startedAt === null || stat.mtimeMs >= startedAt - LOG_SLACK_MS)) {
      logs.set(server.pid, log)
    }
  }
  return logs
}

/** The dev_servers tool's answer: a scan now, then what it found, with the logs of pane starts. */
async function listForModel($: Engine, all: boolean): Promise<string> {
  ensureTimer($)
  const fresh = await refresh($, true)
  if (fresh === null) {
    return 'dev-servers: the port scan (netstat) did not answer in time, so nothing could be listed; try again in a moment.'
  }
  return toolText(fresh, { all, logs: await paneLogs($, fresh), now: await $.clock.now() })
}

/** Reads the options and starts the module's state over, as a load or a reload does. */
function configure(options: PluginOptions) {
  const poll = Number(options.pollSeconds ?? 15)
  const grace = Number(options.stopGraceSeconds ?? 5)
  config = {
    pollMs: Math.max(2, Number.isFinite(poll) ? poll : 15) * 1000,
    logDir: String(options.logDir ?? '').trim() || '~/.claude/dev-servers',
    graceMs: Math.min(60, Math.max(1, Number.isFinite(grace) ? grace : 5)) * 1000,
  }
  timer = null
  pollMs = config.pollMs
  inflight = null
  shownStatus = null
  rootFor = null
  scanner = 0
  details.clear()
  sessionId = null
  warnedWrite = false
}

/** When a command failed on a taken port: a toast naming the holder, and the note the model reads; null when there is none. */
async function conflictNote($: Engine, command: string, output: string): Promise<string | null> {
  const conflict = findConflict(output)
  const port = conflict === null ? null : (conflict.port ?? portFromCommand(command))
  if (port === null) {
    return null
  }
  const holder = await holderOf($, port)
  if (holder === null) {
    return null
  }
  const note = holderNote(port, holder)
  $.ui.toast(note, { timeoutMs: 10_000 })
  const root = await projectRoot($)
  const own = holder.cwd !== null && isInside(holder.cwd, root) ? " It is one of this project's servers; /servers can restart or stop it." : ''
  return `dev-servers: ${note}.${own}`
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'servers',
      description: "Open the Servers pane: this project's dev servers, with Start, Stop, Restart and Log",
      immediate: true,
    })
    await $.tool
      .register(TOOL_SPEC)
      .catch(error => $.ui.log(`dev-servers: the ${TOOL} tool did not register: ${String(error)}`, { to: 'debug' }))
    ensureTimer($)
    // The first scan runs from a timer of its own: starting the session never waits on netstat, ps or lsof.
    $.clock.after(0, () => void refresh($, false))
    return next(e)
  })

  on('command.run', { command: 'servers' }, async $ => {
    ensureTimer($)
    const fresh = await refresh($, true)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: fresh === null ? 'dev-servers: the port scan did not answer, so no servers could be listed.' : describe(fresh) }
  })

  // The model's view, read-only: this project's servers, the stopped entries and, asked, every other listener.
  on('tool.check', { tool: 'mcp__dev-servers__dev_servers' }, async ($, e, next) => {
    const verdict = await next(e)
    // It only reads the scan this plugin makes anyway: never worth asking, though a deny in settings stands.
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'dev-servers: a read-only listing of the port scan' }
  })

  on('tool.call', { tool: 'mcp__dev-servers__dev_servers' }, async ($, e) => ({
    result: await listForModel($, (e as unknown as { all?: unknown }).all === true),
  }))

  // A command that failed on a taken port: say who holds it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }
    try {
      const note = await conflictNote($, e.command, ran.text ?? '')
      return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
    } catch (error) {
      $.ui.log(`dev-servers: could not look up the port holder: ${String(error)}`, { to: 'debug' })
      return ran
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, snapshot)
    const working = await read($, busy)
    const forcing = await read($, armed)
    if (current === null) {
      return <Text dimColor>Looking for this project's servers…</Text>
    }
    const stacked = e.props.bodyColumns < STACK_BELOW
    const entryOf = (id: string | null) => current.entries.find(entry => entry.id === id) ?? null
    const others = `${current.others} other listener${current.others === 1 ? '' : 's'} on this machine`

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor wrap="truncate-start">
          {current.root}
        </Text>
        {current.servers.length === 0 ? (
          <Text dimColor>No dev servers are listening in this project.</Text>
        ) : (
          <Box flexDirection="column">
            {current.servers.map(server => {
              const entry = entryOf(server.entryId)
              const doing = working[`pid-${server.pid}`]
              const isArmed = forcing[String(server.pid)] !== undefined
              return (
                <Box
                  key={`server-${server.pid}`}
                  flexDirection={stacked ? 'column' : 'row'}
                  justifyContent="space-between"
                  columnGap={1}
                >
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text color="green">●</Text> {serverLine(server)}
                      {doing === undefined ? '' : ` · ${doing}…`}
                    </Text>
                  </Box>
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    {entry !== null && (
                      <Button key={`restart-${server.pid}`} label="Restart" onPress={() => void restartServer($, server, entry)} />
                    )}
                    <Button
                      key={`stop-${server.pid}`}
                      label={isArmed ? 'Force stop?' : 'Stop'}
                      variant={isArmed ? 'primary' : undefined}
                      onPress={() => void pressStop($, server)}
                    />
                    {entry !== null && (
                      <Button key={`log-${server.pid}`} label="Log" dimColor onPress={() => void showLog($, entry)} />
                    )}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        {current.stopped.length > 0 && (
          <Box flexDirection="column">
            {current.stopped.map(entry => {
              const doing = working[`entry-${entry.id}`]
              const detail = [entry.name, entry.command, entry.port === null ? null : `:${entry.port}`]
                .filter(Boolean)
                .join(' · ')
              return (
                <Box
                  key={`entry-${entry.id}`}
                  flexDirection={stacked ? 'column' : 'row'}
                  justifyContent="space-between"
                  columnGap={1}
                >
                  <Box flexShrink={1}>
                    <Text dimColor wrap="truncate-end">
                      ○ {detail}
                      {doing === undefined ? '' : ` · ${doing}…`}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button key={`start-${entry.id}`} label="Start" onPress={() => void pressStart($, entry)} />
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        <Text dimColor>{others}</Text>
      </Box>
    )
  })
}
