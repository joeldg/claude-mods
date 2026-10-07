import type { EngineInterface, Register } from 'claude-code'

import {
  closedToast,
  contentPaths,
  countPids,
  fileName,
  findSlicerOpens,
  FULL_SPECTRUM_MARKER,
  fullSpectrumPattern,
  mentionsOpen,
  nameSaysFullSpectrum,
  parseSliceArgs,
  quitScript,
  rerouteNote,
  rerouteToast,
  rewriteOpens,
  SLICERS,
  stillOpenNote,
} from './handoff'
import type { OpenFile, Place, Slicer, SlicerOpen } from './handoff'

type Engine = EngineInterface

type Config = { closePrevious: boolean; pattern: RegExp; checkContents: boolean }

let config: Config = { closePrevious: true, pattern: fullSpectrumPattern(undefined), checkContents: true }

/** Quit requests sent to one slicer before giving up (Snapmaker Orca can run several instances). */
const MAX_QUITS = 5
/** The wait after each quit request before counting the instances again. */
const QUIT_WAIT_MS = 1_000
/** A quit that waits on a save dialog holds `osascript`; past this it counts as refused. */
const QUIT_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 15_000

const USAGE = 'Usage: /slice <file> [bambu|snapmaker|orca]. Full-spectrum files always open in Snapmaker Orca; others in Bambu Studio unless you name a slicer.'

async function placeOf($: Engine): Promise<Place> {
  const [cwd, home] = await Promise.all([
    $.session.cwd().catch(() => null),
    $.env.get('HOME').catch(() => undefined),
  ])
  return { cwd: cwd || null, home: home || null }
}

/** Whether a resolved 3MF's project settings name a Full Spectrum filament profile. */
async function contentsSayFullSpectrum($: Engine, file: OpenFile): Promise<boolean> {
  for (const path of contentPaths(file)) {
    const out = await $.process
      .run(['unzip', '-p', path, 'Metadata/project_settings.config'], { timeoutMs: PROBE_TIMEOUT_MS })
      .catch(() => null)
    if (out && out.exitCode === 0) {
      return out.stdout.includes(FULL_SPECTRUM_MARKER)
    }
  }
  return false
}

async function isFullSpectrum($: Engine, file: OpenFile): Promise<boolean> {
  return nameSaysFullSpectrum(file, config.pattern) || (config.checkContents && (await contentsSayFullSpectrum($, file)))
}

