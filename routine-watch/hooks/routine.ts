import type { RoutineRun, RoutineSettings } from '../types'

/** The name a routine gets when its prompt carries no name of its own. */
export const UNNAMED = 'scheduled task'

const TAG = /<scheduled-task\b/
const NAME = /<scheduled-task\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** Control characters (C0, DEL) and the Unicode line and paragraph separators. */
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029

/** Collapses runs of whitespace and control characters to one space. */
const oneLine = (text: string): string =>
  Array.from(text, char => (isControl(char.charCodeAt(0)) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

/** Cuts text to `max` characters, marking the cut with an ellipsis. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * The routine's name when `text` is a scheduled task's prompt
 * (`<scheduled-task name="daily-report" file="…">`), else null. A tag with no
 * name is still a routine, called "scheduled task".
 */
export const routineName = (text: string): string | null => {
  if (!TAG.test(text)) {
    return null
  }
  const match = NAME.exec(text)
  const raw = match?.[1] ?? match?.[2] ?? ''
  const name = oneLine(raw.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_all, entity: string) => ENTITIES[entity] ?? ''))
  return name ? clip(name, 60) : UNNAMED
}

/**
 * Whether the session's first prompt starts a routine, and its name: the
 * scheduled-task tag in the text, or else a prompt the engine says a schedule
 * fired (`scheduled-trigger`).
 */
export const detectRoutine = (text: string, originKind: string): string | null =>
  routineName(text) ?? (originKind === 'scheduled-trigger' ? UNNAMED : null)

/**
 * `text` as an AppleScript string literal: backslashes and double quotes
 * escaped, control characters and line breaks turned into spaces.
 */
export const appleScriptString = (text: string): string =>
  `"${oneLine(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The argv that posts a macOS notification with a sound; argv, so no shell reads it. */
export const osascriptArgv = (title: string, message: string): string[] => [
  'osascript',
  '-e',
  `display notification ${appleScriptString(clip(message, 240))} with title ${appleScriptString(clip(title, 100))} sound name "Glass"`,
]

/**
 * The argv for the person's push command: the template split on whitespace,
 * then `{title}` and `{message}` filled into the words that name them, so each
 * value stays inside one argument whatever it holds. Null when no command is set.
 */
export const commandArgv = (template: string, values: { title: string; message: string }): string[] | null => {
  const words = template.trim().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) {
    return null
  }
  return words.map(word =>
    word.replace(/\{(title|message)\}/g, (_all, key: string) => (key === 'title' ? values.title : values.message)),
  )
}

/** The host a URL names, without `www.`; the URL itself, cut short, when it names none. */
export const hostOf = (url: string): string => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url.trim())
  const host = match?.[1]?.toLowerCase().replace(/^www\./, '') ?? ''
  return host || clip(oneLine(url), 60)
}

const fileName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

const field = (input: unknown, key: string): string | null => {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** A short label for a tool call: the tool and what it touches (`WebFetch example.com`). */
export const describeCall = (tool: string, input: unknown): string => {
  const url = field(input, 'url')
  const query = field(input, 'query')
  const command = field(input, 'command')
  const path = field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
  const detail = url
    ? hostOf(url)
    : query
      ? `"${clip(oneLine(query), 60)}"`
      : command
        ? clip(oneLine(command), 60)
        : path
          ? fileName(path)
          : ''
  return detail ? `${tool} ${detail}` : tool
}

/** The first question an AskUserQuestion call puts to the person, cut short. */
export const firstQuestion = (input: unknown): string => {
  const questions = typeof input === 'object' && input !== null ? (input as { questions?: unknown }).questions : undefined
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
  const text = field(first, 'question')
  return text ? clip(oneLine(text), 120) : 'a question'
}

/** A duration as people say it: `45s`, `23m`, `1h05m`. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** The open wait that began first, or null. */
export const oldestWait = (run: RoutineRun): { since: number; label: string } | null => {
  let oldest: { since: number; label: string } | null = null
  for (const wait of Object.values(run.waiting)) {
    if (!oldest || wait.since < oldest.since) {
      oldest = wait
    }
  }
  return oldest
}

/** `routine: <name>`, or `routine: <name> · waiting on you 3m` while a wait is open. */
export const statusLine = (run: RoutineRun, now: number): string => {
  const wait = oldestWait(run)
  if (!wait) {
    return `routine: ${run.name}`
  }
  const waited = now - wait.since
  return `routine: ${run.name} · waiting on you ${waited < 60_000 ? '<1m' : formatDuration(waited)}`
}

const times = (count: number): string => (count === 1 ? '1 time' : `${count} times`)

/** The notification a routine's end sends: how long it ran and how often it waited on the person. */
export const finishMessage = (run: RoutineRun, now: number): string =>
  `Routine ${run.name} finished after ${formatDuration(now - run.startedAt)} · ` +
  (run.waits === 0 ? 'never waited on you' : `waited on you ${times(run.waits)}`)

/** The settings as one line, the push command's text left out (it may carry a private topic). */
export const describeSettings = (settings: RoutineSettings): string =>
  [
    `Mac notifications ${settings.notifyMac ? 'on' : 'off'}`,
    settings.allowWebReads ? 'web reads allowed (allowWebReads on)' : 'web reads ask (allowWebReads off)',
    `phone push ${settings.notifyCommand.trim() ? 'on' : 'off'}`,
    `finish notice ${settings.notifyOnFinish ? 'on' : 'off'}`,
  ].join(' · ')

/** What /routine prints. */
export const describeRun = (run: RoutineRun | null, settings: RoutineSettings, now: number): string => {
  const settingsLine = `Settings: ${describeSettings(settings)}`
  if (!run) {
    return ['Not a routine session: routine-watch acts only in scheduled-task runs.', settingsLine].join('\n')
  }
  const wait = oldestWait(run)
  const waits = run.waits === 0 ? 'Has not waited on you' : `Waited on you ${times(run.waits)}`
  return [
    `Routine: ${run.name}`,
    `Started ${formatDuration(now - run.startedAt)} ago`,
    wait ? `${waits} · waiting now for ${formatDuration(now - wait.since)}: ${wait.label}` : waits,
    settingsLine,
  ].join('\n')
}
