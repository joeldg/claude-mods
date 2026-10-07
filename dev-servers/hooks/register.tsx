import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { Holder, KnownEntry, Server, Snapshot } from '../types'
import {
  basename,
  describe,
  detectManager,
  expandHome,
  findConflict,
  holderNote,
  isInside,
  knownEntries,
  lastLines,
  LOCKFILES,
  logPath,
  matchServers,
  packageScripts,
  parseCwds,
  parseListeners,
  parsePortTable,
  parseProcesses,
  portFromCommand,
  portList,
  serverLine,
  startScript,
  statusLine,
  tokenize,
} from './servers'

type Engine = EngineInterface

const PANE = 'dev-servers'
const TITLE = 'Servers'
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

const snapshot = atom({ plugin: 'dev-servers', key: 'snapshot' } as const, null)
const busy = atom({ plugin: 'dev-servers', key: 'busy' } as const, {})
const armed = atom({ plugin: 'dev-servers', key: 'armed' } as const, {})

type Config = { pollMs: number; logDir: string; graceMs: number }

let config: Config = { pollMs: 15_000, logDir: '~/.claude/dev-servers', graceMs: 5_000 }
let timer: { cancel: () => void } | null = null
let inflight: Promise<Snapshot | null> | null = null
/** The status line last shown; null before the first. */
let shownStatus: string | undefined | null = null
let rootFor: { cwd: string; root: string } | null = null

/** A host command's result, or null when it could not start or timed out. */
async function run($: Engine, argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult | null> {
  return $.process.run(argv, { timeoutMs: 10_000, ...init }).catch(() => null)
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

/** One scan: every TCP listener, which of them run inside the project, and the known entries. */
async function collect($: Engine): Promise<Snapshot | null> {
  const root = await projectRoot($)
  const entries = await readEntries($, root)
  const listed = await run($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  if (listed === null) {
    return read($, snapshot)
  }
  const listeners = parseListeners(listed.stdout)
  const cwdOut =
    listeners.length > 0 ? await run($, ['lsof', '-a', '-p', listeners.map(l => l.pid).join(','), '-d', 'cwd', '-Fn']) : null
  const cwds = parseCwds(cwdOut?.stdout ?? '')
  const mine = listeners.filter(listener => {
    const cwd = cwds.get(listener.pid)
    return cwd !== undefined && isInside(cwd, root)
  })
  const psOut =
    mine.length > 0 ? await run($, ['ps', '-o', 'pid=,etime=,command=', '-p', mine.map(l => l.pid).join(',')]) : null
  const processes = parseProcesses(psOut?.stdout ?? '')
  const servers: Server[] = mine.map(listener => {
    const proc = processes.get(listener.pid)
    const commandLine = proc?.commandLine ?? listener.command
    return {
      pid: listener.pid,
      name: basename(tokenize(commandLine)[0] ?? '') || listener.command,
      entryId: null,
      ports: listener.ports,
      cwd: cwds.get(listener.pid) ?? root,
      upSeconds: proc?.upSeconds ?? null,
      commandLine,
    }
  })
  const matched = matchServers(servers, entries)
  const fresh: Snapshot = {
    root,
    servers: matched.servers,
    entries,
    stopped: matched.stopped,
    others: listeners.length - mine.length,
    at: await $.clock.now(),
  }
  await update($, snapshot, () => fresh)
  showStatus($, fresh.servers)
  return fresh
}

/** Scans now; a scan already under way is shared, not repeated. */
function refresh($: Engine): Promise<Snapshot | null> {
  if (!inflight) {
    inflight = collect($)
      .catch(() => null)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void refresh($))
  }
}

/** The first process listening on `port`, from `lsof -nP -iTCP:<port> -sTCP:LISTEN`. */
async function listenerOn($: Engine, port: number): Promise<{ pid: number; command: string } | null> {
  const out = await run($, ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
  return out === null ? null : (parsePortTable(out.stdout)[0] ?? null)
}

/** Who holds `port`: its process, how long it has run and in which folder. */
async function holderOf($: Engine, port: number): Promise<Holder | null> {
  const first = await listenerOn($, port)
  if (first === null) {
    return null
  }
  const [cwdOut, psOut] = await Promise.all([
    run($, ['lsof', '-a', '-p', String(first.pid), '-d', 'cwd', '-Fn']),
    run($, ['ps', '-o', 'pid=,etime=,command=', '-p', String(first.pid)]),
  ])
  return {
    pid: first.pid,
    command: first.command,
    upSeconds: parseProcesses(psOut?.stdout ?? '').get(first.pid)?.upSeconds ?? null,
    cwd: parseCwds(cwdOut?.stdout ?? '').get(first.pid) ?? null,
  }
}

async function portsFree($: Engine, ports: readonly number[]): Promise<boolean> {
  for (const port of ports) {
    if ((await listenerOn($, port)) !== null) {
      return false
    }
  }
  return true
}

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
    void refresh($)
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
    void refresh($)
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
    void refresh($)
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
  const home = await $.env.get('HOME').catch(() => undefined)
  const dir = expandHome(config.logDir, home)
  return logPath(dir.startsWith('~') ? '/tmp/dev-servers' : dir, root, entry)
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
  const fresh = await refresh($)
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
    void refresh($)
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

export const register: Register = (on, options) => {
  const poll = Number(options.pollSeconds ?? 15)
  const grace = Number(options.stopGraceSeconds ?? 5)
  config = {
    pollMs: Math.max(2, Number.isFinite(poll) ? poll : 15) * 1000,
    logDir: String(options.logDir ?? '').trim() || '~/.claude/dev-servers',
    graceMs: Math.min(60, Math.max(1, Number.isFinite(grace) ? grace : 5)) * 1000,
  }
  timer = null
  inflight = null
  shownStatus = null
  rootFor = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'servers',
      description: "Open the Servers pane: this project's dev servers, with Start, Stop, Restart and Log",
      immediate: true,
    })
    ensureTimer($)
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'servers' }, async $ => {
    ensureTimer($)
    const fresh = await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: fresh === null ? 'dev-servers: lsof did not answer, so no servers could be listed.' : describe(fresh) }
  })

  // A command that failed on a taken port: say who holds it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }
    try {
      const conflict = findConflict(ran.text ?? '')
      const port = conflict === null ? null : (conflict.port ?? portFromCommand(e.command))
      if (port === null) {
        return ran
      }
      const holder = await holderOf($, port)
      if (holder === null) {
        return ran
      }
      const note = holderNote(port, holder)
      $.ui.toast(note, { timeoutMs: 10_000 })
      const root = await projectRoot($)
      const own = holder.cwd !== null && isInside(holder.cwd, root) ? " It is one of this project's servers; /servers can restart or stop it." : ''
      return { ...ran, context: [...(ran.context ?? []), `dev-servers: ${note}.${own}`] }
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
    const others = `${current.others} other listener${current.others === 1 ? '' : 's'} on this Mac`

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
