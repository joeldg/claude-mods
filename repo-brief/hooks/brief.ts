import type { Changed, Ci, Commit, FocusIssue, PullRequest, Snapshot } from '../types'

/** How many changed files a snapshot keeps by name. */
export const MAX_PATHS = 15
/** How many open PRs and issues `gh` is asked for. */
export const PR_LIMIT = 10
export const ISSUE_LIMIT = 30
/** The longest brief Claude is handed, in characters. */
export const MAX_BRIEF = 2500

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

/** A snapshot with nothing in it: what a folder outside any git work tree gets. */
export const emptySnapshot = (at: number, isRepo = false): Snapshot => ({
  at,
  isRepo,
  branch: null,
  upstream: null,
  isUpstreamGone: false,
  ahead: 0,
  behind: 0,
  changed: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
  changedPaths: [],
  commits: [],
  defaultBranch: null,
  staleBranches: [],
  worktrees: 0,
  ghOk: false,
  prs: [],
  issueCount: 0,
  focusIssues: [],
})

export const parseFocusLabels = (text: string): string[] =>
  text
    .split(',')
    .map(label => label.trim())
    .filter(Boolean)

export type Status = {
  branch: string | null
  upstream: string | null
  isUpstreamGone: boolean
  ahead: number
  behind: number
  changed: Changed
  changedPaths: string[]
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * `git status --porcelain=v1 --branch`: the `## branch...upstream [ahead 1, behind 2]`
 * header, then one `XY path` line per changed file.
 */
export const parseStatus = (output: string): Status => {
  const lines = output.split('\n').filter(line => line.length > 0)
  const header = lines[0]?.startsWith('## ') ? (lines.shift() ?? '').slice(3) : ''
  let branch: string | null = null
  let upstream: string | null = null
  let isUpstreamGone = false
  let ahead = 0
  let behind = 0
  const fresh = header.match(/^(?:No commits yet on|Initial commit on) (\S+)/)
  if (fresh) {
    branch = fresh[1] ?? null
  } else if (header && !header.startsWith('HEAD (no branch)')) {
    const found = header.match(/^(\S+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
    branch = found?.[1] ?? null
    upstream = found?.[2] ?? null
    const tracking = found?.[3] ?? ''
    isUpstreamGone = tracking === 'gone'
    ahead = Number(tracking.match(/ahead (\d+)/)?.[1] ?? 0)
    behind = Number(tracking.match(/behind (\d+)/)?.[1] ?? 0)
  }

  const changed: Changed = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 }
  const changedPaths: string[] = []
  for (const line of lines) {
    const code = line.slice(0, 2)
    if (code === '!!') {
      continue
    }
    changed.total += 1
    if (code === '??') {
      changed.untracked += 1
    } else if (CONFLICTS.has(code)) {
      changed.conflicted += 1
    } else {
      if (code[0] !== ' ') {
        changed.staged += 1
      }
      if (code[1] !== ' ') {
        changed.unstaged += 1
      }
    }
    if (changedPaths.length < MAX_PATHS) {
      changedPaths.push(line)
    }
  }
  return { branch, upstream, isUpstreamGone, ahead, behind, changed, changedPaths }
}

/** `git log --format=%h%x09%cr%x09%an%x09%s`: one commit per line. */
export const parseLog = (output: string): Commit[] =>
  output
    .split('\n')
    .map(line => line.split('\t'))
    .filter(fields => fields.length >= 4 && fields[0])
    .map(([sha = '', when = '', author = '', ...subject]) => ({ sha, when, author, subject: subject.join('\t') }))

/** Local branches `git branch -vv` shows tracking an upstream that no longer exists (`[origin/x: gone]`). */
export const goneBranches = (output: string): string[] =>
  output
    .split('\n')
    .map(line => line.slice(2).match(/^([^\s(]\S*)\s+[0-9a-f]{4,}\s+(?:\([^)]*\)\s+)?\[[^\]]*: gone\]/)?.[1])
    .filter((name): name is string => Boolean(name))

/**
 * Branch names from `git branch` output, leaving out the checked-out one (`* `), any checked
 * out in another worktree (`+ `, work in use), a detached HEAD and the names in `exclude`.
 */
export const branchNames = (output: string, exclude: readonly string[]): string[] =>
  output
    .split('\n')
    .filter(line => line.startsWith('  '))
    .map(line => line.trim())
    .filter(name => name.length > 0 && !name.startsWith('(') && !exclude.includes(name))

/**
 * The default branch to check merges against: `git symbolic-ref --short refs/remotes/origin/HEAD`
 * when it answers, else the first of origin/main, origin/master, main, master that exists.
 */
export const pickDefaultBranch = (symbolicRef: string | null, existingRefs: string | null): string | null => {
  const named = symbolicRef?.trim()
  if (named) {
    return named
  }
  const refs = (existingRefs ?? '').split('\n').map(ref => ref.trim())
  return ['origin/main', 'origin/master', 'main', 'master'].find(ref => refs.includes(ref)) ?? null
}

/** Linked worktrees besides the main one, from `git worktree list --porcelain`. */
export const countWorktrees = (output: string): number =>
  Math.max(0, output.split('\n').filter(line => line.startsWith('worktree ')).length - 1)

export const isGitHubRemote = (url: string | null): boolean => /github\.com[:/]/i.test(url ?? '')

type Check = { status?: string | null; conclusion?: string | null; state?: string | null }

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE'])
const WAITING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

/** A PR's `statusCheckRollup` (CheckRuns and StatusContexts) as one mark: ✗ any failed, … any pending, ✓ the rest. */
export const ciOf = (rollup: readonly Check[] | null | undefined): Ci => {
  const checks = rollup ?? []
  if (checks.length === 0) {
    return ''
  }
  const outcome = (check: Check): string => (check.conclusion || check.state || '').toUpperCase()
  if (checks.some(check => FAILED.has(outcome(check)))) {
    return '✗'
  }
  const isPending = (check: Check): boolean => {
    const status = (check.status ?? '').toUpperCase()
    return (status !== '' && status !== 'COMPLETED') || WAITING.has(outcome(check)) || outcome(check) === ''
  }
  return checks.some(isPending) ? '…' : '✓'
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

type RawPr = { number?: number; title?: string; headRefName?: string; isDraft?: boolean; statusCheckRollup?: Check[] }

/** `gh pr list --json number,title,headRefName,isDraft,statusCheckRollup`; null when it is not that. */
export const parsePrs = (json: string): PullRequest[] | null => {
  const list = parseJson(json)
  if (!Array.isArray(list)) {
    return null
  }
  return (list as RawPr[])
    .filter(pr => typeof pr.number === 'number')
    .map(pr => ({
      number: pr.number ?? 0,
      title: pr.title ?? '',
      branch: pr.headRefName ?? '',
      ci: ciOf(pr.statusCheckRollup),
      isDraft: pr.isDraft === true,
    }))
}

type RawIssue = { number?: number; title?: string; labels?: { name?: string }[] }

/** `gh issue list --json number,title,labels`: how many, and those carrying a focus label. */
export const parseIssues = (
  json: string,
  focusLabels: readonly string[],
): { count: number; focus: FocusIssue[] } | null => {
  const list = parseJson(json)
  if (!Array.isArray(list)) {
    return null
  }
  const wanted = new Set(focusLabels.map(label => label.toLowerCase()))
  const issues = (list as RawIssue[])
    .filter(issue => typeof issue.number === 'number')
    .map(issue => ({
      number: issue.number ?? 0,
      title: issue.title ?? '',
      labels: (issue.labels ?? []).map(label => label.name ?? '').filter(Boolean),
    }))
  return { count: issues.length, focus: issues.filter(issue => issue.labels.some(label => wanted.has(label.toLowerCase()))) }
}

const AGO_UNITS: Record<string, string> = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'mo',
  year: 'y',
}

/** `%cr`'s "2 hours ago" as "2h ago"; "2 years, 3 months ago" keeps its first unit. */
export const shortAgo = (when: string): string => {
  const found = when.match(/^(\d+) (second|minute|hour|day|week|month|year)s?\b/)
  return found ? `${found[1]}${AGO_UNITS[found[2] ?? ''] ?? ''} ago` : when
}

/** The issues' first matching focus label, in the configured order, for the band's count. */
const focusWord = (issues: readonly FocusIssue[], focusLabels: readonly string[]): string => {
  const firstLabel = (issue: FocusIssue) =>
    focusLabels.find(label => issue.labels.some(own => own.toLowerCase() === label.toLowerCase())) ?? 'focus'
  const words = new Set(issues.map(firstLabel))
  return words.size === 1 ? ([...words][0] ?? 'focus') : 'focus'
}

const ciWord: Record<Ci, string> = { '✓': 'CI passing', '✗': 'CI failing', '…': 'CI running', '': 'no CI' }

type Limits = { paths: number; commits: number; prs: number; issues: number; stale: number }

/** Each step lists fewer of everything, until the brief fits MAX_BRIEF. */
const LIMITS: readonly Limits[] = [
  { paths: 15, commits: 8, prs: 10, issues: 10, stale: 12 },
  { paths: 8, commits: 6, prs: 6, issues: 6, stale: 6 },
  { paths: 4, commits: 4, prs: 3, issues: 3, stale: 3 },
]

const more = (shown: number, total: number): string[] => (total > shown ? [`  … and ${total - shown} more`] : [])

const branchLine = (s: Snapshot): string => {
  if (s.branch === null) {
    return `Branch: none, HEAD is detached${s.commits[0] ? ` at ${s.commits[0].sha}` : ''}`
  }
  if (s.upstream === null) {
    return `Branch: ${s.branch} (no upstream: not pushed or not tracking)`
  }
  if (s.isUpstreamGone) {
    return `Branch: ${s.branch}, its upstream ${s.upstream} is gone (deleted on the remote)`
  }
  const drift = [s.ahead > 0 && `ahead ${s.ahead}`, s.behind > 0 && `behind ${s.behind}`].filter(Boolean)
  return `Branch: ${s.branch} tracking ${s.upstream}, ${drift.length > 0 ? drift.join(', ') : 'up to date'}`
}

const changedLine = (changed: Changed): string => {
  if (changed.total === 0) {
    return 'Working tree: clean'
  }
  const kinds = [
    changed.staged > 0 && `${changed.staged} staged`,
    changed.unstaged > 0 && `${changed.unstaged} unstaged`,
    changed.untracked > 0 && `${changed.untracked} untracked`,
    changed.conflicted > 0 && `${changed.conflicted} conflicted`,
  ].filter(Boolean)
  return `Uncommitted: ${plural(changed.total, 'file')} (${kinds.join(', ')})`
}

const briefWith = (s: Snapshot, lead: string, focusLabels: readonly string[], limits: Limits): string => {
  const lines = [lead, branchLine(s), changedLine(s.changed)]
  const paths = s.changedPaths.slice(0, limits.paths)
  lines.push(...paths.map(path => `  ${clip(path, 90)}`), ...more(paths.length, s.changed.total))

  if (s.commits.length > 0) {
    lines.push('Recent commits:')
    lines.push(
      ...s.commits
        .slice(0, limits.commits)
        .map(commit => `  ${commit.sha} ${commit.when}, ${clip(commit.author, 20)}: ${clip(commit.subject, 72)}`),
    )
  }

  if (s.ghOk) {
    if (s.prs.length === 0) {
      lines.push('Open PRs: none')
    } else {
      lines.push(`Open PRs (${s.prs.length}${s.prs.length >= PR_LIMIT ? '+' : ''}):`)
      const prs = s.prs.slice(0, limits.prs)
      lines.push(
        ...prs.map(
          pr =>
            `  #${pr.number} ${pr.ci ? `${pr.ci} ` : ''}${ciWord[pr.ci]}: ${clip(pr.title, 70)} (${clip(pr.branch, 40)}${pr.isDraft ? ', draft' : ''})`,
        ),
        ...more(prs.length, s.prs.length),
      )
    }
    const count = `${s.issueCount}${s.issueCount >= ISSUE_LIMIT ? '+' : ''}`
    const labels = focusLabels.join(', ')
    if (s.focusIssues.length === 0) {
      lines.push(`Open issues: ${count}${labels ? `, none labelled ${labels}` : ''}`)
    } else {
      lines.push(`Open issues: ${count}; labelled ${labels} (${s.focusIssues.length}):`)
      const issues = s.focusIssues.slice(0, limits.issues)
      lines.push(
        ...issues.map(issue => `  #${issue.number} ${clip(issue.title, 70)} [${issue.labels.join(', ')}]`),
        ...more(issues.length, s.focusIssues.length),
      )
    }
  } else {
    lines.push('PRs and issues: not gathered (gh unavailable, or the remote is not GitHub)')
  }

  if (s.staleBranches.length > 0) {
    const shown = s.staleBranches.slice(0, limits.stale)
    const rest = s.staleBranches.length - shown.length
    lines.push(
      `Stale local branches (${s.staleBranches.length}; upstream gone or merged into ${s.defaultBranch ?? 'the default branch'}): ` +
        shown.map(name => clip(name, 40)).join(', ') +
        (rest > 0 ? `, +${rest} more` : ''),
    )
  }
  if (s.worktrees > 0) {
    lines.push(`Worktrees: ${s.worktrees} besides the main one`)
  }
  return lines.join('\n')
}

/** The plain-text brief: branch, uncommitted work, commits, PRs, focus issues, stale branches, under MAX_BRIEF. */
export const summary = (s: Snapshot, lead: string, focusLabels: readonly string[]): string => {
  let text = ''
  for (const limits of LIMITS) {
    text = briefWith(s, lead, focusLabels, limits)
    if (text.length <= MAX_BRIEF) {
      return text
    }
  }
  return `${text.slice(0, text.lastIndexOf('\n', MAX_BRIEF - 2))}\n…`
}

export type BandPart = { text: string; color?: 'red' | 'yellow' | 'green'; dim?: boolean }

const CI_COLOR: Record<Ci, BandPart['color']> = { '✗': 'red', '…': 'yellow', '✓': 'green', '': undefined }

/** The band's one line, in pieces so the CI marks can be colored. */
export const bandParts = (s: Snapshot, focusLabels: readonly string[]): BandPart[] => {
  const groups: BandPart[][] = []

  let head = s.branch ?? `HEAD@${s.commits[0]?.sha ?? 'detached'}`
  if (s.branch !== null && s.upstream === null) {
    head += ' (no upstream)'
  } else if (s.isUpstreamGone) {
    head += ' (upstream gone)'
  }
  head += `${s.ahead > 0 ? ` ↑${s.ahead}` : ''}${s.behind > 0 ? ` ↓${s.behind}` : ''}`
  groups.push([{ text: head }])

  groups.push([{ text: s.changed.total > 0 ? `${s.changed.total} changed` : 'clean' }])
  if (s.changed.conflicted > 0) {
    groups.push([{ text: `${s.changed.conflicted} conflicted`, color: 'red' }])
  }

  if (s.ghOk && s.prs.length > 0) {
    const shown = s.prs.slice(0, 4)
    const prs: BandPart[] = [{ text: 'PRs' }]
    for (const pr of shown) {
      prs.push({ text: ` #${pr.number}` })
      if (pr.ci) {
        prs.push({ text: ` ${pr.ci}`, color: CI_COLOR[pr.ci] })
      }
    }
    if (s.prs.length > shown.length) {
      prs.push({ text: ` +${s.prs.length - shown.length}` })
    }
    groups.push(prs)
  }
  if (s.ghOk && s.focusIssues.length > 0) {
    groups.push([{ text: plural(s.focusIssues.length, `${focusWord(s.focusIssues, focusLabels)} issue`) }])
  }
  if (s.staleBranches.length > 0) {
    groups.push([{ text: plural(s.staleBranches.length, 'stale branch', 'stale branches') }])
  }
  if (s.worktrees > 0) {
    groups.push([{ text: plural(s.worktrees, 'worktree') }])
  }
  if (s.commits[0]) {
    groups.push([{ text: `last commit ${shortAgo(s.commits[0].when)}` }])
  }

  return groups.flatMap((group, index) => (index === 0 ? group : [{ text: ' · ', dim: true }, ...group]))
}

export const bandLine = (parts: readonly BandPart[]): string => parts.map(part => part.text).join('')
