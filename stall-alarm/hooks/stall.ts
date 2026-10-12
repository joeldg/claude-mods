import type { StallSession, StallSettings, StallWait } from '../types'

/** The tag a scheduled task's prompt carries; routine-watch's own test for a routine run. */
const TAG = /<scheduled-task\b/

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
 * Whether the session's first prompt starts a scheduled routine, decided the
 * way routine-watch decides it: the scheduled-task tag in the text, or a prompt
 * the engine says a schedule fired. Those sessions are routine-watch's to watch.
 */
export const isRoutinePrompt = (text: string, originKind: string): boolean =>
  TAG.test(text) || originKind === 'scheduled-trigger'

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

/** A short label for a tool call: the tool and what it touches (`Bash git push origin main`). */
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

/** The last part of a folder's path (`example-app`); '' for none. */
export const folderName = (cwd: string): string => cwd.replace(/\/+$/, '').split('/').pop() ?? ''

/** The notification's title: what happened, and which project when known, since several sessions run at once. */
export const alarmTitle = (head: string, folder: string): string => (folder ? `${head} · ${folder}` : head)

const forWhat = (wait: StallWait): string => (wait.kind === 'ok' ? 'your OK' : 'your answer')

/** `Claude has been waiting 5m for your OK: Bash git push origin main`. */
export const waitMessage = (wait: StallWait, now: number): string =>
  `Claude has been waiting ${formatDuration(now - wait.since)} for ${forWhat(wait)}: ${wait.label}`

/**
 * The waits due an alarm at `now`, oldest first: past the threshold and never
 * alarmed, or alarmed a whole repeat period ago (never again when `repeatMs` is 0).
 */
export const dueAlarms = (waiting: Record<string, StallWait>, now: number, stallMs: number, repeatMs: number): string[] =>
  Object.entries(waiting)
    .filter(([, wait]) =>
      wait.alarmedAt === null ? now - wait.since >= stallMs : repeatMs > 0 && now - wait.alarmedAt >= repeatMs,
    )
    .sort(([, a], [, b]) => a.since - b.since)
    .map(([id]) => id)

/** The open wait that began first, or null. */
export const oldestWait = (waiting: Record<string, StallWait>): StallWait | null => {
  let oldest: StallWait | null = null
  for (const wait of Object.values(waiting)) {
    if (!oldest || wait.since < oldest.since) {
      oldest = wait
    }
  }
  return oldest
}

/** `waiting on you 7m` once the oldest open wait is past the threshold; nothing before. */
export const statusLine = (waiting: Record<string, StallWait>, now: number, stallMs: number): string | undefined => {
  const wait = oldestWait(waiting)
  return wait && now - wait.since >= stallMs ? `waiting on you ${formatDuration(now - wait.since)}` : undefined
}

/** Errors that stop a run until the person acts, in the words the API and the CLI use. */
const KNOWN_ERROR = /OAuth|re-authenticate|\/login|not logged in|usage limit|rate limit|credit balance|overloaded|billing/i
const LOGIN_ERROR = /OAuth|re-authenticate|\/login|not logged in/i
const BILLING_ERROR = /credit balance|billing/i
/** The same errors as Claude Code classifies them (a StopFailure's `error`). */
const LOGIN_KINDS = new Set(['authentication_failed', 'oauth_org_not_allowed'])
const BILLING_KINDS = new Set(['billing_error', 'account_on_hold'])
const OTHER_KNOWN_KINDS = new Set(['rate_limit', 'overloaded', 'verification_required'])

export type ErrorClass = {
  /** Whether it is one the person must act on, so it alarms without alarmOnAnyError. */
  isKnown: boolean
  /** What fixes it, when known: `run /login`, `check billing`. */
  fix: string | null
}

/** What an error that ended a turn is: its text, and its kind when the engine classified it. */
export const classifyError = (text: string, kind: string | null): ErrorClass => {
  const fix =
    LOGIN_ERROR.test(text) || (kind !== null && LOGIN_KINDS.has(kind))
      ? 'run /login'
      : BILLING_ERROR.test(text) || (kind !== null && BILLING_KINDS.has(kind))
        ? 'check billing'
        : null
  const isKnown = fix !== null || KNOWN_ERROR.test(text) || (kind !== null && OTHER_KNOWN_KINDS.has(kind))
  return { isKnown, fix }
}

/** `Claude stopped: <the error's first line>`, and the fix when known, unless the line already says to log in. */
export const errorMessage = (text: string, kind: string | null): string => {
  const { fix } = classifyError(text, kind)
  const line = clip(oneLine(text.split(/\r?\n/).find(part => part.trim() !== '') ?? ''), 160)
  const said = line || (kind ? kind.replace(/_/g, ' ') : 'its turn ended on an error')
  const isSaid = fix === 'run /login' && /\/login/i.test(said)
  return `Claude stopped: ${said}${fix !== null && !isSaid ? ` · ${fix}` : ''}`
}

const times = (count: number): string => (count === 1 ? '1 time' : `${count} times`)

/** The settings as one line, the push command's text left out (it may carry a private topic). */
export const describeSettings = (settings: StallSettings): string =>
  [
    `stall after ${formatDuration(settings.stallMinutes * 60_000)}`,
    settings.repeatMinutes > 0 ? `repeat every ${formatDuration(settings.repeatMinutes * 60_000)}` : 'no repeat',
    `Mac notifications ${settings.notifyMac ? 'on' : 'off'}`,
    `phone push ${settings.notifyCommand.trim() ? 'on' : 'off'}`,
    `any error ${settings.alarmOnAnyError ? 'on' : 'off'}`,
    settings.skipRoutines ? 'routines skipped' : 'routines watched too',
  ].join(' · ')

/** What /stalls prints: the open waits with their ages, the last alarms, the settings. */
export const describeStalls = (session: StallSession, settings: StallSettings, now: number): string => {
  const lines: string[] = []
  if (session.isRoutine && settings.skipRoutines) {
    lines.push('Routine session: left to routine-watch (skipRoutines on).')
  }
  if (session.isOff) {
    lines.push('Alarms are off for this session; /stalls on turns them back on.')
  }
  const open = Object.values(session.waiting).sort((a, b) => a.since - b.since)
  if (open.length === 0) {
    lines.push('No open waits.')
  } else {
    lines.push(
      'Open waits:',
      ...open.map(
        wait =>
          `- ${formatDuration(now - wait.since)} for ${forWhat(wait)}: ${wait.label}` +
          (wait.alarms > 0 ? ` · alarmed ${times(wait.alarms)}` : ''),
      ),
    )
  }
  const alarms = session.alarms.slice(-5).reverse()
  if (alarms.length === 0) {
    lines.push('No alarms yet.')
  } else {
    lines.push('Last alarms:', ...alarms.map(alarm => `- ${formatDuration(now - alarm.at)} ago · ${alarm.message}`))
  }
  lines.push(`Settings: ${describeSettings(settings)}`)
  return lines.join('\n')
}
