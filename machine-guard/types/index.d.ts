export type Pressure = 'normal' | 'warn' | 'critical'

export type AppMemory = { name: string; gb: number }

export type Snapshot = {
  at: number
  pressure: Pressure
  /** macOS's "System-wide memory free percentage"; null when it could not be read. */
  freePct: number | null
  swapUsedGB: number
  swapTotalGB: number
  gpuPct: number | null
  /** The apps holding the most memory, helpers summed into their app. */
  top: AppMemory[]
}

/** A reservation made with /busy, kept in ~/.claude/machine-guard.json so every session sees it. */
export type Reservation = { reason: string; until: number; setAt: number }

declare module 'claude-code' {
  interface PluginState {
    'machine-guard': { snapshot: Snapshot | null; pausedUntil: number }
  }
}
