import type { FsEntry, RenderElement } from 'claude-code'

import type { DropFile, DropMark, DropSeen } from '../types'

/** Suffixes browsers and download tools give a file while it is still being written. */
export const PARTIAL_SUFFIXES = ['.crdownload', '.download', '.part', '.tmp', '.opdownload'] as const

export const DEFAULT_FOLDER = '~/Downloads'
export const DEFAULT_EXTENSIONS =
  'pdf,md,txt,csv,json,png,jpg,jpeg,heic,webp,gif,3mf,stl,obj,ply,glb,zip,mp4,mov'

/** Names the band spells out before `+N more`. */
export const BAND_NAMES = 3
/** Files `/downloads` lists. */
export const LIST_LIMIT = 10
/** Files attached or dismissed that are remembered at most. */
const MARK_LIMIT = 500
/** A longer name is shortened in the middle, keeping its end and extension. */
const NAME_MAX = 40

export const USAGE = [
  'Usage:',
  '  /downloads              list the newest files, numbered',
  '  /downloads attach 1 3   put those files in the prompt as @"path" mentions (ranges like 2-4 work)',
  '  /downloads attach       put the new files the band shows in the prompt',
  '  /downloads clear        dismiss every new file; only files that arrive from now on are offered',
].join('\n')

/** `pdf, .MD;3mf` → `['pdf', 'md', '3mf']`; `*` stands for every file. */
export function parseExtensions(text: string): string[] {
  const list = text
    .split(/[\s,;]+/)
    .map(ext => ext.trim().replace(/^\*?\./, '').toLowerCase())
    .filter(Boolean)
  return [...new Set(list)]
}

/** The extension after the last dot, lowercased; '' when there is none (or the name is only a dotfile). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isHiddenName = (name: string): boolean => name.startsWith('.')

export function isPartialName(name: string): boolean {
  const lower = name.toLowerCase()
  return PARTIAL_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

/** Whether the name's extension is wanted; an empty list or `*` wants every file. */
export function hasExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.length === 0 || extensions.includes('*') || extensions.includes(extensionOf(name))
}

/** A regular file of a wanted type that is neither hidden nor a partial download. */
export function isMatching(entry: FsEntry, extensions: readonly string[]): boolean {
  return (
    entry.kind === 'file' &&
    !isHiddenName(entry.name) &&
    !isPartialName(entry.name) &&
    hasExtension(entry.name, extensions)
  )
}

export const markKey = (file: { name: string; mtimeMs: number }): string => `${file.mtimeMs}:${file.name}`

export const markOf = (file: DropFile): DropMark => ({ name: file.name, mtimeMs: file.mtimeMs })

export type NewRules = {
  extensions: readonly string[]
  /** Only files modified after this count. */
  since: number
  now: number
  /** A file modified longer ago than this never counts. */
  maxAgeMs: number
  /** Files already attached or dismissed. */
  cleared: readonly DropMark[]
}

/**
 * The entries that may be new downloads: matching, non-empty, modified after `since` and within
 * `maxAgeMs`, not attached or dismissed already, and with no partial download of the same name
 * beside them (Firefox writes an empty `name` next to `name.part`).
 */
export function newCandidates(entries: readonly FsEntry[], rules: NewRules): FsEntry[] {
  const names = new Set(entries.map(entry => entry.name))
  const cleared = new Set(rules.cleared.map(markKey))
  return entries.filter(
    entry =>
      isMatching(entry, rules.extensions) &&
      entry.size > 0 &&
      entry.mtimeMs > rules.since &&
      rules.now - entry.mtimeMs <= rules.maxAgeMs &&
      !PARTIAL_SUFFIXES.some(suffix => names.has(entry.name + suffix)) &&
      !cleared.has(markKey(entry)),
  )
}

/**
 * Splits this check's candidates into the ones whose size and time the previous check already saw
 * (ready) and the rest (still settling, or still downloading); `seen` is what the next check compares to.
 */
