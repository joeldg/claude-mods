import type { EngineInterface, Register } from 'claude-code'

import type { StallSession, StallSettings, StallWait } from '../types'
import {
  alarmPolicy,
  alarmTitle,
  classifyError,
  commandArgv,
  describeCall,
  describeStalls,
  dueAlarms,
  errorMessage,
  firstQuestion,
  folderName,
  isRoutinePrompt,
  osascriptArgv,
  statusLine,
  waitMessage,
} from './stall'

type Engine = EngineInterface

const SESSION = { plugin: 'stall-alarm', key: 'session' } as const
const FRESH: StallSession = { isDecided: false, isRoutine: false, isOff: false, folder: '', waiting: {}, alarms: [] }
const DEFAULTS: StallSettings = {
  stallMinutes: 5,
  repeatMinutes: 30,
  questionRepeatMinutes: 120,
  questionRepeats: 3,
  notifyMac: true,
  notifyCommand: '',
  alarmOnAnyError: false,
  skipRoutines: true,
}

/** Prompts that never count as the session's first: machine-injected ones. */
const NOT_FIRST = new Set(['plugin', 'task-notification', 'observer', 'observer-activity'])
/** How often the open waits are held against the threshold and the status line refreshed. */
const TICK_MS = 15_000
/** How long a notification command may take. */
const NOTIFY_TIMEOUT_MS = 15_000
/** How many alarms /stalls remembers. */
const KEPT_ALARMS = 10

let config: StallSettings = DEFAULTS
/**
 * The session, kept here and changed synchronously so concurrent hooks never
 * race; mirrored to `$.state` only so a hot reload can pick it up again.
 */
let memory: StallSession = FRESH
let restoring: Promise<void> | null = null
let ticker: { cancel: () => void } | null = null
/** The status line last shown, so an unchanged line is not set again. */
let shownStatus: string | undefined = undefined
/**
 * The error that ended the turn under way, as the first of the classic
 * StopFailure hook and turn.complete to hear of it recorded it; the other then
 * raises no second alarm. Cleared when the next turn starts.
 */
let failed: { isAlarmed: boolean } | null = null

const stallMs = (): number => Math.round(config.stallMinutes * 60_000)

