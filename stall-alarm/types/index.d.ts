/** One tool call Claude is stopped on: a permission dialog (`ok`) or a question for the person (`question`). */
export type StallWait = {
  /** When the wait began, in `$.clock.now()` milliseconds. */
  since: number
  kind: 'ok' | 'question'
  /** What it waits on: `Bash git push origin main`, or the question asked. */
  label: string
  /** When its last alarm fired; null until the first. */
  alarmedAt: number | null
  /** How many alarms it has raised. */
  alarms: number
}

/** One alarm raised in this session, as /stalls lists them. */
export type StallAlarm = {
  at: number
  message: string
}

/** What the session is and what it waits on. */
export type StallSession = {
  /** Decided by the first prompt: whether this is a scheduled routine run. */
  isDecided: boolean
  isRoutine: boolean
  /** `/stalls off` for this session. */
  isOff: boolean
  /** The name of the folder the session runs in, for the notification's title; '' when unknown. */
  folder: string
  /** The waits still open, by tool_use_id. */
  waiting: Record<string, StallWait>
  /** The last alarms, oldest first, at most 10. */
  alarms: StallAlarm[]
}

/** The plugin's settings, as /stalls describes them. */
export type StallSettings = {
  stallMinutes: number
  /** Minutes between a permission dialog's repeat alarms; 0: it alarms once. */
  repeatMinutes: number
  /** Minutes between a question's repeat alarms; 0: it alarms once. */
  questionRepeatMinutes: number
  /** How many times at most a question alarms again after its first alarm; 0: it alarms once. */
  questionRepeats: number
  notifyMac: boolean
  notifyCommand: string
  alarmOnAnyError: boolean
  skipRoutines: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'stall-alarm': { session: StallSession }
  }
}
