/** The PR's checks as a whole: any failure fails it, then anything still running keeps it pending. */
export type Ci = 'pending' | 'pass' | 'fail' | 'none'

export type PrState = 'open' | 'merged' | 'closed'

export type WatchedPr = {
  number: number
  /** `owner/name` on GitHub. */
  repo: string
  url: string
  title: string
  /** The PR's head branch (`headRefName`). */
  branch: string
  /** The PR's head commit (`headRefOid`); a local branch is deleted only when it points here. */
  headSha: string
  ci: Ci
  /** Names of the failing checks. */
  failing: string[]
  /** GitHub Actions run ids of the failing checks, from their details URLs. */
  runIds: number[]
  state: PrState
  /** True once the post-merge cleanup has run (or was skipped) for this PR. */
  cleaned: boolean
  addedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-autopilot': { prs: WatchedPr[] }
  }
}
