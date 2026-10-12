import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModalCache, ModalMeter, ModalProject, ModalShared } from '../types'
import {
  activeApps,
  alertText,
  cliCandidates,
  dueAlerts,
  firstLine,
  formatDuration,
  isAuthProblem,
  isCacheEntry,
  isDependencyFile,
  isEnoent,
  isLock,
  isMissingModule,
  isModalCommand,
  isProjectRecord,
  isTimeout,
  kindOf,
  lacksBilling,
  namesModal,
  nextInterval,
  paneNotice,
  parseAppList,
  parseSpend,
  rowText,
  statusText,
  summaryText,
  trackApps,
  usd,
  utcDay,
  wantsYes,
} from './meter'

type Engine = EngineInterface

const PANE = 'modal-meter'
const TITLE = 'Modal'
const PROBE_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 120_000
/** The look at the project's Python files (`rg`) gets this long; then its dependency files decide. */
const DETECT_TIMEOUT_MS = 5_000
/** A project's answer (uses Modal or not) is kept in the store this long before it is looked at again. */
const PROJECT_RECHECK_MS = 24 * 60 * 60_000
/** Spend is asked this often at most (a poll is every minute; spend moves slower). */
const SPEND_EVERY_MS = 5 * 60_000
/** After `billing report` failed for a reason other than not existing, wait this long to ask again. */
const SPEND_RETRY_MS = 60 * 60_000
/** Once a CLI is known to lack `billing report`, no session tries it again for this long. */
const BILLING_RECHECK_MS = 24 * 60 * 60_000
/** Another session's lock is stale once its poll interval and this much (one probe timeout) have passed since it was taken. */
const LOCK_STALE_MS = LIST_TIMEOUT_MS
/** Plain output: no ANSI styling from rich (FORCE_COLOR still adds bold, which the parser strips). */
const PLAIN_ENV = { NO_COLOR: '1', TERM: 'dumb' }
/** `rg -l` over the project's Python files for a line importing modal, the usual vendored folders skipped. */
const RG_ARGS = ['-l', '-m1', '--glob', '*.py', '--glob', '!.venv/**', '--glob', '!node_modules/**', '--glob', '!.git/**', '-e', '^\\s*(import|from)\\s+modal\\b']
/** The dependency files read when `rg` cannot list the project's own. */
const DEPENDENCY_FILES = ['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock']

const EMPTY: ModalMeter = { cli: null, problem: null, apps: [], polledAt: null, spendToday: null, spendNote: null }
/** What is known before any session has polled: nothing, and `billing report` untried. */
const UNKNOWN: ModalShared = {
  cli: null,
  problem: null,
  apps: [],
  spendToday: null,
  spendNote: null,
  spendAskedAt: null,
  spendWaitMs: SPEND_EVERY_MS,
  billingUnsupportedAt: null,
}

const meter = atom({ plugin: 'modal-meter', key: 'meter' } as const, EMPTY)
const tracked = atom({ plugin: 'modal-meter', key: 'tracked' } as const, {})
const confirming = atom({ plugin: 'modal-meter', key: 'confirming' } as const, null)
const stopping = atom({ plugin: 'modal-meter', key: 'stopping' } as const, null)
const budgetDay = atom({ plugin: 'modal-meter', key: 'budgetDay' } as const, null)
const watching = atom({ plugin: 'modal-meter', key: 'watching' } as const, false)

type Config = { command: string; pollMs: number; alertMs: number; budget: number; alwaysPoll: boolean }

/**
 * Why a poll runs: the timer (`tick`: another session's fresh answer will do, and its live lock
 * is respected), the person's /modal (`asked`: a fresh answer will do, else poll whoever holds
 * the lock), or a stop this session made (`changed`: always poll).
 */
type Poll = 'tick' | 'asked' | 'changed'

