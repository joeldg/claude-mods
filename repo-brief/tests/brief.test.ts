import { expect, test } from 'claude-code/testing'

import {
  MAX_BRIEF,
  bandLine,
  bandParts,
  branchNames,
  ciOf,
  countWorktrees,
  emptySnapshot,
  goneBranches,
  isGitHubRemote,
  parseFocusLabels,
  parseIssues,
  parseLog,
  parsePrs,
  parseStatus,
  pickDefaultBranch,
  shortAgo,
  summary,
} from '../hooks/brief'
import type { Snapshot } from '../types'

const LABELS = ['owner', 'todo', 'P0', 'blocked']
const LEAD = 'Repo state when this session started (gathered by the repo-brief mod; run git yourself for anything newer):'

/** A repo mid-work: ahead and behind, three changed files, two PRs, two owner issues, two stale branches. */
const busy = (): Snapshot => ({
  ...emptySnapshot(0, true),
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 2,
  changed: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0, total: 3 },
  changedPaths: ['M  hooks/register.tsx', ' M README.md', '?? notes.md'],
  commits: [
    { sha: '220cc0c', when: '2 hours ago', author: 'joeldg', subject: 'Add job-watch and machine-guard mods' },
    { sha: '1a2b3c4', when: '3 days ago', author: 'joeldg', subject: 'Initial commit' },
  ],
  defaultBranch: 'origin/main',
  staleBranches: ['old-spike', 'fix/merged'],
  ghOk: true,
  prs: [
    { number: 123, title: 'Fix login redirect', branch: 'fix/login', ci: '✗', isDraft: false },
    { number: 124, title: 'Add repo-brief', branch: 'repo-brief', ci: '✓', isDraft: true },
  ],
  issueCount: 14,
  focusIssues: [
    { number: 12, title: 'Ship the band', labels: ['owner'] },
    { number: 15, title: 'Write the docs', labels: ['owner', 'docs'] },
  ],
})

test('reads branch, upstream and ahead/behind from the status header', () => {
  const status = parseStatus('## main...origin/main [ahead 1, behind 2]\nM  hooks/register.tsx\n M README.md\nMM both.ts\n?? notes.md\nUU clash.ts\n')
  expect(status.branch).toBe('main')
  expect(status.upstream).toBe('origin/main')
  expect(status.ahead).toBe(1)
  expect(status.behind).toBe(2)
  expect(status.changed).toEqual({ staged: 2, unstaged: 2, untracked: 1, conflicted: 1, total: 5 })
  expect(status.changedPaths).toEqual(['M  hooks/register.tsx', ' M README.md', 'MM both.ts', '?? notes.md', 'UU clash.ts'])

  expect(parseStatus('## main...origin/main [behind 3]\n').behind).toBe(3)
  expect(parseStatus('## main...origin/main\n').changed.total).toBe(0)
})

test('reads a branch with no upstream, a gone upstream, a detached HEAD and a fresh repo', () => {
  const local = parseStatus('## feature/x\n?? a\n')
  expect(local.branch).toBe('feature/x')
  expect(local.upstream).toBeNull()
  expect(local.ahead).toBe(0)

  const gone = parseStatus('## old...origin/old [gone]\n')
  expect(gone.upstream).toBe('origin/old')
  expect(gone.isUpstreamGone).toBe(true)

  const detached = parseStatus('## HEAD (no branch)\n M x.ts\n')
  expect(detached.branch).toBeNull()
  expect(detached.upstream).toBeNull()
  expect(detached.changed.unstaged).toBe(1)

  expect(parseStatus('## No commits yet on main\n').branch).toBe('main')
})

test('keeps at most 15 changed paths but counts them all', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `?? file${i}.txt`).join('\n')
  const status = parseStatus(`## main\n${lines}\n`)
  expect(status.changedPaths).toHaveLength(15)
  expect(status.changed.total).toBe(20)
})

test('reads git log lines, tabs in the subject kept', () => {
  const log = parseLog('220cc0c\t6 minutes ago\tjoeldg\tAdd mods\n1a2b3c4\t2 weeks ago\tJoel De Gan\tMerge\tpull request #49\n\n')
  expect(log).toEqual([
    { sha: '220cc0c', when: '6 minutes ago', author: 'joeldg', subject: 'Add mods' },
    { sha: '1a2b3c4', when: '2 weeks ago', author: 'Joel De Gan', subject: 'Merge\tpull request #49' },
  ])
  expect(parseLog('')).toEqual([])
})

