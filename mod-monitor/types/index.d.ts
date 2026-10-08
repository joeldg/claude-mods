/**
 * What a failed link's trace entry said: `skipped` with no reason (it threw
 * before `next`), `kept` (it failed after `next`, that run's result stands),
 * `caught` (its `.catch` answered), `expired` (its budget ran out) or
 * `rejected` (the deepest link that rejected: where the rejection came from).
 */
export type FailureOutcome = 'skipped' | 'kept' | 'caught' | 'expired' | 'rejected'

/** How a mod was first seen this session. */
export type SeenVia = 'plugin.register' | 'command.register' | 'tool.register' | 'trace' | 'origin'

/** Token counts of one model call, as `ModelUsage` reports them. */
export type TokenUsage = { in: number; out: number; cacheRead: number; cacheWrite: number }

export type EventBase = {
  t: 'event'
  /** Milliseconds since the epoch. */
  ts: number
  /** The mod the line is about. */
  plugin: string
  /** How many occurrences the line stands for when repeats within a minute were folded into it (absent: 1). */
  n?: number
  /** When the last folded occurrence happened. */
  last?: number
}

/** One line of a day file about something a mod did or suffered. */
export type EventLine = EventBase &
  (
    | { kind: 'seen'; via: SeenVia; tier?: string; version?: string; provenance?: string }
    | { kind: 'failure'; event: string; outcome: FailureOutcome; ms: number; what: string; reason?: string }
    | { kind: 'slow'; event: string; ms: number }
    | { kind: 'toast'; text: string }
    | { kind: 'status'; text: string }
    | { kind: 'proc-fail'; cmd: string; exit: number | null; ms: number; err?: string }
    | { kind: 'proc-slow'; cmd: string; ms: number }
    | { kind: 'proc-expected'; cmd: string; exit: number | null; why: string }
    | { kind: 'model'; model: string; outcome: string; ms: number; usage?: TokenUsage }
    | { kind: 'write'; dir: string }
    | { kind: 'command'; command: string; hasArgs: boolean; by: string }
    | { kind: 'register'; what: 'command' | 'tool'; name: string }
  )

export type EventKind = EventLine['kind']

/** Slow runs of one event's hook in a flush window, with the session's rough p95 of that hook's time. */
export type SlowStat = { n: number; max: number; p95: number }

/** Per mod, what happened since the previous flush (deltas). */
export type CountsLine = {
  t: 'counts'
  ts: number
  plugin: string
  /** Hook runs per event (drawing is never counted). */
  runs: Record<string, number>
  /** Processes it ran, and how many failed. */
  procs: number
  procFails: number
  /** Files it wrote. */
  writes: number
  toasts: number
  /** Model calls it made. */
  models: number
  slow: Record<string, SlowStat>
  /** Hook failures. */
  fails: number
  /** Runs of its slash commands. */
  cmds: number
  /** Calls of the tools it registered. */
  tools: number
}

export type Line = EventLine | CountsLine

/** What a session keeps in `$.state`, so a reload of the monitor finds its inventory and alerts again. */
export type MonitorBackup = {
  sessionId: string | null
  mods: { name: string; via: SeenVia[]; covered: boolean; tier?: string; version?: string; provenance?: string }[]
  commands: [string, string][]
  tools: [string, string][]
  alerted: string[]
  procAlerted: string[]
  failures: [string, number][]
  statuses: [string, string][]
  noted: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'mod-monitor': {
      /** Bumped when the pane's figures changed; the pane reads it to redraw. */
      tick: number
      /** The mods whose Details are open in the pane. */
      expanded: string[]
      backup: MonitorBackup
    }
  }
}
