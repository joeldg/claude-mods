import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModalMeter } from '../types'
import {
  activeApps,
  alertText,
  cliCandidates,
  dueAlerts,
  firstLine,
  isAuthProblem,
  isMissingModule,
  kindOf,
  lacksBilling,
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
/** Spend is asked this often at most (a poll is every minute; spend moves slower). */
const SPEND_EVERY_MS = 5 * 60_000
/** After `billing report` failed for a reason other than not existing, wait this long to ask again. */
const SPEND_RETRY_MS = 60 * 60_000
/** Plain output: no ANSI styling from rich (FORCE_COLOR still adds bold, which the parser strips). */
const PLAIN_ENV = { NO_COLOR: '1', TERM: 'dumb' }

const EMPTY: ModalMeter = { cli: null, problem: null, apps: [], polledAt: null, spendToday: null, spendNote: null }

const meter = atom({ plugin: 'modal-meter', key: 'meter' } as const, EMPTY)
const tracked = atom({ plugin: 'modal-meter', key: 'tracked' } as const, {})
const confirming = atom({ plugin: 'modal-meter', key: 'confirming' } as const, null)
const stopping = atom({ plugin: 'modal-meter', key: 'stopping' } as const, null)
const budgetDay = atom({ plugin: 'modal-meter', key: 'budgetDay' } as const, null)

type Config = { command: string; pollMs: number; alertMs: number; budget: number }

let config: Config = { command: '', pollMs: 60_000, alertMs: 30 * 60_000, budget: 0 }
let timer: { cancel: () => void } | null = null
/** The Modal CLI argv that answered `--version`: undefined until tried, null when none did. */
let cli: string[] | null | undefined
let inflight: Promise<void> | null = null
let spendAskedAt: number | null = null
let spendWaitMs = SPEND_EVERY_MS
let hasBilling = true

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

type SpendPart = Pick<ModalMeter, 'spendToday' | 'spendNote'>

/** Today's spend from `modal billing report --for today --json`, where this CLI has it. */
async function readSpend(
  $: Engine,
  argv: readonly string[],
  now: number,
  isForced: boolean,
  kept: SpendPart,
): Promise<SpendPart> {
  if (!hasBilling) {
    return kept
  }
  if (!isForced && spendAskedAt !== null && now - spendAskedAt < spendWaitMs) {
    return kept
  }
  spendAskedAt = now
  const out = await run($, [...argv, 'billing', 'report', '--for', 'today', '--json'], LIST_TIMEOUT_MS)
  const text = `${out.stderr}\n${out.stdout}`
  const spent = out.started && out.code === 0 ? parseSpend(out.stdout) : null
  if (spent !== null) {
    spendWaitMs = SPEND_EVERY_MS
    await checkBudget($, spent, now)
    return { spendToday: spent, spendNote: null }
  }
  if (lacksBilling(text)) {
    hasBilling = false
    return { spendToday: null, spendNote: 'this Modal CLI has no `billing report` command; Modal 1.3.3 and later have one' }
  }
  spendWaitMs = SPEND_RETRY_MS
  return { spendToday: null, spendNote: `\`billing report\` failed: ${firstLine(text)}` }
}

async function pollOnce($: Engine, isForced: boolean) {
  if (cli === undefined) {
    cli = await resolveCli($)
  }
  if (cli === null) {
    await silence($, notFound(), null)
    return
  }
  const label = cli.join(' ')
  const listed = await run($, [...cli, 'app', 'list', '--json'], LIST_TIMEOUT_MS)
  const text = `${listed.stderr}\n${listed.stdout}`
  if (!listed.started) {
    await silence($, `\`${label} app list\` could not run: ${firstLine(listed.stderr)}`, label)
    return
  }
  if (listed.code !== 0) {
    await silence(
      $,
      isAuthProblem(text)
        ? `Modal has no profile or token set up on this machine (run \`${label} setup\`)`
        : `\`${label} app list\` failed: ${firstLine(text)}`,
      label,
    )
    return
  }
  const apps = parseAppList(listed.stdout)
  if (apps === null) {
    await silence($, `\`${label} app list --json\` printed no JSON list`, label)
    return
  }

  const now = await $.clock.now()
  let next = trackApps(await read($, tracked), apps, now)
  for (const app of dueAlerts(apps, next, now, config.alertMs)) {
    const since = next[app.id]?.busySince ?? now
    $.ui.toast(alertText(app, now - since), { timeoutMs: 15_000 })
    next = { ...next, [app.id]: { busySince: since, alertedAt: now } }
  }
  await update($, tracked, () => next)

  const previous = await read($, meter)
  const spend = await readSpend($, cli, now, isForced, {
    spendToday: previous.spendToday,
    spendNote: previous.spendNote,
  })
  await update($, meter, () => ({ cli: label, problem: null, apps, polledAt: now, ...spend }))
  $.ui.status(statusText(apps, false))
}

/** One poll at a time: a call while one runs shares it. */
function poll($: Engine, isForced: boolean): Promise<void> {
  if (!inflight) {
    inflight = pollOnce($, isForced)
      .catch(error => $.ui.log(`modal-meter: poll failed: ${String(error)}`, { to: 'debug' }))
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** A poll that starts after any running one, so it sees what happened since. */
async function refresh($: Engine, isForced: boolean) {
  if (inflight) {
    await inflight
  }
  await poll($, isForced)
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void poll($, false))
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
      cli = await resolveCli($)
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
  await refresh($, false)
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
  }
  timer = null
  cli = undefined
  inflight = null
  spendAskedAt = null
  spendWaitMs = SPEND_EVERY_MS
  hasBilling = true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'modal',
      description: 'Open the Modal pane: running apps, containers, spend; stop an app',
    })
    await update($, stopping, () => null)
    ensureTimer($)
    void poll($, false)
    return next(e)
  })

  on('command.run', { command: 'modal' }, async $ => {
    ensureTimer($)
    if (cli === null) {
      // Not found before: look again, in case Modal was installed since.
      cli = undefined
    }
    await refresh($, true)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: summaryText(await read($, meter), await read($, tracked), await $.clock.now(), config.budget) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, meter)
    const tracking = await read($, tracked)
    const asked = await read($, confirming)
    const busyId = await read($, stopping)
    const now = await $.clock.now()
    const apps = activeApps(shown.apps)
    const notice =
      shown.problem !== null
        ? `modal-meter is silent: ${shown.problem}.`
        : shown.polledAt === null
          ? 'Reading Modal…'
          : apps.length === 0
            ? 'No Modal apps running or deployed.'
            : null
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
        {spend !== null && <Text dimColor>{spend}</Text>}
      </Box>
    )
  })
}