test('finds branches whose upstream is gone', () => {
  const vv = [
    '* main                 220cc0c [origin/main] Add job-watch and machine-guard mods',
    '  old-spike            1d2c7be [origin/old-spike: gone] Try a thing',
    '  ahead-only           5defc1b [origin/ahead-only: ahead 2] Work: gone] in subject',
    '+ wt-branch            4a05c2c (/Users/me/wt) [origin/wt-branch: gone] Worktree work',
    '  local-only           08feb76 Never pushed',
    '* (HEAD detached at 220cc0c) 220cc0c Add mods',
  ].join('\n')
  expect(goneBranches(vv)).toEqual(['old-spike', 'wt-branch'])
})

test('lists merged branches, leaving out current, worktree and default branches', () => {
  const merged = '  fix/merged\n* feature\n+ in-worktree\n  main\n  (HEAD detached at abc)\n'
  expect(branchNames(merged, ['main'])).toEqual(['fix/merged'])
})

test('picks the default branch', () => {
  expect(pickDefaultBranch('origin/develop\n', null)).toBe('origin/develop')
  expect(pickDefaultBranch(null, 'main\norigin/main\n')).toBe('origin/main')
  expect(pickDefaultBranch(null, 'master\n')).toBe('master')
  expect(pickDefaultBranch(null, '')).toBeNull()
})

test('counts worktrees beyond the main one and spots GitHub remotes', () => {
  const list = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD def\nbranch refs/heads/x\n'
  expect(countWorktrees(list)).toBe(1)
  expect(countWorktrees('worktree /r\nHEAD abc\n')).toBe(0)
  expect(isGitHubRemote('https://github.com/joeldg/claude-mods.git')).toBe(true)
  expect(isGitHubRemote('git@github.com:joeldg/claude-mods.git')).toBe(true)
  expect(isGitHubRemote('https://gitlab.com/x/y.git')).toBe(false)
  expect(isGitHubRemote(null)).toBe(false)
})

test('sums up a CI rollup as ✓, ✗ or …', () => {
  const done = (conclusion: string) => ({ status: 'COMPLETED', conclusion })
  expect(ciOf([done('SUCCESS'), done('SKIPPED'), done('NEUTRAL')])).toBe('✓')
  expect(ciOf([done('SUCCESS'), { status: 'IN_PROGRESS', conclusion: '' }])).toBe('…')
  expect(ciOf([{ status: 'QUEUED', conclusion: null }, done('FAILURE')])).toBe('✗')
  expect(ciOf([done('TIMED_OUT')])).toBe('✗')
  expect(ciOf([done('CANCELLED')])).toBe('✗')
  expect(ciOf([{ state: 'ERROR' }])).toBe('✗')
  expect(ciOf([{ state: 'PENDING' }, { state: 'SUCCESS' }])).toBe('…')
  expect(ciOf([{ state: 'SUCCESS' }])).toBe('✓')
  expect(ciOf([])).toBe('')
  expect(ciOf(null)).toBe('')
})