/** A minutes option: a finite number of at least `least`, else the default. */
const minutesOption = (value: unknown, fallback: number, least: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= least ? value : fallback

/** A count option: a finite whole number of at least 0, else the default. */
const countOption = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

/** Whether this session is left alone: a scheduled routine, which routine-watch watches. */
const isQuiet = (session: StallSession): boolean => config.skipRoutines && session.isRoutine

async function debug($: Engine, line: string) {
  try {
    await $.ui.log(`stall-alarm: ${line}`, { to: 'debug' })
  } catch {
    // The debug log is best effort.
  }
}

async function restore($: Engine) {
  try {
    const { value } = await $.state.get(SESSION)
    if (value && !memory.isDecided) {
      memory = value
    }
  } catch (error) {
    await debug($, `could not restore the session: ${String(error)}`)
  }
}

/** The session as known, restored once after a reload. */
async function load($: Engine): Promise<StallSession> {
  restoring ??= restore($)
  await restoring
  return memory
}

/** Takes the new value at once, then mirrors it for a reload. */
async function save($: Engine, value: StallSession) {
  memory = value
  try {
    await $.state.set(SESSION, value)
  } catch (error) {
    await debug($, `could not keep the session: ${String(error)}`)
  }
}

async function showStatus($: Engine, now?: number) {
  const session = await load($)
  const line = session.isOff || isQuiet(session) ? undefined : statusLine(session.waiting, now ?? (await $.clock.now()), stallMs())
  if (line !== shownStatus) {
    shownStatus = line
    $.ui.status(line)
  }
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

function ensureTicker($: Engine) {
  if (!ticker) {
    ticker = $.clock.every(TICK_MS, () => void tick($))
  }
}

/** Runs one notification command; a failure goes to the debug log, never to the session. */
async function runQuietly($: Engine, argv: readonly string[]) {
  try {
    const out = await $.process.run(argv, { timeoutMs: NOTIFY_TIMEOUT_MS })
    if (out.exitCode !== 0) {
      await debug($, `${argv[0] ?? 'command'} exited ${out.exitCode}: ${out.stderr.trim().slice(0, 200)}`)
    }
  } catch (error) {
    await debug($, `${argv[0] ?? 'command'} failed: ${String(error)}`)
  }
}

/** The Mac notification and the person's push command, run side by side. */
async function sendOut($: Engine, title: string, message: string) {
  const jobs: Promise<void>[] = []
  if (config.notifyMac) {
    jobs.push(runQuietly($, osascriptArgv(title, message)))
  }
  const push = commandArgv(config.notifyCommand, { title, message })
  if (push) {
    jobs.push(runQuietly($, push))
  }
  await Promise.all(jobs)
}

/**
 * Raises one alarm: a toast now, the notifications in the background (so the
 * dialog Claude waits on is never held up by them), and a line for /stalls.
 */
async function alarm($: Engine, head: string, message: string) {
  const now = await $.clock.now()
  await save($, { ...memory, alarms: [...memory.alarms, { at: now, message }].slice(-KEPT_ALARMS) })
  $.ui.toast(message, { timeoutMs: 10_000 })
  void sendOut($, alarmTitle(head, memory.folder), message)
}

/**
 * Alarms for each open wait that is due one at `now`: first at the threshold,
 * then once per repeat period, a dialog's for as long as it stays open and a
 * question's a few times (`questionRepeats`) only.
 */
async function alarmStalls($: Engine, now: number) {
  const session = await load($)
  if (session.isOff) {
    return
  }
  for (const id of dueAlarms(session.waiting, now, alarmPolicy(config))) {
    const wait = memory.waiting[id]
    if (!wait) {
      continue
    }
    const alarmed: StallWait = { ...wait, alarmedAt: now, alarms: wait.alarms + 1 }
    await save($, { ...memory, waiting: { ...memory.waiting, [id]: alarmed } })
    await alarm($, 'Claude is waiting', waitMessage(wait, now))
  }
}

async function tick($: Engine) {
  const now = await $.clock.now()
  await alarmStalls($, now)
  await showStatus($, now)
  if (Object.keys(memory.waiting).length === 0) {
    stopTicker()
  }
}

/** Opens a wait for one tool call, once per call; the ticker holds it against the threshold. */
async function beginWait($: Engine, id: string, kind: StallWait['kind'], label: string) {
  const now = await $.clock.now()
  const session = await load($)
  if (isQuiet(session) || session.waiting[id] !== undefined) {
    return
  }
  const wait: StallWait = { since: now, kind, label, alarmedAt: null, alarms: 0 }
  await save($, { ...memory, waiting: { ...memory.waiting, [id]: wait } })
  ensureTicker($)
}

/** Closes the waits named (every open one when none are named). */
async function endWaits($: Engine, ids?: readonly string[]) {
  const session = await load($)
  const open = Object.keys(session.waiting)
  const closing = ids ? open.filter(id => ids.includes(id)) : open
  if (closing.length === 0) {
    return
  }
  const waiting = { ...memory.waiting }
  for (const id of closing) {
    delete waiting[id]
  }
  await save($, { ...memory, waiting })
  if (Object.keys(waiting).length === 0) {
    stopTicker()
  }
  await showStatus($)
}

/**
 * A turn stopped on an error, as the classic StopFailure hook or turn.complete
 * hears of it, whichever first: alarms once per turn when the error is one the
 * person must act on (login, limits, billing), or any error with alarmOnAnyError.
 */
async function stopped($: Engine, text: string, kind: string | null) {
  const session = await load($)
  if (isQuiet(session) || session.isOff) {
    return
  }
  const known = failed ?? { isAlarmed: false }
  failed = known
  if (known.isAlarmed || (!classifyError(text, kind).isKnown && !config.alarmOnAnyError)) {
    return
  }
  known.isAlarmed = true
  await alarm($, 'Claude stopped', errorMessage(text, kind))
}

export const register: Register = (on, options) => {
  config = {
    stallMinutes: minutesOption(options.stallMinutes, DEFAULTS.stallMinutes, 0.25),
    repeatMinutes: minutesOption(options.repeatMinutes, DEFAULTS.repeatMinutes, 0),
    questionRepeatMinutes: minutesOption(options.questionRepeatMinutes, DEFAULTS.questionRepeatMinutes, 0),
    questionRepeats: countOption(options.questionRepeats, DEFAULTS.questionRepeats),
    notifyMac: options.notifyMac !== false,
    notifyCommand: typeof options.notifyCommand === 'string' ? options.notifyCommand : '',
    alarmOnAnyError: options.alarmOnAnyError === true,
    skipRoutines: options.skipRoutines !== false,
  }
  memory = FRESH
  restoring = null
  ticker = null
  shownStatus = undefined
  failed = null

  on('session.start', async ($, e, next) => {
    await save($, { ...(await load($)), folder: folderName(e.cwd) })
    await $.command.register({
      name: 'stalls',
      description: 'What Claude is waiting on you for and for how long, the last alarms, the settings; off|on for the session',
      argumentHint: '[off|on]',
      immediate: true,
    })
    return next(e)
  })

  // The session's first prompt decides whether it is a routine run, left to routine-watch.
  on('prompt.submit', async ($, e, next) => {
    try {
      const known = await load($)
      if (!known.isDecided && !NOT_FIRST.has(e.origin.kind) && !memory.isDecided) {
        await save($, { ...memory, isDecided: true, isRoutine: isRoutinePrompt(e.text, e.origin.kind) })
      }
    } catch (error) {
      await debug($, `could not read the first prompt: ${String(error)}`)
    }
    return next(e)
  })

  // A permission dialog is a wait from the ask until the call runs, is refused, or the turn ends.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // A query (`$.tool.check`) carries no call id: nothing waits on it.
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      await beginWait($, e.tool_use_id, 'ok', describeCall(e.tool, e.input))
    }
    return verdict
  })

  // A question for the person is a wait too; every call's end closes its wait.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (id === undefined) {
      return next(e)
    }
    if (e.tool === 'AskUserQuestion') {
      await beginWait($, id, 'question', firstQuestion(e))
    }
    try {
      return await next(e)
    } finally {
      await endWaits($, [id])
    }
  })

  on('turn.start', ($, e, next) => {
    failed = null
    return next(e)
  })

  // The API error that ended a turn, with its text; a subagent's is the main loop's soon enough.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) {
      await stopped($, e.error_details ?? e.last_assistant_message ?? '', e.error)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await endWaits($)
      if (e.reason === 'error') {
        await stopped($, e.answer, null)
      }
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    stopTicker()
    const session = await load($)
    // A /clear goes on in this process as a fresh conversation, decided again by its first prompt.
    if (session.isDecided || Object.keys(session.waiting).length > 0) {
      await save($, { ...FRESH, folder: session.folder })
    }
    if (shownStatus !== undefined) {
      shownStatus = undefined
      $.ui.status(undefined)
    }
    failed = null
    return next(e)
  })

  on('command.run', { command: 'stalls' }, async ($, e) => {
    const session = await load($)
    const word = e.args.trim().toLowerCase()
    if (word === 'off' || word === 'on') {
      await save($, { ...session, isOff: word === 'off' })
      await showStatus($)
      return {
        text: word === 'off' ? 'stall-alarm: alarms are off for this session; /stalls on turns them back on.' : 'stall-alarm: alarms are on.',
      }
    }
    if (word !== '') {
      return { text: 'Usage: /stalls, /stalls off, /stalls on' }
    }
    return { text: describeStalls(session, config, await $.clock.now()) }
  })
}
