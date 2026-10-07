import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  ISSUE_LIMIT,
  PR_LIMIT,
  bandParts,
  branchNames,
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
  summary,
} from './brief'
import type { BandPart } from './brief'

type Engine = EngineInterface

/** The name the brief renders under in the first message's context. */
const BLOCK = 'repoBrief'

const snapshot = atom({ plugin: 'repo-brief', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'repo-brief', key: 'isHidden' } as const, false)

/** How long each git and gh command may take: a background gather, and one the first message waits on. */
type Timing = { gitMs: number; ghMs: number }
const FULL: Timing = { gitMs: 10_000, ghMs: 15_000 }
const QUICK: Timing = { gitMs: 3_000, ghMs: 5_000 }
/** The longest the first message waits for a gather still under way. */
const BRIEF_WAIT_MS = 5_000

const LEAD_START =
  'Repo state when this session started (gathered by the repo-brief mod; run git yourself for anything newer):'
const LEAD_LATER =
  'Repo state at its last refresh (gathered by the repo-brief mod; run git yourself for anything newer):'
const LEAD_NOW = 'Repo state just now (gathered by the repo-brief mod):'

type Config = { focusLabels: string[]; refreshMs: number; briefClaude: boolean }

let config: Config = { focusLabels: ['owner', 'todo', 'P0', 'blocked'], refreshMs: 120_000, briefClaude: true }
let inflight: Promise<Snapshot | null> | null = null
let lastGatherAt = 0
let hasBriefed = false

type GitHub = Pick<Snapshot, 'ghOk' | 'prs' | 'issueCount' | 'focusIssues'>

const NO_GITHUB: GitHub = { ghOk: false, prs: [], issueCount: 0, focusIssues: [] }

/** A command's stdout, or null when it could not start, timed out or exited non-zero. */
async function run($: Engine, cwd: string, argv: readonly string[], timeoutMs: number): Promise<string | null> {
  const out = await $.process.run(argv, { cwd, timeoutMs }).catch(() => null)
  return out && out.exitCode === 0 ? out.stdout : null
}

async function gatherGitHub($: Engine, cwd: string, timing: Timing): Promise<GitHub> {
  const [prJson, issueJson] = await Promise.all([
    run(
      $,
      cwd,
      ['gh', 'pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', 'number,title,headRefName,isDraft,statusCheckRollup'],
      timing.ghMs,
    ),
    run(
      $,
      cwd,
      ['gh', 'issue', 'list', '--state', 'open', '--limit', String(ISSUE_LIMIT), '--json', 'number,title,labels'],
      timing.ghMs,
    ),
  ])
  const prs = prJson === null ? null : parsePrs(prJson)
  if (prs === null) {
    return NO_GITHUB
  }
  const issues = issueJson === null ? null : parseIssues(issueJson, config.focusLabels)
  return { ghOk: true, prs, issueCount: issues?.count ?? 0, focusIssues: issues?.focus ?? [] }
}

async function collect($: Engine, timing: Timing): Promise<Snapshot | null> {
  const previous = await read($, snapshot)
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  lastGatherAt = now
  const git = (...args: string[]) => run($, cwd, ['git', ...args], timing.gitMs)

  const status = await $.process
    .run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '--branch'], { cwd, timeoutMs: timing.gitMs })
    .catch(() => null)
  if (status === null && previous !== null) {
    return previous
  }
  if (status === null || status.exitCode !== 0) {
    const outside = emptySnapshot(now)
    await update($, snapshot, () => outside)
    return outside
  }

  const parsed = parseStatus(status.stdout)
  const [log, branchVv, symbolic, worktreeList, remote] = await Promise.all([
    git('log', '-8', '--format=%h%x09%cr%x09%an%x09%s'),
    git('branch', '-vv'),
    git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
    git('worktree', 'list', '--porcelain'),
    git('remote', 'get-url', 'origin'),
  ])
  const candidates = symbolic?.trim()
    ? null
    : await git(
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes/origin/main',
        'refs/remotes/origin/master',
        'refs/heads/main',
        'refs/heads/master',
      )
  const defaultBranch = pickDefaultBranch(symbolic, candidates)
  const [merged, github] = await Promise.all([
    defaultBranch ? git('branch', '--merged', defaultBranch) : Promise.resolve(null),
    isGitHubRemote(remote) ? gatherGitHub($, cwd, timing) : Promise.resolve(NO_GITHUB),
  ])

  const defaultName = defaultBranch?.replace(/^origin\//, '') ?? ''
  const gone = goneBranches(branchVv ?? '').filter(name => name !== parsed.branch)
  const stale = [...new Set([...gone, ...branchNames(merged ?? '', [defaultName])])]
  const fresh: Snapshot = {
    ...emptySnapshot(now, true),
    ...parsed,
    commits: parseLog(log ?? ''),
    defaultBranch,
    staleBranches: stale,
    worktrees: countWorktrees(worktreeList ?? ''),
    ...github,
  }
  await update($, snapshot, () => fresh)
  return fresh
}

