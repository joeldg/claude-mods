/**
 * The PR's checks as a whole: any failure fails it, then anything still running keeps it pending;
 * `unknown` when gh's token could not read the checks (the PR was read without them).
 */
export type Ci = 'pending' | 'pass' | 'fail' | 'none' | 'unknown'

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
  /**
   * True when this session opened the PR (`gh pr create`) or the person added it (/prs watch); false
   * when it was adopted from the repository at start. Only an own PR's CI flips toast, unless the
   * PR's branch is the one this worktree has checked out (or toastAdoptedCi asks for every PR's).
   */
  isOwn: boolean
  addedAt: number
}

/** What Claude passes the prs_status tool: one watched PR by number, or nothing for every watched PR. */
export type PrsStatusInput = { number?: number }

declare module 'claude-code' {
  interface PluginState {
    'pr-autopilot': { prs: WatchedPr[] }
  }
  interface McpToolInputs {
    'mcp__pr-autopilot__prs_status': PrsStatusInput
  }
}