export function settle(
  candidates: readonly FsEntry[],
  previous: ReadonlyMap<string, DropSeen>,
): { ready: FsEntry[]; seen: Map<string, DropSeen> } {
  const seen = new Map<string, DropSeen>()
  const ready: FsEntry[] = []
  for (const entry of candidates) {
    const before = previous.get(entry.name)
    if (before !== undefined && before.size === entry.size && before.mtimeMs === entry.mtimeMs) {
      ready.push(entry)
    }
    seen.set(entry.name, { size: entry.size, mtimeMs: entry.mtimeMs })
  }
  return { ready, seen }
}

/** Marks still able to hide a file: modified after `since` and within `maxAgeMs`, the newest kept. */
export function pruneMarks(marks: readonly DropMark[], since: number, now: number, maxAgeMs: number): DropMark[] {
  return marks.filter(mark => mark.mtimeMs > since && now - mark.mtimeMs <= maxAgeMs).slice(-MARK_LIMIT)
}

/** The folder setting as an absolute path: `~` is `home`, a relative path is under `home`; null without one. */
export function expandFolder(folder: string, home: string | undefined): string | null {
  const raw = folder.trim() || DEFAULT_FOLDER
  const base = home?.replace(/\/+$/, '')
  let path: string
  if (raw.startsWith('/')) {
    path = raw
  } else if (!base) {
    return null
  } else if (raw === '~' || raw.startsWith('~/')) {
    path = base + raw.slice(1)
  } else {
    path = `${base}/${raw}`
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** `/Users/me/Downloads` → `~/Downloads` when it lies under `home`. */
export function displayFolder(dir: string, home: string | undefined): string {
  const base = home?.replace(/\/+$/, '')
  if (base && (dir === base || dir.startsWith(`${base}/`))) {
    return `~${dir.slice(base.length)}`
  }
  return dir
}

/** The folder's own name, as the band says it: `Downloads`. */
export function folderName(dir: string): string {
  return dir.replace(/\/+$/, '').split('/').pop() || dir
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

export function toDropFile(dir: string, entry: FsEntry): DropFile {
  return { name: entry.name, path: joinPath(dir, entry.name), size: entry.size, mtimeMs: entry.mtimeMs }
}

/** Oldest first, the order they arrived in. */
export function byArrival(files: readonly DropFile[]): DropFile[] {
  return [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
}

/** The `limit` most recently modified matching files, newest first. */
export function newest(entries: readonly FsEntry[], extensions: readonly string[], limit = LIST_LIMIT): FsEntry[] {
  return entries
    .filter(entry => isMatching(entry, extensions))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .slice(0, limit)
}

export function sameFiles(a: readonly DropFile[], b: readonly DropFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, i) => {
      const other = b[i]
      return other !== undefined && file.path === other.path && file.size === other.size && file.mtimeMs === other.mtimeMs
    })
  )
}

export function newestTime(files: readonly DropFile[]): number {
  return files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0)
}