test('reads gh PR and issue JSON, picking focus-label issues', () => {
  const prs = parsePrs(
    JSON.stringify([
      {
        number: 65,
        title: 'Agent scope tokens',
        headRefName: 'task/50',
        isDraft: false,
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    ]),
  )
  expect(prs).toEqual([{ number: 65, title: 'Agent scope tokens', branch: 'task/50', ci: '✓', isDraft: false }])
  expect(parsePrs('not json')).toBeNull()

  const issues = parseIssues(
    JSON.stringify([
      { number: 1, title: 'A', labels: [{ name: 'p0' }] },
      { number: 2, title: 'B', labels: [{ name: 'bug' }] },
      { number: 3, title: 'C', labels: [] },
    ]),
    LABELS,
  )
  expect(issues).toEqual({ count: 3, focus: [{ number: 1, title: 'A', labels: ['p0'] }] })
  expect(parseFocusLabels(' owner, todo,,P0 ')).toEqual(['owner', 'todo', 'P0'])
})

test('shortens relative dates', () => {
  expect(shortAgo('2 hours ago')).toBe('2h ago')
  expect(shortAgo('6 minutes ago')).toBe('6m ago')
  expect(shortAgo('1 day ago')).toBe('1d ago')
  expect(shortAgo('5 months ago')).toBe('5mo ago')
  expect(shortAgo('2 years, 3 months ago')).toBe('2y ago')
})

test('the brief carries branch, changes, commits, PRs, focus issues and stale branches', () => {
  const text = summary(busy(), LEAD, LABELS)
  expect(text.split('\n')[0]).toBe(LEAD)
  expect(text).toContain('Branch: main tracking origin/main, ahead 1, behind 2')
  expect(text).toContain('Uncommitted: 3 files (1 staged, 1 unstaged, 1 untracked)')
  expect(text).toContain('  M  hooks/register.tsx')
  expect(text).toContain('  220cc0c 2 hours ago, joeldg: Add job-watch and machine-guard mods')
  expect(text).toContain('  #123 ✗ CI failing: Fix login redirect (fix/login)')
  expect(text).toContain('  #124 ✓ CI passing: Add repo-brief (repo-brief, draft)')
  expect(text).toContain('Open issues: 14; labelled owner, todo, P0, blocked (2):')
  expect(text).toContain('  #12 Ship the band [owner]')
  expect(text).toContain('Stale local branches (2; upstream gone or merged into origin/main): old-spike, fix/merged')
})

test('the brief says what gh could not tell and what is clean', () => {
  const text = summary({ ...busy(), ghOk: false, changed: emptySnapshot(0).changed, changedPaths: [] }, LEAD, LABELS)
  expect(text).toContain('Working tree: clean')
  expect(text).not.toContain('Open PRs')
  expect(text).toContain('PRs and issues: not gathered')
})

test('the brief stays under its length bound however much there is', () => {
  const long = 'x'.repeat(200)
  const huge: Snapshot = {
    ...busy(),
    changed: { staged: 0, unstaged: 0, untracked: 400, conflicted: 0, total: 400 },
    changedPaths: Array.from({ length: 15 }, (_, i) => `?? ${long}/${i}`),
    commits: Array.from({ length: 8 }, (_, i) => ({ sha: `abc${i}`, when: '1 day ago', author: long, subject: long })),
    prs: Array.from({ length: 10 }, (_, i) => ({ number: i, title: long, branch: long, ci: '…' as const, isDraft: true })),
    focusIssues: Array.from({ length: 30 }, (_, i) => ({ number: i, title: long, labels: ['owner', long] })),
    staleBranches: Array.from({ length: 50 }, (_, i) => `${long}-${i}`),
  }
  const text = summary(huge, LEAD, LABELS)
  expect(text.length).toBeLessThanOrEqual(MAX_BRIEF)
  expect(text).toContain('… and')
  expect(text.split('\n')[0]).toBe(LEAD)
})

test('the band line is one compact line', () => {
  expect(bandLine(bandParts(busy(), LABELS))).toBe(
    'main ↑1 ↓2 · 3 changed · PRs #123 ✗ #124 ✓ · 2 owner issues · 2 stale branches · last commit 2h ago',
  )
  const colors = bandParts(busy(), LABELS)
    .filter(part => part.color)
    .map(part => `${part.text.trim()}:${part.color}`)
  expect(colors).toEqual(['✗:red', '✓:green'])

  const quiet: Snapshot = { ...emptySnapshot(0, true), branch: 'spike', commits: busy().commits }
  expect(bandLine(bandParts(quiet, LABELS))).toBe('spike (no upstream) · clean · last commit 2h ago')
  const detached: Snapshot = { ...emptySnapshot(0, true), commits: busy().commits, worktrees: 2 }
  expect(bandLine(bandParts(detached, LABELS))).toBe('HEAD@220cc0c · clean · 2 worktrees · last commit 2h ago')
  const mixed: Snapshot = {
    ...busy(),
    focusIssues: [
      { number: 1, title: 'a', labels: ['P0'] },
      { number: 2, title: 'b', labels: ['blocked'] },
    ],
  }
  expect(bandLine(bandParts(mixed, LABELS))).toContain('· 2 focus issues ·')
})
