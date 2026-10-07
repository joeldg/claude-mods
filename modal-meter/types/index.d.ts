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
    }
  }
}