/** `just now`, `2m ago`, `5h ago`, `3d ago`. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return 'just now'
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

/** Bytes as Finder counts them (1000 to a KB): `512 B`, `8.1 KB`, `812 KB`, `2.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** A name of at most `max` characters, shortened in the middle so the extension stays. */
export function shortName(name: string, max = NAME_MAX): string {
  if (name.length <= max) {
    return name
  }
  const tail = 10
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`
}

/** `a.pdf, b.pdf, c.pdf +2 more`. */
export function bandNames(files: readonly DropFile[]): string {
  const names = files
    .slice(0, BAND_NAMES)
    .map(file => shortName(file.name))
    .join(', ')
  const more = files.length - BAND_NAMES
  return more > 0 ? `${names} +${more} more` : names
}

export type BandParts = { lead: string; names: string; age: string }

/** The band's line in its three spans: `New in Downloads: `, the names, ` · 2m ago` (the newest file's age). */
export function bandParts(files: readonly DropFile[], now: number, folder: string): BandParts {
  return { lead: `New in ${folder}: `, names: bandNames(files), age: ` · ${shortAge(now - newestTime(files))}` }
}

export function bandLine(files: readonly DropFile[], now: number, folder: string): string {
  const parts = bandParts(files, now, folder)
  return parts.lead + parts.names + parts.age
}

/** `@"/Users/me/Downloads/a b.pdf" `: quoted, so a path with spaces stays one mention. */
export const mention = (path: string): string => `@"${path}" `

export function mentions(files: readonly DropFile[]): string {
  return files.map(file => mention(file.path)).join('')
}

/** `/downloads`' answer: the files numbered newest first, the new ones marked. */
export function listText(files: readonly DropFile[], fresh: ReadonlySet<string>, now: number, display: string): string {
  const width = String(files.length).length
  const rows = files.map((file, i) => {
    const mark = fresh.has(markKey(file)) ? ' · new' : ''
    return `${String(i + 1).padStart(width + 2)}. ${file.name} · ${formatSize(file.size)} · ${shortAge(now - file.mtimeMs)}${mark}`
  })
  return [`Newest in ${display} (/downloads attach 1 3 puts files in the prompt):`, ...rows].join('\n')
}

/** `1 3`, `1,3`, `2-4` → the numbers, in order and once each; an error when one is not on the list. */
export function parsePicks(text: string, count: number): { picks: number[] } | { error: string } {
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) {
    return { error: 'Name the files by number, as /downloads lists them: /downloads attach 1 3' }
  }
  const picks: number[] = []
  for (const token of tokens) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token)
    if (range === null) {
      return { error: `"${token}" is not a file number.` }
    }
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (to < from) {
      return { error: `"${token}" is not a range from low to high.` }
    }
    for (let n = from; n <= to; n++) {
      if (n < 1 || n > count) {
        return { error: `There is no file ${n}; the list has ${count}.` }
      }
      if (!picks.includes(n)) {
        picks.push(n)
      }
    }
  }
  return { picks }
}

export type DownloadsAction =
  | { kind: 'list' }
  | { kind: 'attach'; picks: string }
  | { kind: 'clear' }
  | { kind: 'help' }

/** What `/downloads <args>` asks for; bare numbers (`/downloads 2`) attach. */
export function parseAction(args: string): DownloadsAction {
  const trimmed = args.trim()
  const [word = '', ...rest] = trimmed.split(/\s+/)
  const verb = word.toLowerCase()
  if (verb === '' || verb === 'list' || verb === 'ls') {
    return { kind: 'list' }
  }
  if (verb === 'attach' || verb === 'add') {
    return { kind: 'attach', picks: rest.join(' ') }
  }
  if (verb === 'clear' || verb === 'dismiss') {
    return { kind: 'clear' }
  }
  if (/^\d/.test(verb)) {
    return { kind: 'attach', picks: trimmed }
  }
  return { kind: 'help' }
}

/**
 * How a fill went: the box took the text, a dialog held the keys, the session has no prompt box
 * (a headless run), or a hook kept it out.
 */
export type AttachOutcome = 'filled' | 'dialog' | 'no_composer' | 'refused'

const NOT_TAKEN: Record<Exclude<AttachOutcome, 'filled'>, string> = {
  dialog: 'A dialog has the keys, so the files were not put in the prompt.',
  no_composer: 'There is no prompt box in this session, so the files were not put in it.',
  refused: 'The prompt box did not take the files.',
}

/** `/downloads attach`'s answer: what went into the prompt, or the mentions to paste by hand. */
export function attachedText(files: readonly DropFile[], outcome: AttachOutcome): string {
  if (outcome !== 'filled') {
    return `${NOT_TAKEN[outcome]} Paste these instead:\n${mentions(files).trimEnd()}`
  }
  const names = files.map(file => file.name).join(', ')
  return `Put ${files.length} ${files.length === 1 ? 'file' : 'files'} in the prompt: ${names}`
}

/** True for what the engine draws when nobody else draws the band, or an empty Box. */
export function isBlankTree(tree: RenderElement): boolean {
  if (tree.type === 'engine') {
    return true
  }
  return tree.type === 'Box' && (tree.children ?? []).length === 0
}
