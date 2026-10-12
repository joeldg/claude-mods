/** One tool call the routine is stopped on: a permission ask or a question for the person. */
export type RoutineWait = {
  /** When the wait began, in `$.clock.now()` milliseconds. */
  since: number
  /** What it waits on, e.g. `WebFetch example.com`. */
  label: string
  /** What the person is told when the wait counts, e.g. `Waiting for your OK: WebFetch example.com`. */
  message: string
  /**
   * Whether the person has been told, and the wait counted: at once for a
   * question, after `waitToastAfterSeconds` for a permission ask, which the
   * engine may still decide by itself before then.
   */
  isTold: boolean
}

/** A scheduled-task run in progress in this session. */
export type RoutineRun = {
  /** The task's name, from `<scheduled-task name="…">`. */
  name: string
  /** When the routine's first prompt arrived. */
  startedAt: number
  /** How many times it has stopped to wait on the person: the waits told of. */
  waits: number
  /** The waits still open, by tool_use_id, told of or not yet. */
  waiting: Record<string, RoutineWait>
}

/** What the session is: undecided until its first prompt, then a routine run or not. */
export type RoutineSession = {
  isDecided: boolean
  run: RoutineRun | null
}

/** The plugin's settings, as /routine describes them. */
export type RoutineSettings = {
  notifyMac: boolean
  allowWebReads: boolean
  notifyCommand: string
  notifyOnFinish: boolean
  /** How long a permission ask stands before the person is told, in seconds; 0 tells at once. */
  waitToastAfterSeconds: number
}

declare module 'claude-code' {
  interface PluginState {
    'routine-watch': { session: RoutineSession }
  }
}
