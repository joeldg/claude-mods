import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

import type { DropFile, DropSeen } from '../types'
import type { AttachOutcome } from './drop'
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_FOLDER,
  USAGE,
  attachedText,
  bandParts,
  byArrival,
  displayFolder,
  expandFolder,
  folderName,
  isBlankTree,
  listText,
  markKey,
  markOf,
  mentions,
  newCandidates,
  newest,
  newestTime,
  parseAction,
  parseExtensions,
  parsePicks,
  pruneMarks,
  sameFiles,
  settle,
  shortAge,
  toDropFile,
} from './drop'

type Engine = EngineInterface

const pending = atom({ plugin: 'downloads-drop', key: 'pending' } as const, [])
const since = atom({ plugin: 'downloads-drop', key: 'since' } as const, null)
const cleared = atom({ plugin: 'downloads-drop', key: 'cleared' } as const, [])
const listed = atom({ plugin: 'downloads-drop', key: 'listed' } as const, [])

type Config = { folder: string; extensions: string[]; pollMs: number; maxAgeMs: number }

let config: Config = {
  folder: DEFAULT_FOLDER,
  extensions: parseExtensions(DEFAULT_EXTENSIONS),
  pollMs: 5_000,
  maxAgeMs: 120 * 60_000,
}
let timer: { cancel: () => void } | null = null
let isPolling = false
/** What the last check saw of each candidate, by name: a file is offered once a check sees it unchanged. */
let seen: Map<string, DropSeen> = new Map()
/** Bumped by every attach, dismiss and clear, so a check already under way does not put those files back. */
let generation = 0
/** The age the band last showed, so a check redraws it when that changes. */
let ageLabel = ''
let homeDir: string | undefined
let hasHome = false
let hasWarned = false

const numberOr = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** The watched folder as an absolute path; null when it names `~` and HOME is unset. */
async function folderPath($: Engine): Promise<string | null> {
  if (!hasHome) {
    homeDir = await $.env.get('HOME').catch(() => undefined)
    hasHome = true
  }
  return expandFolder(config.folder, homeDir)
}

/** The folder's entries, or null when it cannot be listed (said once, in the debug log). */
async function listFolder($: Engine, dir: string | null) {
  const entries = dir === null ? null : await $.fs.list(dir).catch(() => null)
  if (entries === null && !hasWarned) {
    hasWarned = true
    $.ui.log(`downloads-drop: could not list ${dir ?? config.folder}`, { to: 'debug' })
  }
  return entries
}

/** One check of the folder: the files that have arrived and stopped growing become the band's. */
async function poll($: Engine): Promise<void> {
  if (isPolling) {
    return
  }
  isPolling = true
  try {
    const started = generation
    const dir = await folderPath($)
    const entries = await listFolder($, dir)
    if (dir === null || entries === null) {
      return
    }
    const now = await $.clock.now()
    const start = await read($, since)
    if (start === null) {
      await update($, since, () => now)
      return
    }
    const marks = await read($, cleared)
    const kept = pruneMarks(marks, start, now, config.maxAgeMs)
    if (kept.length !== marks.length) {
      await update($, cleared, list => pruneMarks(list, start, now, config.maxAgeMs))
    }
    const candidates = newCandidates(entries, {
      extensions: config.extensions,
      since: start,
      now,
      maxAgeMs: config.maxAgeMs,
      cleared: kept,
    })
    const settled = settle(candidates, seen)
    seen = settled.seen
    if (started !== generation) {
      return
    }
    const files = byArrival(settled.ready.map(entry => toDropFile(dir, entry)))
    const label = files.length > 0 ? shortAge(now - newestTime(files)) : ''
    if (!sameFiles(await read($, pending), files)) {
      // An attach or dismiss while this check ran wins: its files stay off the band.
      await update($, pending, list => (started === generation ? files : list))
    } else if (files.length > 0 && label !== ageLabel) {
      $.ui.invalidate('ui.render')
    }
    ageLabel = label
  } finally {
    isPolling = false
  }
}

/**
 * Starts the checks once per module load. A reload drops the timer, so the band's drawing and the
 * command call this too; a session the desktop app or another SDK host runs starts with no surface,
 * so its checks start when a surface first draws the band.
 */
function ensureWatching($: Engine): void {
  if (timer !== null) {
    return
  }
  timer = $.clock.every(config.pollMs, () => void poll($))
}

/** Takes files off the band for good (until they are modified again). */
async function forget($: Engine, files: readonly DropFile[]): Promise<void> {
  generation += 1
  const keys = new Set(files.map(markKey))
  await update($, cleared, marks => [...marks.filter(mark => !keys.has(markKey(mark))), ...files.map(markOf)])
  await update($, pending, list => list.filter(file => !keys.has(markKey(file))))
}

/** Puts an @-mention of each file in the prompt box at the cursor; the files leave the band once it took them. */
async function attachFiles($: Engine, files: readonly DropFile[]): Promise<AttachOutcome> {
  const filled = await $.prompt.fill({ text: mentions(files), mode: 'insert' }).catch(() => null)
  if (!filled?.isFilled) {
    return filled?.refusal ?? 'refused'
  }
  await forget($, files)
  return 'filled'
}

async function attachPending($: Engine): Promise<void> {
  const files = await read($, pending)
  if (files.length > 0) {
    await attachFiles($, files)
  }
}