async function countRunning($: Engine, slicer: Slicer): Promise<number> {
  const out = await $.process.run(['pgrep', '-x', SLICERS[slicer].process], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
  return out && out.exitCode === 0 ? countPids(out.stdout) : 0
}

/** One normal quit request (never a kill); false when it was refused or is still waiting on a dialog. */
async function askToQuit($: Engine, slicer: Slicer): Promise<boolean> {
  const out = await $.process.run(['osascript', '-e', quitScript(slicer)], { timeoutMs: QUIT_TIMEOUT_MS }).catch(() => null)
  return out !== null && out.exitCode === 0
}

/**
 * Gently quits a slicer's running instances: up to MAX_QUITS normal quit requests while any
 * remain, a second apart, stopping early at one that refuses (its save dialog was cancelled or is
 * still up). Answers how many went away and how many are left.
 */
async function closeRunning($: Engine, slicer: Slicer): Promise<{ closed: number; left: number }> {
  const before = await countRunning($, slicer)
  let running = before
  for (let attempt = 0; attempt < MAX_QUITS && running > 0; attempt++) {
    const isAccepted = await askToQuit($, slicer)
    await $.clock.sleep(QUIT_WAIT_MS)
    running = await countRunning($, slicer)
    if (!isAccepted && running > 0) {
      break
    }
  }
  return { closed: Math.max(0, before - running), left: running }
}

/** Closes a slicer's previous instances before a file opens in it; the note for the model when some stay open. */
async function closeBeforeOpening($: Engine, slicer: Slicer, name: string): Promise<string | null> {
  const { closed, left } = await closeRunning($, slicer)
  if (closed > 0) {
    $.ui.toast(closedToast(slicer, closed, name))
  }
  return left > 0 ? stillOpenNote(slicer, left) : null
}

/** The full-spectrum files among an open's, by name first and then by contents. */
async function fullSpectrumFiles($: Engine, open: SlicerOpen): Promise<OpenFile[]> {
  const found: OpenFile[] = []
  for (const file of open.files) {
    if (await isFullSpectrum($, file)) {
      found.push(file)
    }
  }
  return found
}

async function slice($: Engine, args: string): Promise<string> {
  const { file, wanted } = parseSliceArgs(args, await placeOf($))
  if (!file) {
    return USAGE
  }
  if (!file.path) {
    return `slicer-handoff: could not resolve ${file.written} to a file path. ${USAGE}`
  }
  if (!(await $.fs.exists(file.path).catch(() => false))) {
    return `slicer-handoff: no such file: ${file.path}`
  }
  const name = fileName(file)
  const isFs = await isFullSpectrum($, file)
  const slicer: Slicer = isFs ? 'snapmaker' : (wanted ?? 'bambu')
  const { label, bundle } = SLICERS[slicer]
  const lines: string[] = []
  if (isFs) {
    lines.push(
      wanted && wanted !== 'snapmaker'
        ? `${name} is a full-spectrum file, which ${SLICERS[wanted].label} cannot open: using Snapmaker Orca.`
        : `${name} is a full-spectrum file: using Snapmaker Orca.`,
    )
  }
  if (config.closePrevious) {
    const { closed, left } = await closeRunning($, slicer)
    if (closed > 0) {
      lines.push(`Closed ${closed} previous ${label} window(s).`)
    }
    if (left > 0) {
      lines.push(`${left} ${label} instance(s) still open, probably asking to save; left as they are.`)
    }
  }
  const out = await $.process.run(['open', '-b', bundle, file.path], { timeoutMs: OPEN_TIMEOUT_MS }).catch(() => null)
  lines.push(
    out && out.exitCode === 0
      ? `Opened ${file.path} in ${label}.`
      : `Could not open ${file.path} in ${label}: ${out?.stderr.trim() || 'open failed'}`,
  )
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  config = {
    closePrevious: options.closePrevious !== false,
    pattern: fullSpectrumPattern(options.fullSpectrumPattern),
    checkContents: options.checkContents !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'slice',
      description: 'Open a model in the right slicer: Snapmaker Orca for full-spectrum files, else Bambu Studio',
      argumentHint: '<file> [bambu|snapmaker|orca]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!mentionsOpen(e.command)) {
      return next(e)
    }
    const opens = findSlicerOpens(e.command, await placeOf($))
    if (opens.length === 0) {
      return next(e)
    }
    const notes: string[] = []
    const rerouted: SlicerOpen[] = []
    for (const open of opens) {
      if (open.slicer === 'snapmaker') {
        continue
      }
      const found = await fullSpectrumFiles($, open)
      if (found.length > 0) {
        const names = found.map(fileName)
        rerouted.push(open)
        $.ui.toast(rerouteToast(open.slicer, names))
        notes.push(rerouteNote(open, names))
      }
    }
    if (config.closePrevious) {
      const targets = new Map<Slicer, string>()
      for (const open of opens) {
        const target = rerouted.includes(open) ? 'snapmaker' : open.slicer
        if (!targets.has(target) && open.files[0]) {
          targets.set(target, fileName(open.files[0]))
        }
      }
      for (const [slicer, name] of targets) {
        const note = await closeBeforeOpening($, slicer, name)
        if (note) {
          notes.push(note)
        }
      }
    }
    const command = rewriteOpens(e.command, rerouted, 'snapmaker')
    const ran = await next(command === e.command ? e : { ...e, command })
    if (ran.deny !== undefined || notes.length === 0) {
      return ran
    }
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  })

  on('command.run', { command: 'slice' }, async ($, e) => ({ text: await slice($, e.args) }))
}
