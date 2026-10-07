export type JobState = 'running' | 'quiet' | 'stalled' | 'done'

export type Progress = { done: number; total: number; pct: number }

export type Job = {
  id: string
  label: string
  /** The file the job writes to: a background task's .output file or a redirect target. */
  log: string
  /** A substring of the job's command line that `ps` should show while it runs; null when unknown. */
  match: string | null
  /** True once `ps` has shown `match` at least once. */
  seenAlive: boolean
  addedAt: number
  size: number
  changedAt: number
  lastLine: string
  progress: Progress | null
  etaSeconds: number | null
  /** When `etaSeconds` was measured; the pane counts down from there. */
  etaAt: number | null
  /** The first progress reading this ETA is averaged from. */
  baseline: { at: number; done: number } | null
  state: JobState
  finishedAt: number | null
}

export type Disk = { mount: string; freeGB: number; capacityPct: number }

declare module 'claude-code' {
  interface PluginState {
    'job-watch': { jobs: Job[]; disks: Disk[] }
  }
}