let config: Config = { command: '', pollMs: 60_000, alertMs: 30 * 60_000, budget: 0, alwaysPoll: false }
let timer: { cancel: () => void } | null = null
/** The poll interval in force: the option, doubled while Modal answers slowly. */
let intervalMs = 60_000
/** The Modal CLI argv that answered `--version` (or another session's, adopted): undefined until tried, null when none did. */
let cli: string[] | null | undefined
let inflight: Promise<void> | null = null
/** The home directory, read once; null when there is none to keep the shared cache under. */
let home: string | null | undefined
let sessionId: string | null = null
/** The cache entry this session last read or wrote: the cache itself when there is no home directory. */
let memo: ModalCache | null = null

type Ran = { started: boolean; code: number; stdout: string; stderr: string }

async function run($: Engine, argv: readonly string[], timeoutMs: number): Promise<Ran> {
  try {
    const out = await $.process.run(argv, { timeoutMs, env: PLAIN_ENV })
    return { started: true, code: out.exitCode, stdout: out.stdout, stderr: out.stderr }
  } catch (error) {
    return { started: false, code: -1, stdout: '', stderr: String(error) }
  }
}

/**
 * Whether `exe` can start: a path is checked as given, a bare name against each `PATH` folder. With no
 * `PATH` to read it is assumed present, so the probe still runs. Checking first spares a process that
 * can only fail (`modal` is often not on `PATH` when Modal runs as `python3 -m modal`).
 */