async function dismissPending($: Engine): Promise<void> {
  await forget($, await read($, pending))
}

/** The newest matching files, numbered as /downloads shows them; remembered for /downloads attach. */
async function listFiles($: Engine, dir: string): Promise<DropFile[] | null> {
  const entries = await listFolder($, dir)
  if (entries === null) {
    return null
  }
  const files = newest(entries, config.extensions).map(entry => toDropFile(dir, entry))
  await update($, listed, () => files)
  return files
}

async function listCommand($: Engine): Promise<CommandRunResult> {
  const dir = await folderPath($)
  const shown = dir === null ? config.folder : displayFolder(dir, homeDir)
  const files = dir === null ? null : await listFiles($, dir)
  if (files === null) {
    return { text: `Could not read ${shown}.` }
  }
  if (files.length === 0) {
    return { text: `No ${config.extensions.join(', ')} files in ${shown}.` }
  }
  const fresh = new Set((await read($, pending)).map(markKey))
  return { text: listText(files, fresh, await $.clock.now(), shown) }
}

async function attachCommand($: Engine, picks: string): Promise<CommandRunResult> {
  const dir = await folderPath($)
  const shown = dir === null ? config.folder : displayFolder(dir, homeDir)
  if (!picks.trim()) {
    const files = await read($, pending)
    if (files.length === 0) {
      return { text: `Nothing new in ${shown} to attach. /downloads lists the newest files by number.` }
    }
    return { text: attachedText(files, await attachFiles($, files)) }
  }
  let files = await read($, listed)
  if (files.length === 0 && dir !== null) {
    files = (await listFiles($, dir)) ?? []
  }
  if (files.length === 0) {
    return { text: `No ${config.extensions.join(', ')} files in ${shown} to attach.` }
  }
  const parsed = parsePicks(picks, files.length)
  if ('error' in parsed) {
    return { text: parsed.error }
  }
  const chosen = parsed.picks.flatMap(n => files[n - 1] ?? [])
  const present: DropFile[] = []
  const missing: string[] = []
  for (const file of chosen) {
    if (await $.fs.exists(file.path).catch(() => false)) {
      present.push(file)
    } else {
      missing.push(file.name)
    }
  }
  const gone = missing.length > 0 ? `\n(No longer in ${shown}: ${missing.join(', ')}; /downloads lists it afresh.)` : ''
  if (present.length === 0) {
    return { text: `Nothing to attach.${gone}` }
  }
  return { text: attachedText(present, await attachFiles($, present)) + gone }
}

/** Dismisses every file offered so far: from now on only files modified after this moment count. */
async function clearAll($: Engine): Promise<CommandRunResult> {
  generation += 1
  const now = await $.clock.now()
  const count = (await read($, pending)).length
  seen = new Map()
  ageLabel = ''
  await update($, since, () => now)
  await update($, cleared, () => [])
  await update($, pending, () => [])
  const what = count === 0 ? 'Nothing new to dismiss' : `Dismissed ${count} new ${count === 1 ? 'file' : 'files'}`
  return { text: `${what}; only files that arrive from now on will be offered.` }
}

export const register: Register = (on, options) => {
  config = {
    folder: String(options.folder ?? DEFAULT_FOLDER).trim() || DEFAULT_FOLDER,
    extensions: parseExtensions(String(options.extensions ?? DEFAULT_EXTENSIONS)),
    pollMs: Math.min(3600, Math.max(1, numberOr(options.pollSeconds, 5))) * 1000,
    maxAgeMs: Math.max(1, numberOr(options.maxAgeMinutes, 120)) * 60_000,
  }
  timer = null
  isPolling = false
  seen = new Map()
  generation = 0
  ageLabel = ''
  homeDir = undefined
  hasHome = false
  hasWarned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'downloads',
      description: 'List the newest files in Downloads, put some in the prompt (attach 1 3), or dismiss the new ones (clear)',
      argumentHint: '[attach <n…> | clear]',
    })
    const now = await $.clock.now()
    await update($, since, () => now)
    if (e.isInteractive) {
      ensureWatching($)
    }
    return next(e)
  })

  on('command.run', { command: 'downloads' }, async ($, e) => {
    ensureWatching($)
    const action = parseAction(e.args)
    if (action.kind === 'attach') {
      return attachCommand($, action.picks)
    }
    if (action.kind === 'clear') {
      return clearAll($)
    }
    if (action.kind === 'help') {
      return { text: USAGE }
    }
    return listCommand($)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    ensureWatching($)
    const files = await read($, pending)
    if (e.props.hasSurvey || files.length === 0) {
      return next(e)
    }
    const now = await $.clock.now()
    const dir = await folderPath($)
    const parts = bandParts(files, now, folderName(dir ?? config.folder))
    const { Box, Text, Button } = $.ui.resolve(e)
    const band = (
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{parts.lead}</Text>
            {parts.names}
            <Text dimColor>{parts.age}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Button key="attach" label="Attach" hotkey="a" variant="primary" onPress={() => attachPending($)} />
          <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => dismissPending($)} />
        </Box>
      </Box>
    )
    // Another plugin's band beneath stays, under this one.
    const below = await next(e)
    return isBlankTree(below) ? (
      band
    ) : (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