/** Gathers the repo's state into `snapshot`; a gather already under way is shared, not repeated. */
function gather($: Engine, timing: Timing): Promise<Snapshot | null> {
  if (!inflight) {
    inflight = collect($, timing)
      .catch(() => null)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** What `work` resolves to, or null once `ms` has passed first. */
async function within<T>($: Engine, work: Promise<T>, ms: number): Promise<T | null> {
  const stop = new AbortController()
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => null,
    () => null,
  )
  try {
    return await Promise.race([work, timeout])
  } finally {
    stop.abort()
  }
}

/** Starts a background gather when the last one is older than `refreshMinutes`. */
async function refreshIfStale($: Engine) {
  const now = await $.clock.now()
  if (!inflight && now - lastGatherAt >= config.refreshMs) {
    void gather($, FULL)
  }
}

export const register: Register = (on, options) => {
  const minutes = Number(options.refreshMinutes ?? 2)
  config = {
    focusLabels: parseFocusLabels(String(options.focusLabels ?? 'owner,todo,P0,blocked')),
    refreshMs: Math.max(0.25, Number.isFinite(minutes) ? minutes : 2) * 60_000,
    briefClaude: options.briefClaude !== false,
  }
  inflight = null
  lastGatherAt = 0
  hasBriefed = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'brief',
      description: 'Re-gather the repo brief (branch, uncommitted work, commits, PRs, focus issues) and show it',
    })
    void gather($, FULL)
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!config.briefClaude) {
      return result
    }
    const known = await read($, snapshot)
    const current = known ?? (await within($, gather($, QUICK), BRIEF_WAIT_MS))
    if (!current?.isRepo) {
      return result
    }
    const text = summary(current, hasBriefed ? LEAD_LATER : LEAD_START, config.focusLabels)
    hasBriefed = true
    return { ...result, blocks: [...result.blocks.filter(block => block.name !== BLOCK), { name: BLOCK, text }] }
  })

  on('turn.complete', async ($, e, next) => {
    await refreshIfStale($)
    return next(e)
  })

  // Started before the compaction runs, so the context re-read after it finds a fresh snapshot.
  on('session.compact', async ($, e, next) => {
    await refreshIfStale($)
    return next(e)
  })

  on('command.run', { command: 'brief' }, async $ => {
    if (inflight) {
      await inflight
    }
    const current = await gather($, FULL)
    await update($, isHidden, () => false)
    if (current === null) {
      return { text: 'repo-brief: git did not answer, so the repo could not be read.' }
    }
    if (!current.isRepo) {
      return { text: `repo-brief: ${await $.session.cwd()} is not inside a git repository.` }
    }
    return { text: summary(current, LEAD_NOW, config.focusLabels) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, snapshot)
    const hidden = await read($, isHidden)
    if (e.props.hasSurvey || hidden || !current?.isRepo) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const span = (part: BandPart) =>
      part.color ? <Text color={part.color}>{part.text}</Text> : part.dim ? <Text dimColor>{part.text}</Text> : part.text

    return (
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{bandParts(current, config.focusLabels).map(span)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
