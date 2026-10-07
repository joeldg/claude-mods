/** A PR's checks summed up: any failed ✗, any still running …, all passed ✓, none at all ''. */
export type Ci = '✓' | '✗' | '…' | ''

export type Commit = { sha: string; when: string; author: string; subject: string }

export type PullRequest = { number: number; title: string; branch: string; ci: Ci; isDraft: boolean }

export type FocusIssue = { number: number; title: string; labels: string[] }

/** Files `git status` lists, by kind; a file both staged and edited again counts in both. */
export type Changed = { staged: number; unstaged: number; untracked: number; conflicted: number; total: number }

export type Snapshot = {
  at: number
  /** False when the session's folder is not inside a git work tree: nothing else is gathered. */
  isRepo: boolean
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null
  /** The branch's upstream (`origin/main`); null when it has none. */
  upstream: string | null
  /** True when the upstream is configured but its remote branch was deleted. */
  isUpstreamGone: boolean
  ahead: number
  behind: number
  changed: Changed
  /** The first changed files as `git status --porcelain` shows them (`XY path`). */
  changedPaths: string[]
  commits: Commit[]
  /** The default branch the merged check ran against (`origin/main`); null when none was found. */
  defaultBranch: string | null
  /** Local branches whose upstream is gone, then ones already merged into the default branch. */
  staleBranches: string[]
  /** Linked worktrees besides the main one. */
  worktrees: number
  /** True when `gh` answered for a GitHub remote; PRs and issues are empty otherwise. */
  ghOk: boolean
  prs: PullRequest[]
  issueCount: number
  focusIssues: FocusIssue[]
}

declare module 'claude-code' {
  interface PluginState {
    'repo-brief': { snapshot: Snapshot | null; isHidden: boolean }
  }
}