async function canStart($: Engine, exe: string): Promise<boolean> {
  try {
    if (exe.includes('/')) {
      return await $.fs.exists(exe)
    }
    const folders = ((await $.env.get('PATH')) ?? '').split(':').filter(Boolean)
    if (folders.length === 0) {
      return true
    }
    for (const folder of folders) {
      if (await $.fs.exists(`${folder.replace(/\/+$/, '')}/${exe}`)) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** The first candidate that answers `--version`: the option as given, else `modal`, then `python3 -m modal`. */
async function resolveCli($: Engine): Promise<string[] | null> {
  for (const argv of cliCandidates(config.command)) {
    if (!(await canStart($, argv[0] ?? ''))) {
      continue
    }
    const out = await run($, [...argv, '--version'], PROBE_TIMEOUT_MS)
    if (out.started && out.code === 0 && !isMissingModule(`${out.stderr}\n${out.stdout}`)) {
      return argv
    }
  }
  return null
}

/** The CLI another session found, when it can start here too; else this session's own search. */
async function adoptCli($: Engine, shared: readonly string[] | null): Promise<string[] | null> {
  if (shared !== null && shared.length > 0 && (await canStart($, shared[0] ?? ''))) {
    return [...shared]
  }
  return resolveCli($)
}

function notFound(): string {
  const own = config.command.trim()
  return own
    ? `the Modal CLI did not run as \`${own}\` (the modalCommand option)`
    : 'no Modal CLI found (tried `modal` and `python3 -m modal`); set the modalCommand option to the command you run Modal with'
}

/** Nothing to show: no status line, no rows, the reason kept for /modal and the pane. */
async function silence($: Engine, problem: string, label: string | null) {
  await update($, meter, () => ({ ...EMPTY, cli: label, problem }))
  $.ui.status(undefined)
}

async function checkBudget($: Engine, spent: number, now: number) {
  if (config.budget <= 0 || spent < config.budget) {
    return
  }
  const day = utcDay(now)
  if ((await read($, budgetDay)) === day) {
    return
  }
  await update($, budgetDay, () => day)
  $.ui.toast(
    `Modal spend today is ${usd(spent)}, past your ${usd(config.budget)} daily budget — /modal to see what is running`,
    { timeoutMs: 15_000 },
  )
}

type SpendPart = Pick<ModalShared, 'spendToday' | 'spendNote' | 'spendAskedAt' | 'spendWaitMs' | 'billingUnsupportedAt'>

/** The spend fields of an answer, and nothing else (what `readSpend` keeps or replaces). */
const spendOf = (shared: ModalShared): SpendPart => ({
  spendToday: shared.spendToday,
  spendNote: shared.spendNote,
  spendAskedAt: shared.spendAskedAt,
  spendWaitMs: shared.spendWaitMs,
  billingUnsupportedAt: shared.billingUnsupportedAt,
})

/**
 * Today's spend from `modal billing report --for today --json`, where this CLI has it and a read
 * is due; else `kept` as the last session left it. A CLI without the command is remembered for a
 * day, for every session.
 */
async function readSpend($: Engine, argv: readonly string[], now: number, isForced: boolean, kept: SpendPart): Promise<SpendPart> {
  if (kept.billingUnsupportedAt !== null && now - kept.billingUnsupportedAt < BILLING_RECHECK_MS) {
    return kept
  }
  if (!isForced && kept.spendAskedAt !== null && now - kept.spendAskedAt < kept.spendWaitMs) {
    return kept
  }
  const out = await run($, [...argv, 'billing', 'report', '--for', 'today', '--json'], LIST_TIMEOUT_MS)
  const text = `${out.stderr}\n${out.stdout}`
  const spent = out.started && out.code === 0 ? parseSpend(out.stdout) : null
  if (spent !== null) {
    return { spendToday: spent, spendNote: null, spendAskedAt: now, spendWaitMs: SPEND_EVERY_MS, billingUnsupportedAt: null }
  }
  if (lacksBilling(text)) {
    return {
      spendToday: null,
      spendNote: 'this Modal CLI has no `billing report` command; Modal 1.3.3 and later have one',
      spendAskedAt: now,
      spendWaitMs: SPEND_EVERY_MS,
      billingUnsupportedAt: now,
    }
  }
  return {
    spendToday: null,
    spendNote: `\`billing report\` failed: ${firstLine(text)}`,
    spendAskedAt: now,
    spendWaitMs: SPEND_RETRY_MS,
    billingUnsupportedAt: null,
  }
}

/**
 * One run of the CLI: the app list, then spend where due. `shared` is the last answer any session
 * gave, whose spend timing and billing knowledge carry on; `now` is when the poll started.
 */
async function probe($: Engine, argv: readonly string[], shared: ModalShared, now: number, isForced: boolean): Promise<ModalShared> {
  const label = argv.join(' ')
  const kept: ModalShared = { ...shared, cli: [...argv], problem: null, apps: [] }
  const listed = await run($, [...argv, 'app', 'list', '--json'], LIST_TIMEOUT_MS)
  const text = `${listed.stderr}\n${listed.stdout}`
  const apps = listed.started && listed.code === 0 ? parseAppList(listed.stdout) : null
  adapt($, (await $.clock.now()) - now, isTimeout(listed.stderr), apps !== null)
  if (!listed.started) {
    if (isEnoent(listed.stderr)) {
      // The executable is not on this session's PATH: no retry until /modal asks to look again.
      cli = null
    }
    return { ...kept, problem: `\`${label} app list\` could not run: ${firstLine(listed.stderr)}` }
  }
  if (listed.code !== 0) {
    return {
      ...kept,
      problem: isAuthProblem(text)
        ? `Modal has no profile or token set up on this machine (run \`${label} setup\`)`
        : `\`${label} app list\` failed: ${firstLine(text)}`,
    }
  }
  if (apps === null) {
    return { ...kept, problem: `\`${label} app list --json\` printed no JSON list` }
  }
  return { ...kept, ...(await readSpend($, argv, now, isForced, spendOf(kept))), apps }
}

/** Shows an answer, this session's or another's: the status line, the pane's rows, the long-run toasts and the budget toast. */
async function apply($: Engine, data: ModalShared, polledAt: number, now: number) {
  const label = data.cli?.join(' ') ?? null
  if (data.problem !== null) {
    await silence($, data.problem, label)
    return
  }
  let next = trackApps(await read($, tracked), data.apps, now)
  for (const app of dueAlerts(data.apps, next, now, config.alertMs)) {
    const since = next[app.id]?.busySince ?? now
    $.ui.toast(alertText(app, now - since), { timeoutMs: 15_000 })
    next = { ...next, [app.id]: { busySince: since, alertedAt: now } }
  }
  await update($, tracked, () => next)
  if (data.spendToday !== null) {
    await checkBudget($, data.spendToday, now)
  }
  await update($, meter, () => ({
    cli: label,
    problem: null,
    apps: data.apps,
    polledAt,
    spendToday: data.spendToday,
    spendNote: data.spendNote,
  }))
  $.ui.status(statusText(data.apps, false))
}

/** `~/.claude/modal-meter`, where every session shares what it read; null with no home directory to keep it under. */
async function sharedDir($: Engine): Promise<string | null> {
  if (home === undefined) {
    const found = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
    home = found ? found.replace(/\/+$/, '') : null
  }
  return home === null ? null : `${home}/.claude/modal-meter`
}

/** This session's id: the name on the lock and the cache it writes. */
async function whoAmI($: Engine): Promise<string> {
  sessionId ??= (await $.session.id().catch(() => null)) || `s-${Math.random().toString(36).slice(2, 10)}`
  return sessionId
}

/** A JSON file's value; null when it is missing or not JSON. */
async function readJson($: Engine, path: string): Promise<unknown> {
  const text = await $.fs.read(path).catch(() => null)
  if (typeof text !== 'string') {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The shared cache; with no home directory, what this session last wrote itself. */
async function readCache($: Engine, dir: string | null): Promise<ModalCache | null> {
  if (dir === null) {
    return memo
  }
  const value = await readJson($, `${dir}/cache.json`)
  return isCacheEntry(value) ? value : null
}

async function writeCache($: Engine, dir: string | null, entry: ModalCache) {
  memo = entry
  if (dir !== null) {
    await $.fs.write(`${dir}/cache.json`, JSON.stringify(entry)).catch(() => undefined)
  }
}

/**
 * Whether this session may run the CLI now, taking the lock when it may. A tick yields to another
 * session's lock while it is live: the holder's poll interval plus one probe timeout since it was
 * taken. The holder keeps the lock between polls, so one session polls for all until it goes away;
 * the person's own /modal and a stop this session made poll whoever holds it.
 */
async function takeLock($: Engine, dir: string, now: number, holderIntervalMs: number, isTick: boolean): Promise<boolean> {
  const me = await whoAmI($)
  const lock = await readJson($, `${dir}/lock.json`)
  if (isTick && isLock(lock) && lock.by !== me && now - lock.ts < holderIntervalMs + LOCK_STALE_MS) {
    return false
  }
  await $.fs.write(`${dir}/lock.json`, JSON.stringify({ ts: now, by: me })).catch(() => undefined)
  return true
}

/** The poll interval after a probe: doubled after a slow or timed-out one, the option again after a fast success; one log line per change. */
function adapt($: Engine, elapsedMs: number, isTimedOut: boolean, isOk: boolean) {
  const next = nextInterval(intervalMs, config.pollMs, elapsedMs, isTimedOut, isOk)
  if (next === intervalMs) {
    return
  }
  intervalMs = next
  $.ui.log(`modal-meter: polling every ${formatDuration(next)} (app list ${isTimedOut ? 'timed out' : `took ${formatDuration(elapsedMs)}`})`, {
    to: 'debug',
  })
  setTimer($)
}

/** (Re)starts the timer at the interval in force. */
function setTimer($: Engine) {
  timer?.cancel()
  timer = $.clock.every(intervalMs, () => void poll($, 'tick'))
}

function ensureTimer($: Engine) {
  if (!timer) {
    setTimer($)
  }
}

async function pollOnce($: Engine, mode: Poll) {
  const now = await $.clock.now()
  const dir = await sharedDir($)
  const cached = await readCache($, dir)
  if (mode !== 'changed' && cached !== null && now - cached.ts < cached.intervalMs) {
    await apply($, cached.data, cached.ts, now)
    return
  }
  if (cli === undefined) {
    cli = await adoptCli($, cached?.data.cli ?? null)
  }
  if (cli === null) {
    // Nothing to run here; another session's answer, even an old one, is still worth showing.
    if (cached !== null) {
      await apply($, cached.data, cached.ts, now)
    } else {
      await silence($, notFound(), null)
    }
    return
  }
  if (dir !== null && !(await takeLock($, dir, now, cached?.intervalMs ?? intervalMs, mode === 'tick'))) {
    if (cached !== null) {
      await apply($, cached.data, cached.ts, now)
    }
    return
  }
  const data = await probe($, cli, cached?.data ?? UNKNOWN, now, mode === 'asked')
  await writeCache($, dir, { ts: now, by: await whoAmI($), intervalMs, data })
  await apply($, data, now, now)
}

/** One poll at a time: a call while one runs shares it. */
function poll($: Engine, mode: Poll): Promise<void> {
  if (!inflight) {
    inflight = pollOnce($, mode)
      .catch(error => $.ui.log(`modal-meter: poll failed: ${String(error)}`, { to: 'debug' }))
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** A poll that starts after any running one, so it sees what happened since. */
async function refresh($: Engine, mode: Poll) {
  if (inflight) {
    await inflight
  }
  await poll($, mode)
}

/** The project's dependency files worth reading, by name; the usual four when the folder cannot be listed. */
async function dependencyFiles($: Engine, cwd: string): Promise<string[]> {
  try {
    return (await $.fs.list(cwd)).filter(entry => entry.kind === 'file' && isDependencyFile(entry.name)).map(entry => entry.name)
  } catch {
    return DEPENDENCY_FILES
  }
}

/** Whether the project imports modal in a `.py` file (asked of `rg`), or names it in a dependency file. */
async function detectModal($: Engine, cwd: string): Promise<boolean> {
  const found = await run($, ['rg', ...RG_ARGS, cwd], DETECT_TIMEOUT_MS)
  if (found.started && found.code === 0 && found.stdout.trim() !== '') {
    return true
  }
  for (const name of await dependencyFiles($, cwd)) {
    const text = await $.fs.read(`${cwd}/${name}`).catch(() => null)
    if (typeof text === 'string' && namesModal(name, text)) {
      return true
    }
  }
  return false
}

/** Whether the project at `cwd` uses Modal, remembered in the store for a day. */
async function usesModal($: Engine, cwd: string): Promise<boolean> {
  const key = `project:${cwd}`
  const now = await $.clock.now()
  const known = await $.store.get(key).catch(() => undefined)
  if (isProjectRecord(known) && now - known.checkedAt < PROJECT_RECHECK_MS) {
    return known.usesModal
  }
  const record: ModalProject = { usesModal: await detectModal($, cwd), checkedAt: now }
  await $.store.set(key, record).catch(() => undefined)
  return record.usesModal
}

/** Turns the meter on for this session, once: the state the pane reads, and the timer. */
async function startWatching($: Engine, why: string) {
  if (!(await read($, watching))) {
    await update($, watching, () => true)
    $.ui.log(`modal-meter: watching Modal: ${why}`, { to: 'debug' })
  }
  ensureTimer($)
}

/** The session's start, off the hook's own time: whether this project is watched, then the first poll. */
async function begin($: Engine, cwd: string) {
  try {
    await update($, stopping, () => null)
    const why = config.alwaysPoll
      ? 'the alwaysPoll option'
      : (await read($, watching))
        ? 'asked earlier this session'
        : (await usesModal($, cwd))
          ? 'this project uses Modal'
          : null
    if (why === null) {
      $.ui.log('modal-meter: not watching Modal: this project does not use it (/modal or a modal command starts it)', { to: 'debug' })
      return
    }
    await startWatching($, why)
    await poll($, 'tick')
  } catch (error) {
    $.ui.log(`modal-meter: start failed: ${String(error)}`, { to: 'debug' })
  }
}

/** The confirmed Stop: `modal app stop <id>` (again with `--yes` where the CLI asks for it), a fresh poll, a toast. */
async function stopApp($: Engine, id: string) {
  if ((await read($, stopping)) !== null) {
    return
  }
  const name = (await read($, meter)).apps.find(app => app.id === id)?.name ?? id
  await update($, confirming, () => null)
  await update($, stopping, () => id)
  let out: Ran = { started: false, code: -1, stdout: '', stderr: 'no Modal CLI' }
  try {
    if (cli === undefined) {
      cli = await adoptCli($, memo?.data.cli ?? null)
    }
    if (cli) {
      out = await run($, [...cli, 'app', 'stop', id], STOP_TIMEOUT_MS)
      if (out.started && out.code !== 0 && wantsYes(`${out.stderr}\n${out.stdout}`)) {
        out = await run($, [...cli, 'app', 'stop', '--yes', id], STOP_TIMEOUT_MS)
      }
    }
  } finally {
    await update($, stopping, () => null)
  }
  await refresh($, 'changed')
  $.ui.toast(
    out.started && out.code === 0
      ? `Stopped Modal app ${name}`
      : `Could not stop Modal app ${name}: ${firstLine(`${out.stderr}\n${out.stdout}`)}`,
    { timeoutMs: 10_000 },
  )
}

const positive = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const register: Register = (on, options) => {
  config = {
    command: String(options.modalCommand ?? '').trim(),
    pollMs: Math.max(10, positive(options.pollSeconds, 60)) * 1000,
    alertMs: positive(options.alertMinutes, 30) * 60_000,
    budget: Math.max(0, Number(options.budgetToday ?? 0) || 0),
    alwaysPoll: options.alwaysPoll === true,
  }
  timer = null
  intervalMs = config.pollMs
  cli = undefined
  inflight = null
  home = undefined
  sessionId = null
  memo = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'modal',
      description: 'Open the Modal pane: running apps, containers, spend; stop an app',
    })
    void begin($, e.cwd)
    return next(e)
  })

  on('command.run', { command: 'modal' }, async $ => {
    await startWatching($, 'the person ran /modal')
    if (cli === null) {
      // Not found before: look again, in case Modal was installed since.
      cli = undefined
    }
    await refresh($, 'asked')
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: summaryText(await read($, meter), await read($, tracked), await $.clock.now(), config.budget) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isModalCommand(e.command) && !(await read($, watching))) {
      await startWatching($, 'a modal command ran')
      void poll($, 'tick')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, meter)
    const tracking = await read($, tracked)
    const asked = await read($, confirming)
    const busyId = await read($, stopping)
    const isWatching = await read($, watching)
    const now = await $.clock.now()
    const apps = activeApps(shown.apps)
    const notice = paneNotice(shown, isWatching)
    // An answer older than two polls: another session holds the lock and is slow, or this one has no CLI.
    const age = shown.polledAt !== null && now - shown.polledAt >= 2 * intervalMs ? now - shown.polledAt : null
    const spend =
      shown.spendToday === null
        ? null
        : `Spend today (UTC): ${usd(shown.spendToday)}${config.budget > 0 ? ` of ${usd(config.budget)}` : ''}`

    return (
      <Box flexDirection="column" gap={1}>
        {notice !== null && <Text dimColor>{notice}</Text>}
        {apps.map(app => {
          const isIdle = kindOf(app) === 'idle'
          if (busyId === app.id) {
            return (
              <Box key={`row-${app.id}`} flexDirection="row">
                <Text color="yellow">{`Stopping ${app.name}…`}</Text>
              </Box>
            )
          }
          if (asked === app.id) {
            return (
              <Box key={`row-${app.id}`} flexDirection="row" gap={1}>
                <Text bold>{`Stop ${app.name}?`}</Text>
                <Button
                  key={`confirm-${app.id}`}
                  label="Confirm"
                  variant="primary"
                  onPress={() => stopApp($, app.id)}
                />
                <Button key={`cancel-${app.id}`} label="Cancel" onPress={() => update($, confirming, () => null)} />
              </Box>
            )
          }
          return (
            <Box key={`row-${app.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
              <Text dimColor={isIdle} wrap="truncate-end">
                {rowText(app, tracking[app.id], now)}
              </Text>
              <Button
                key={`stop-${app.id}`}
                label="Stop"
                dimColor={isIdle}
                onPress={() => update($, confirming, () => app.id)}
              />
            </Box>
          )
        })}
        {age !== null && <Text dimColor>{`Last read ${formatDuration(age)} ago.`}</Text>}
        {spend !== null && <Text dimColor>{spend}</Text>}
      </Box>
    )
  })
}
