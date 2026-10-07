import type { EngineInterface, Register } from 'claude-code'

import type { RoutineRun, RoutineSession, RoutineSettings } from '../types'
import {
  commandArgv,
  describeCall,
  describeRun,
  detectRoutine,
  finishMessage,
  firstQuestion,
  osascriptArgv,
  statusLine,
} from './routine'

type Engine = EngineInterface

const SESSION = { plugin: 'routine-watch', key: 'session' } as const
const UNDECIDED: RoutineSession = { isDecided: false, run: null }

/** The read-only web tools `allowWebReads` lets a routine run without asking; nothing else. */
const WEB_READS = new Set(['WebFetch', 'WebSearch'])
/** Prompts that never count as the session's first: machine-injected ones. */
const NOT_FIRST = new Set(['plugin', 'task-notification', 'observer', 'observer-activity'])
/** How often the status line's "waiting on you" time is refreshed. */
const TICK_MS = 15_000
/** How long a notification command may take. */
const NOTIFY_TIMEOUT_MS = 15_000

let config: RoutineSettings = { notifyMac: true, allowWebReads: false, notifyCommand: '', notifyOnFinish: true }
/**
 * What the session is, kept here and changed synchronously so concurrent hooks
 * never race; mirrored to `$.state` only so a hot reload can pick it up again.
 * (A dispatch's `$.state.get` reads one moment, so a hook that waits on a tool
 * could not see a wait another hook opened meanwhile.)
 */
let memory: RoutineSession = UNDECIDED
let restoring: Promise<void> | null = null
let ticker: { cancel: () => void } | null = null
/** The status line last shown, so an unchanged line is not set again. */
let shownStatus: string | undefined = undefined

async function debug($: Engine, line: string) {
  try {
    await $.ui.log(`routine-watch: ${line}`, { to: 'debug' })
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
async function load($: Engine): Promise<RoutineSession> {
  restoring ??= restore($)
  await restoring
  return memory
}

/** Takes the new value at once, then mirrors it for a reload. */
async function save($: Engine, value: RoutineSession) {
  memory = value
  try {
    await $.state.set(SESSION, value)
  } catch (error) {
    await debug($, `could not keep the session: ${String(error)}`)
  }
}

async function currentRun($: Engine): Promise<RoutineRun | null> {
  return (await load($)).run
}

async function showStatus($: Engine) {
  const run = await currentRun($)
  const line = run ? statusLine(run, await $.clock.now()) : undefined
  if (line !== shownStatus) {
    shownStatus = line
    $.ui.status(line)
  }
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

async function tick($: Engine) {
  await showStatus($)
  const run = await currentRun($)
  if (!run || Object.keys(run.waiting).length === 0) {
    stopTicker()
  }
}

function ensureTicker($: Engine) {
  if (!ticker) {
    ticker = $.clock.every(TICK_MS, () => void tick($))
  }
}

/** Runs one notification command; a failure goes to the debug log, never to the routine. */
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
async function sendOut($: Engine, run: RoutineRun, message: string) {
  const title = `Claude routine: ${run.name}`
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
 * Tells the person: a toast now, and the notifications in the background, so
 * the dialog the routine waits on is never held up by them.
 */
function notify($: Engine, run: RoutineRun, message: string) {
  $.ui.toast(message, { timeoutMs: 10_000 })
  void sendOut($, run, message)
}

/** Opens a wait for one tool call and tells the person, once per call. */
async function beginWait($: Engine, id: string, label: string, message: string) {
  const now = await $.clock.now()
  const { run } = await load($)
  if (!run || run.waiting[id] !== undefined) {
    return
  }
  const waiting = { ...run.waiting, [id]: { since: now, label } }
  const opened: RoutineRun = { ...run, waits: run.waits + 1, waiting }
  await save($, { ...memory, run: opened })
  ensureTicker($)
  await showStatus($)
  notify($, opened, message)
}

/** Closes the waits named (every open one when none are named). */
async function endWaits($: Engine, ids?: readonly string[]) {
  const { run } = await load($)
  const open = run ? Object.keys(run.waiting) : []
  const closing = ids ? open.filter(id => ids.includes(id)) : open
  if (!run || closing.length === 0) {
    return
  }
  const waiting = { ...run.waiting }
  for (const id of closing) {
    delete waiting[id]
  }
  await save($, { ...memory, run: { ...run, waiting } })
  await showStatus($)
}

export const register: Register = (on, options) => {
  config = {
    notifyMac: options.notifyMac !== false,
    allowWebReads: options.allowWebReads === true,
    notifyCommand: typeof options.notifyCommand === 'string' ? options.notifyCommand : '',
    notifyOnFinish: options.notifyOnFinish !== false,
  }
  memory = UNDECIDED
  restoring = null
  ticker = null
  shownStatus = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'routine',
      description: 'This routine run: its name, when it started, how often it waited on you, the settings',
      immediate: true,
    })
    return next(e)
  })

  // The session's first prompt decides whether it is a routine run.
  on('prompt.submit', async ($, e, next) => {
    try {
      const known = await load($)
      if (!known.isDecided && !NOT_FIRST.has(e.origin.kind)) {
        const name = detectRoutine(e.text, e.origin.kind)
        const now = await $.clock.now()
        if (!memory.isDecided) {
          await save($, { isDecided: true, run: name ? { name, startedAt: now, waits: 0, waiting: {} } : null })
          if (name) {
            await showStatus($)
          }
        }
      }
    } catch (error) {
      await debug($, `could not read the first prompt: ${String(error)}`)
    }
    return next(e)
  })

  // A permission ask in a routine is a run stopped until the person answers.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask') {
      return verdict
    }
    const run = await currentRun($)
    if (!run) {
      return verdict
    }
    if (config.allowWebReads && WEB_READS.has(e.tool)) {
      return { decision: 'allow', reason: 'routine-watch: web reads are allowed in routine runs (allowWebReads)' }
    }
    // A query (`$.tool.check`) carries no call id: nothing waits on it.
    if (e.tool_use_id !== undefined) {
      const label = describeCall(e.tool, e.input)
      await beginWait($, e.tool_use_id, label, `Waiting for your OK: ${label}`)
    }
    return verdict
  })

  // A question for the person stops the routine too; every call's end closes its wait.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const run = await currentRun($)
    if (!run || id === undefined) {
      return next(e)
    }
    if (e.tool === 'AskUserQuestion') {
      await beginWait($, id, 'AskUserQuestion', `Question for you: ${firstQuestion(e)}`)
    }
    try {
      return await next(e)
    } finally {
      await endWaits($, [id])
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const run = await currentRun($)
      if (run) {
        await endWaits($)
        if (e.reason === 'error') {
          notify($, run, 'The run stopped: its turn ended on an error.')
        }
      }
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    const { isDecided, run } = await load($)
    if (run) {
      stopTicker()
      if (config.notifyOnFinish) {
        const message = finishMessage(run, await $.clock.now())
        $.ui.toast(message)
        // Awaited: the session's end allows its hooks a short while, and the notice should land in it.
        await sendOut($, run, message)
      }
    }
    // A /clear goes on in this process as a fresh conversation, decided again by its first prompt.
    if (isDecided) {
      await save($, UNDECIDED)
    }
    if (shownStatus !== undefined) {
      shownStatus = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'routine' }, async $ => {
    const run = await currentRun($)
    return { text: describeRun(run, config, await $.clock.now()) }
  })
}
