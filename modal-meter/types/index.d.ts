/** One row of `modal app list --json`, read defensively. */
export type ModalApp = {
  /** The app id (`ap-…`), what `modal app stop` takes. */
  id: string
  /** The app's description: its name, or the id when Modal gave none. */
  name: string
  /**
   * Modal's state, lowercased and shortened: `deployed`, `ephemeral`, `detached`
   * (ephemeral, detached), `initializing`, `stopping`, `stopped`, `disabled`, or
   * whatever word a newer CLI prints.
   */
  state: string
  /** Running tasks (containers). */
  containers: number
  /** When the app was created, in epoch ms; null when the CLI did not say. */
  createdAt: number | null
  /** When the app stopped, in epoch ms; null while it has not. */
  stoppedAt: number | null
}

/** `running`: containers up or a live `modal run`; `idle`: deployed with no containers; `stopped`: gone. */
export type ModalAppKind = 'running' | 'idle' | 'stopped'

/** What the meter remembers about one listed app between polls. */
export type ModalTracked = {
  /** Since when it has had containers (null while it has none). */
  busySince: number | null
  /** When it last raised the long-running toast. */
  alertedAt: number | null
}

export type ModalMeter = {
  /** The CLI in use, as typed (`python3 -m modal`); null when none ran. */
  cli: string | null
  /** Why the meter is silent; null while it is reading Modal. */
  problem: string | null
  apps: ModalApp[]
  polledAt: number | null
  /** Today's spend in USD (Modal's UTC day); null when not known. */
  spendToday: number | null
  /** Why spend is not shown; null while it is (or before it was asked). */
  spendNote: string | null
}

/**
 * What one session's poll learned, written to `~/.claude/modal-meter/cache.json` for every
 * session on the machine: the one holding the lock runs the CLI, the others show this.
 */
export type ModalShared = {
  /** The CLI argv that answered (`['python3', '-m', 'modal']`); null when none did. */
  cli: string[] | null
  /** Why there are no apps to show; null when `apps` is the answer. */
  problem: string | null
  apps: ModalApp[]
  /** Today's spend in USD (Modal's UTC day); null when not known. */
  spendToday: number | null
  /** Why spend is not shown; null while it is (or before it was asked). */
  spendNote: string | null
  /** When `billing report` was last run, by any session; null when never. */
  spendAskedAt: number | null
  /** How long after `spendAskedAt` to ask again: five minutes, or an hour after a failure. */
  spendWaitMs: number
  /** When a session learned this CLI has no `billing report`; null while it has one, or none has tried. */
  billingUnsupportedAt: number | null
}

/** The shared cache file: who wrote it when, and how long it is good for (the writer's poll interval). */
export type ModalCache = {
  ts: number
  /** The session that wrote it. */
  by: string
  intervalMs: number
  data: ModalShared
}

/** The shared lock file: the session polling Modal for everyone, and when it last started a poll. */
export type ModalLock = {
  ts: number
  by: string
}

/** What `$.store` remembers under `project:<cwd>`: whether the project uses Modal, and when that was checked. */
export type ModalProject = {
  usesModal: boolean
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'modal-meter': {
      meter: ModalMeter
      tracked: Record<string, ModalTracked>
      /** The app whose Stop was pressed and now waits for Confirm. */
      confirming: string | null
      /** The app a confirmed stop is running for. */
      stopping: string | null
      /** The UTC day the budget toast was shown for. */
      budgetDay: string | null
      /** Whether this session reads Modal: the project uses it, the person asked, or alwaysPoll. */
      watching: boolean
    }
  }
}
