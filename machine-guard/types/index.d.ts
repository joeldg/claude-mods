export type Pressure = 'normal' | 'warn' | 'critical'

export type AppMemory = { name: string; gb: number }

export type Snapshot = {
  at: number
  pressure: Pressure
  /** The kernel's own pressure level (kern.memorystatus_vm_pressure_level): 1 normal, 2 warn, 4 critical; null when unread. */
  level: number | null
  /**
   * Unused memory (vm_stat's free + inactive + speculative pages) as a share of the whole; null when vm_stat or
   * the memory size could not be read. Lower than macOS's own "free percentage", which counts active pages too.
   */
  freePct: number | null
  unusedGB: number | null
  totalGB: number | null
  /** What the compressor occupies, and how much memory, uncompressed, that stands for. */
  compressorGB: number | null
  compressedGB: number | null
  swapUsedGB: number
  swapTotalGB: number
  /** GPU use as ioreg last reported it, and when; carried between reads. */
  gpuPct: number | null
  gpuAt: number | null
  /**
   * The CPUs macOS schedules on: all of them normally, fewer while the performance controller parks the
   * performance cores (kern.sched_recommended_cores is the bitmask); null when the read failed.
   */
  cpuTotal: number | null
  cpuRecommended: number | null
  cpuMask: number | null
  /** When the current parking began (the first sample with fewer cores than the Mac has); null while all are in use. */
  cpuParkedSince: number | null
  /** The apps holding the most memory, helpers summed into their app, from the last process table; [] when none is fresh. */
  top: AppMemory[]
  /** When that table was taken, and when one was last tried: ps runs on demand or under pressure, at most once a minute. */
  topAt: number | null
  topTriedAt: number | null
}

/** A reservation made with /busy, kept in ~/.claude/machine-guard.json so every session sees it. */
export type Reservation = { reason: string; until: number; setAt: number }

/**
 * The latest sample, kept in ~/.claude/machine-guard/sample.json: one session probes per interval and the others
 * show what it wrote. `ttlMs` is the sampler's interval (longer after slow probes), `probeMs` how long its probes
 * took, `n` the running count that paces the GPU reads.
 */
export type SharedSample = { ts: number; by: string; ttlMs: number; probeMs: number; n: number; data: Snapshot }

/** Who is probing now, in ~/.claude/machine-guard/lock.json; a lock older than two probe timeouts is abandoned. */
export type SampleLock = { ts: number; by: string }

declare module 'claude-code' {
  interface PluginState {
    'machine-guard': { snapshot: Snapshot | null; pausedUntil: number; coresAnnounced: boolean }
  }
}
