import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register, ToolSpec } from 'claude-code'

import type { WatchedPr } from '../types'
import {
  AUTH_STATUS,
  authToast,
  ciAttachment,
  clip,
  defaultBranchOf,
  describePrs,
  failingRunIds,
  ghFailure,
  gitError,
  holdNote,
  isPermissionFailure,
  mentionedPrs,
  nameWithOwner,
  parsePrUrls,
  parseView,
  parseWorktree,
  repoFromRemote,
  shortSha,
  shouldToastCi,
  statusLine,
  toolReport,
  watchedFrom,
  worktreeHolding,
} from './pr'
import type { GhFailure, PrRef, PrView, Worktree } from './pr'

type Engine = EngineInterface

const prs = atom({ plugin: 'pr-autopilot', key: 'prs' } as const, [])

const VIEW_FIELDS = 'number,url,state,title,headRefName,headRefOid,statusCheckRollup,mergedAt'
const LIST_FIELDS = 'number,url,state,title,headRefName,headRefOid,statusCheckRollup'
/** The checks field, left out of a read while gh's token cannot read it: the rest of a PR it still may. */
const CHECKS_FIELD = 'statusCheckRollup'
const CREATE = /\bgh\s+pr\s+create\b/
/** Prompts the person wrote (typed, through Remote Control, or an SDK host's own turn). */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
/** How many PRs are kept: merged ones beyond this are dropped first. */
const KEEP = 30
/** The tool Claude reads the watched PRs with, as the engine names it, and what `$.tool.register` is handed. */
const TOOL = 'mcp__pr-autopilot__prs_status'
const PRS_STATUS_TOOL: ToolSpec = {
  name: 'prs_status',
  description:
    'The pull requests pr-autopilot watches (opened with `gh pr create` in this session, adopted from this repository at start, or added with /prs watch), as last read: number, title, state, head branch, CI summary and URL. ' +
    "Prefer this over `gh pr view` or `gh pr checks` for a watched PR: it costs no GitHub API call, is at most one poll old, and still answers when gh's token cannot read checks (CI then reads as unknown). " +
    'Pass `number` for one PR.',
  inputSchema: {
    type: 'object',
    properties: { number: { type: 'number', description: 'One watched PR, by number; left out, every watched PR.' } },
    additionalProperties: false,
  },
  isDeferred: false,
}
/** How long polls wait after GitHub's rate limit refused one. */
const RATE_HOLD_MS = 5 * 60_000
/** The longest wait between polls after other failures, each doubling the last. */
const MAX_BACKOFF_MS = 10 * 60_000

type Ran = { ok: boolean; out: string; err: string }
/** What the cleanup did and could not; `ownWorktree` is this linked worktree's root when the merged branch is the one it has checked out (left to the person, with the worktree). */
type Outcome = { steps: string[]; issues: string[]; ownWorktree: string | null }
type Config = {
  pollMs: number
  authRetryMs: number
  deleteRemoteBranch: boolean
  attachCiLogs: boolean
  logLines: number
  /** Toast CI flips of PRs adopted from the repository too, not only own PRs' and those on this worktree's branch. */
  toastAdoptedCi: boolean
}

/** Why a gh run failed, and the line that says so. */
type GhFailed = { kind: GhFailure; detail: string }
/** What a gh command that prints JSON answered: the value, or why it did not. */
type GhJson = { json: unknown; failure: null } | { json: null; failure: GhFailed }
/** One read of a PR: what gh said of it, or why it said nothing. */
type Viewed = { view: PrView | null; failure: GhFailed | null }
/** What one round of reads came to: what gh refused, and how many reads it answered. */
type Reads = { failures: GhFailed[]; answered: number }

/**
 * How gh stands with the polls. `hold` says why they are held back (an auth failure, GitHub's rate
 * limit, another failure backing off) until `holdUntil`. An auth hold still reads the PRs every poll,
 * without their checks, unless `isPlainBlocked`: gh could not read the PRs themselves.
 */
type GhStanding = {
  hold: GhFailure | null
  holdUntil: number
  isPlainBlocked: boolean
  /** The wait after `other` failures: doubled each time up to MAX_BACKOFF_MS, back to pollMs on a success. */
  backoffMs: number
  /** True once this session's one auth toast was shown. */
  hasToasted: boolean
  /** The hold a poll just let go of to try gh again, so a success can say it answers again; null otherwise. */
  released: GhFailure | null
  /** When gh last answered for the watched PRs; null before it has. */
  refreshedAt: number | null
}

let config: Config = {
  pollMs: 60_000,
  authRetryMs: 30 * 60_000,
  deleteRemoteBranch: false,
  attachCiLogs: true,
  logLines: 120,
  toastAdoptedCi: false,
}

const standing = (): GhStanding => ({
  hold: null,
  holdUntil: 0,
  isPlainBlocked: false,
  backoffMs: config.pollMs,
  hasToasted: false,
  released: null,
  refreshedAt: null,
})

let gh: GhStanding = standing()
let timer: { cancel: () => void } | null = null
let polling: Promise<void> | null = null
let isTurnRunning = false
/** The status line last shown; null before the first. */
let shownStatus: string | undefined | null = null
/** The session's folder, to adopt its PRs again when a hold ends with none watched. */
let sessionCwd: string | null = null

const isSame = (a: Pick<WatchedPr, 'repo' | 'number'>, b: Pick<WatchedPr, 'repo' | 'number'>): boolean =>
  a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase()

/** Keeps every open PR and the newest closed or merged ones, KEEP in all. */
const capped = (list: readonly WatchedPr[]): WatchedPr[] => {
  const out = [...list]
  while (out.length > KEEP) {
    const oldDone = out.findIndex(pr => pr.state !== 'open')
    out.splice(oldDone >= 0 ? oldDone : 0, 1)
  }
  return out
}

async function exec($: Engine, argv: readonly string[], cwd?: string, timeoutMs = 30_000): Promise<Ran> {
  const init: ProcessRunInit = {
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    ...(cwd ? { cwd } : {}),
  }
  try {
    const out = await $.process.run(argv, init)
    return { ok: out.exitCode === 0, out: out.stdout, err: out.stderr }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

async function git($: Engine, cwd: string, args: readonly string[], timeoutMs = 30_000): Promise<Ran> {
  return exec($, ['git', ...args], cwd, timeoutMs)
}

async function debug($: Engine, line: string) {
  await $.ui.log(`pr-autopilot: ${line}`, { to: 'debug' })
}

/** gh's own line about what went wrong, short. */
const ghDetail = (ran: Ran): string => gitError(ran.err || ran.out)

/** Holds the polls back until `until`, for `kind`. */
function hold(kind: GhFailure, until: number) {
  gh.hold = kind
  gh.holdUntil = until
  gh.released = null
}

/**
 * gh refused a read over its login or its token's permissions: full reads stop for authRetryMinutes.
 * A read that asked for the checks was refused the checks, which the PRs are still read without; one
 * that did not was refused the PRs themselves, and nothing is read. Said once in the debug log per
 * hold, and once per session to the person, with the fix.
 */
async function holdAuth($: Engine, hadChecks: boolean, detail: string) {
  const now = await $.clock.now()
  const isNew = gh.hold !== 'auth'
  const wasPlainBlocked = gh.isPlainBlocked
  hold('auth', now + config.authRetryMs)
  if (!hadChecks) {
    gh.isPlainBlocked = true
  }
  if (isNew || (!hadChecks && !wasPlainBlocked)) {
    const what = hadChecks ? "can't read checks; the PRs are polled without them" : "can't read PRs; polling held"
    await debug($, `gh ${what} for ${config.authRetryMs / 60_000} min: ${detail}`)
  }
  if (!gh.hasToasted) {
    gh.hasToasted = true
    $.ui.toast(authToast(hadChecks && isPermissionFailure(detail), config.authRetryMs / 60_000), { timeoutMs: 15_000 })
  }
}

/** GitHub's rate limit refused a read: the polls wait RATE_HOLD_MS. */
async function holdRate($: Engine, detail: string) {
  const now = await $.clock.now()
  hold('rate', now + RATE_HOLD_MS)
  await debug($, `gh hit GitHub's rate limit; polling held for ${RATE_HOLD_MS / 60_000} min: ${detail}`)
}

/** A poll failed for another reason: the next waits twice as long as the last, up to MAX_BACKOFF_MS. */
async function holdOther($: Engine, now: number, detail: string) {
  gh.backoffMs = Math.min(gh.backoffMs * 2, MAX_BACKOFF_MS)
  hold('other', now + gh.backoffMs)
  await debug($, `gh failed; polling again in ${gh.backoffMs / 1000}s: ${detail}`)
}

/** Lets the hold go, so the next read is tried in full. */
function release() {
  gh.released = gh.hold
  gh.hold = null
  gh.holdUntil = 0
  gh.isPlainBlocked = false
}

/** gh answered a full read: the polls go back to the configured pace, said once when they had left it. */
async function recover($: Engine) {
  const was = gh.released
  gh.released = null
  if (was !== null || gh.backoffMs !== config.pollMs) {
    gh.backoffMs = config.pollMs
    await debug($, `gh answers again; polling every ${config.pollMs / 1000}s`)
  }
}

/** Runs a gh command that prints JSON; what it refused over auth or the rate limit holds the polls. */
async function ghJson($: Engine, args: readonly string[], cwd?: string): Promise<GhJson> {
  const ran = await exec($, ['gh', ...args], cwd)
  if (!ran.ok) {
    const failure: GhFailed = { kind: ghFailure(ran.out, ran.err), detail: ghDetail(ran) }
    if (failure.kind === 'auth') {
      await holdAuth($, args.some(arg => arg.includes(CHECKS_FIELD)), failure.detail)
    } else if (failure.kind === 'rate') {
      await holdRate($, failure.detail)
    }
    return { json: null, failure }
  }
  try {
    return { json: JSON.parse(ran.out) as unknown, failure: null }
  } catch {
    return { json: null, failure: { kind: 'other', detail: 'gh printed no JSON' } }
  }
}

/**
 * `gh pr view|list … --json <fields>`: read without the checks while gh's token cannot read them, and
 * read again without them the first time it says so.
 */
async function ghPr($: Engine, argvFor: (fields: string) => string[], fields: string, cwd?: string): Promise<GhJson> {
  const plain = fields
    .split(',')
    .filter(field => field !== CHECKS_FIELD)
    .join(',')
  if (gh.hold === 'auth') {
    return ghJson($, argvFor(plain), cwd)
  }
  const got = await ghJson($, argvFor(fields), cwd)
  return got.failure?.kind === 'auth' ? ghJson($, argvFor(plain), cwd) : got
}

async function viewPr($: Engine, ref: string, repo: string | null): Promise<Viewed> {
  const got = await ghPr($, fields => ['pr', 'view', ref, ...(repo ? ['--repo', repo] : []), '--json', fields], VIEW_FIELDS)
  const view = parseView(got.json)
  return { view, failure: got.failure ?? (view ? null : { kind: 'other', detail: 'gh printed no PR' }) }
}

async function showStatus($: Engine) {
  const line = gh.isPlainBlocked ? AUTH_STATUS : statusLine(await read($, prs))
  if (line !== shownStatus) {
    shownStatus = line
    $.ui.status(line)
  }
}

/** Whether a tick may poll now: not under a hold, except an auth hold that still reads the PRs without their checks. */
const isDue = (now: number): boolean => gh.hold === null || now >= gh.holdUntil || (gh.hold === 'auth' && !gh.isPlainBlocked)

async function tick($: Engine) {
  if (isDue(await $.clock.now())) {
    await poll($)
  }
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void tick($))
  }
}

async function patch($: Engine, pr: WatchedPr, changes: Partial<WatchedPr>) {
  await update($, prs, list => list.map(one => (isSame(one, pr) ? { ...one, ...changes } : one)))
}

/**
 * Watches a PR, or refreshes what is known of one already watched (its CI state stays the poll's to
 * change). `isOwn` for a PR this session opened or the person added: one adopted earlier becomes own.
 */
async function remember($: Engine, ref: PrRef, view: PrView | null, isOwn: boolean) {
  const now = await $.clock.now()
  const fresh = watchedFrom(ref, view, now, isOwn)
  await update($, prs, list => {
    const known = list.find(one => isSame(one, ref))
    if (!known) {
      return capped([...list, fresh])
    }
    const facts = view ? { title: fresh.title, branch: fresh.branch, headSha: fresh.headSha, url: fresh.url } : {}
    return list.map(one => (one === known ? { ...one, ...facts, isOwn: one.isOwn || isOwn } : one))
  })
  if (view) {
    gh.refreshedAt = now
  }
  ensureTimer($)
}

/** Adopts the person's open PRs in the session's repository, when it is a GitHub repository; what gh refused, if anything. */
async function adopt($: Engine, cwd: string): Promise<GhFailed | null> {
  try {
    const inside = await git($, cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok) {
      return null
    }
    const named = await ghJson($, ['repo', 'view', '--json', 'nameWithOwner'], cwd)
    const repo = nameWithOwner(named.json)
    if (!repo) {
      return named.failure ?? { kind: 'other', detail: 'gh named no GitHub repository' }
    }
    const listed = await ghPr(
      $,
      fields => ['pr', 'list', '--author', '@me', '--state', 'open', '--json', fields, '--limit', '20'],
      LIST_FIELDS,
      cwd,
    )
    if (listed.failure) {
      return listed.failure
    }
    for (const item of Array.isArray(listed.json) ? listed.json : []) {
      const view = parseView(item)
      if (view?.number) {
        await remember($, { repo, number: view.number, url: view.url }, view, false)
      }
    }
    gh.refreshedAt = await $.clock.now()
    return null
  } finally {
    await showStatus($)
  }
}

async function defaultBranch($: Engine, cwd: string, repo: string): Promise<string | null> {
  const ref = await git($, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const name = ref.out.trim().replace(/^origin\//, '')
  if (ref.ok && name) {
    return name
  }
  return defaultBranchOf((await ghJson($, ['repo', 'view', repo, '--json', 'defaultBranchRef'], cwd)).json)
}

/** Deletes the merged PR's local branch, only when it points at the PR's head and no worktree has it checked out. */
async function deleteLocal($: Engine, cwd: string, pr: WatchedPr, base: string | null, out: Outcome) {
  const branch = pr.branch
  if (!branch || branch === base) {
    return
  }
  const local = await git($, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!local.ok) {
    out.steps.push(`no local branch ${branch}`)
    return
  }
  const sha = local.out.trim()
  if (!pr.headSha || sha !== pr.headSha) {
    const why = pr.headSha
      ? `local ${shortSha(sha)} is not the merged head ${shortSha(pr.headSha)}`
      : 'the merged head is unknown'
    out.steps.push(`branch ${branch} kept: ${why}`)
    out.issues.push(`branch ${branch} kept: ${why}`)
    return
  }
  const trees = await git($, cwd, ['worktree', 'list', '--porcelain'])
  const holder = trees.ok ? worktreeHolding(trees.out, branch) : null
  if (holder !== null) {
    const why = `checked out in ${holder || 'a worktree'}`
    out.steps.push(`branch ${branch} kept: ${why}`)
    out.issues.push(`branch ${branch} is ${why}`)
    return
  }
  const deleted = await git($, cwd, ['branch', '-D', branch])
  if (deleted.ok) {
    out.steps.push(`branch ${branch} deleted`)
  } else {
    out.steps.push(`branch ${branch} not deleted: ${gitError(deleted.err)}`)
    out.issues.push(`branch ${branch} not deleted`)
  }
}

/** Deletes the PR's branch on origin, when asked to and it still points at the merged head. */
async function deleteRemote($: Engine, cwd: string, pr: WatchedPr, base: string | null, out: Outcome) {
  const branch = pr.branch
  if (!config.deleteRemoteBranch || !branch || branch === base || !pr.headSha) {
    return
  }
  const listed = await git($, cwd, ['ls-remote', '--heads', 'origin', branch])
  const line = listed.out.split('\n').find(one => one.trim().endsWith(`\trefs/heads/${branch}`))
  if (!listed.ok || !line) {
    return
  }
  if (line.split('\t')[0]?.trim() !== pr.headSha) {
    out.steps.push(`origin/${branch} kept: it moved since the merge`)
    out.issues.push(`origin/${branch} moved since the merge`)
    return
  }
  const pushed = await git($, cwd, ['push', 'origin', '--delete', branch], 60_000)
  if (pushed.ok) {
    out.steps.push(`origin/${branch} deleted`)
  } else {
    out.steps.push(`origin/${branch} not deleted: ${gitError(pushed.err)}`)
    out.issues.push(`origin/${branch} not deleted`)
  }
}

/** Which worktree the session's folder is, the primary one or a linked one, and its root; null when git did not say (then it is taken for the primary one). */
async function worktreeOf($: Engine, cwd: string): Promise<Worktree | null> {
  const ran = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  return ran.ok ? parseWorktree(ran.out) : null
}

/** Where the ritual runs: the session's folder, its default branch (null when unknown) and the branch it has checked out ('' when detached). */
type Checkout = { cwd: string; base: string | null; current: string }

/**
 * The post-merge ritual in the session's folder, plain local git and safe: nothing in a folder that
 * is not a clone of the PR's repository; else `git fetch --prune`, then the primary worktree's ritual
 * (cleanupPrimary) or a linked worktree's (cleanupLinked).
 */
async function cleanup($: Engine, pr: WatchedPr): Promise<Outcome> {
  const out: Outcome = { steps: [], issues: [], ownWorktree: null }
  const cwd = await $.session.cwd()
  const origin = await git($, cwd, ['remote', 'get-url', 'origin'])
  const originRepo = origin.ok ? repoFromRemote(origin.out) : null
  if (!originRepo || originRepo.toLowerCase() !== pr.repo.toLowerCase()) {
    const where = originRepo ? `this folder is a clone of ${originRepo}` : `this folder is not a clone of ${pr.repo}`
    out.steps.push(`cleanup skipped: ${where}`)
    out.issues.push(`cleanup skipped: ${where}`)
    return out
  }

  const fetched = await git($, cwd, ['fetch', '--prune', 'origin'], 120_000)
  if (!fetched.ok) {
    out.steps.push(`fetch failed: ${gitError(fetched.err)}`)
    out.issues.push('fetch failed')
  }
  const tree = await worktreeOf($, cwd)
  const base = await defaultBranch($, cwd, pr.repo)
  const current = (await git($, cwd, ['branch', '--show-current'])).out.trim()
  const at: Checkout = { cwd, base, current }
  if (tree?.isLinked) {
    await cleanupLinked($, pr, at, tree, out)
  } else {
    await cleanupPrimary($, pr, at, out)
  }
  return out
}

/**
 * The primary worktree's ritual: switch to the default branch (only from the PR's branch) and pull
 * it --ff-only, never with uncommitted changes; delete the PR's branch only when nothing on it would
 * be lost and no worktree has it checked out; never --force.
 */
async function cleanupPrimary($: Engine, pr: WatchedPr, at: Checkout, out: Outcome) {
  const { cwd, base, current } = at
  const status = await git($, cwd, ['status', '--porcelain', '--untracked-files=no'])
  const isDirty = !status.ok || status.out.trim() !== ''

  if (!base) {
    out.steps.push('default branch unknown: did not switch or pull')
    out.issues.push('the default branch is unknown')
  } else if (current !== pr.branch && current !== base) {
    out.steps.push(current ? `on ${current}: left as is` : 'detached HEAD: left as is')
  } else if (isDirty) {
    out.steps.push(`uncommitted changes: stayed on ${current}, did not switch or pull`)
    out.issues.push(`uncommitted changes on ${current}`)
  } else {
    let head = current
    if (current === pr.branch) {
      const switched = await git($, cwd, ['switch', base])
      if (switched.ok) {
        head = base
      } else {
        out.steps.push(`could not switch to ${base}: ${gitError(switched.err)}`)
        out.issues.push(`could not switch to ${base}`)
      }
    }
    if (head === base) {
      const pulled = await git($, cwd, ['pull', '--ff-only', 'origin', base], 120_000)
      if (pulled.ok) {
        out.steps.push(`${base} pulled`)
      } else {
        out.steps.push(`${base} not pulled: ${gitError(pulled.err)}`)
        out.issues.push(`${base} not pulled`)
      }
    }
  }

  await deleteLocal($, cwd, pr, base, out)
  await deleteRemote($, cwd, pr, base, out)
}

/**
 * A linked worktree's ritual (git worktree add): nothing is switched or pulled, the default branch
 * being the primary worktree's (a switch could only fail, as `'main' is already used by worktree`).
 * When the merged branch is the one this worktree has checked out, branch and worktree are left to
 * the person; else the branch is deleted as in the primary worktree, never while a worktree has it.
 */
async function cleanupLinked($: Engine, pr: WatchedPr, at: Checkout, tree: Worktree, out: Outcome) {
  if (at.current && at.current === pr.branch) {
    out.ownWorktree = tree.path
    out.steps.push(`this worktree's branch; remove the worktree when you're done (git worktree remove ${tree.path})`)
  } else {
    await deleteLocal($, at.cwd, pr, at.base, out)
  }
  await deleteRemote($, at.cwd, pr, at.base, out)
}

async function finishMerged($: Engine, pr: WatchedPr) {
  await patch($, pr, { cleaned: true })
  const out = await cleanup($, pr)
  const steps = out.steps.length > 0 ? out.steps.join(' · ') : 'nothing to clean up'
  $.ui.toast(`#${pr.number} merged → ${steps}`, { timeoutMs: 12_000 })
  // The suggestion is the person's next prompt: it tells Claude the worktree is theirs to remove, never as a command to run.
  const text =
    out.ownWorktree !== null
      ? `#${pr.number} is merged; this worktree is on its branch, so both stay until I remove the worktree. Carry on with the next task.`
      : out.issues.length === 0
        ? `#${pr.number} is merged and cleaned up. Carry on with the next task.`
        : `#${pr.number} is merged (${out.issues[0]}). Carry on with the next task.`
  await $.prompt.suggest({ text }).catch(() => undefined)
}

/**
 * Whether a CI flip on `pr` toasts here (shouldToastCi): the branch this worktree has checked out is
 * asked of git only when it decides, for an adopted PR, so the polls of own PRs run no git at all.
 */
async function wantsCiToast($: Engine, pr: WatchedPr): Promise<boolean> {
  if (shouldToastCi(pr, null, config.toastAdoptedCi)) {
    return true
  }
  if (!pr.branch) {
    return false
  }
  const current = (await git($, await $.session.cwd(), ['branch', '--show-current'])).out.trim()
  return shouldToastCi(pr, current, config.toastAdoptedCi)
}

/** Reads one open PR's state and checks, and says when CI flips or the PR is merged or closed; what gh refused, if anything. */
async function refresh($: Engine, pr: WatchedPr): Promise<GhFailed | null> {
  const { view, failure } = await viewPr($, String(pr.number), pr.repo)
  if (!view) {
    return failure
  }
  const facts = { title: view.title || pr.title, branch: view.branch || pr.branch, headSha: view.headSha || pr.headSha }
  if (view.state === 'MERGED') {
    await patch($, pr, { ...facts, state: 'merged', cleaned: false })
    return null
  }
  if (view.state === 'CLOSED') {
    await update($, prs, list => list.filter(one => !isSame(one, pr)))
    $.ui.toast(`#${pr.number} was closed without merging; no longer watched`)
    return null
  }
  const { ci, failing, runIds } = view.rollup
  await patch($, pr, { ...facts, ci, failing, runIds })
  // CI that was merely unknown (its checks unreadable) has not flipped: no toast for reading it at last.
  const isFlipped = pr.ci !== 'unknown' && ci !== pr.ci && (ci === 'fail' || ci === 'pass')
  if (isFlipped && (await wantsCiToast($, { ...pr, ...facts }))) {
    if (ci === 'fail') {
      $.ui.toast(`CI failed on #${pr.number}: ${clip(failing.join(', '), 100)}`, { timeoutMs: 10_000 })
    } else {
      $.ui.toast(`CI passed on #${pr.number}`)
    }
  }
  return null
}

/** Reads the poll's outcome into gh's standing: a hold for what failed, or the way back after a success. */
async function settle($: Engine, now: number, failures: readonly GhFailed[], answered: number) {
  if (gh.hold === 'auth' || gh.hold === 'rate') {
    return // held already, by the read that was refused
  }
  const other = failures.find(failure => failure.kind === 'other')
  if (other) {
    await holdOther($, now, other.detail)
  } else if (answered > 0) {
    await recover($)
  }
}

/**
 * Reads every open PR once. With none watched after a hold was let go, the session's PRs are adopted
 * again instead: the hold began there.
 */
async function readOpen($: Engine): Promise<Reads> {
  const open = (await read($, prs)).filter(pr => pr.state === 'open')
  const outcomes: (GhFailed | null)[] = []
  if (gh.released !== null && open.length === 0 && sessionCwd !== null) {
    outcomes.push(await adopt($, sessionCwd))
  }
  for (const pr of open) {
    outcomes.push(await refresh($, pr).catch((error: unknown): GhFailed => ({ kind: 'other', detail: String(error) })))
  }
  const failures = outcomes.filter((outcome): outcome is GhFailed => outcome !== null)
  return { failures, answered: outcomes.length - failures.length }
}

/** Cleans up after each merged PR not yet cleaned up; a merge seen mid-turn waits for the turn's end, so git never races the model's own commands. */
async function cleanUpMerged($: Engine) {
  if (isTurnRunning) {
    return
  }
  for (const pr of await read($, prs)) {
    if (pr.state === 'merged' && !pr.cleaned) {
      await finishMerged($, pr)
    }
  }
}

async function pollOnce($: Engine) {
  const now = await $.clock.now()
  if (gh.hold !== null && now >= gh.holdUntil) {
    release() // the window is over: read in full again
  }
  const reads = await readOpen($)
  await cleanUpMerged($)
  if (reads.answered > 0) {
    gh.refreshedAt = now
  }
  await settle($, now, reads.failures, reads.answered)
  await showStatus($)
}

/** One poll at a time: a poll asked for while one runs waits for that one. */
function poll($: Engine): Promise<void> {
  if (!polling) {
    polling = pollOnce($)
      .catch((error: unknown) => debug($, `poll failed: ${String(error)}`))
      .finally(() => {
        polling = null
      })
  }
  return polling
}

/** A poll the person or Claude asked for: a hold is let go of first, so gh is tried again now. */
async function forcePoll($: Engine): Promise<void> {
  if (gh.hold !== null) {
    release()
  }
  await poll($)
}

/** The context block for one PR the prompt says is failing: its checks and its failed log's tail. */
async function ciContext($: Engine, number: number, pr: WatchedPr | null): Promise<string | null> {
  const repo = pr?.repo ?? null
  const repoArgs = repo ? ['--repo', repo] : []
  // `gh pr checks` exits 1 when a check failed and 8 while one is pending: its table is on stdout either way.
  const checks = await exec($, ['gh', 'pr', 'checks', String(number), ...repoArgs])
  const runId = failingRunIds(checks.out)[0] ?? pr?.runIds[0] ?? null
  const log = runId === null ? null : await exec($, ['gh', 'run', 'view', String(runId), ...repoArgs, '--log-failed'], undefined, 60_000)
  return ciAttachment({
    number,
    repo,
    checks: checks.out,
    runId,
    log: log?.ok ? log.out : '',
    logLines: config.logLines,
  })
}

/** The PR number the tool was asked about: a positive integer (or "#219"), else null for every watched PR. */
const numberArg = (value: unknown): number | null => {
  const number = typeof value === 'string' ? Number(value.replace(/^#/, '')) : value
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null
}

/** Answers the prs_status tool: the watched PRs as last read, read again first when older than a poll. */
async function prsStatus($: Engine, number: number | null): Promise<string> {
  const now = await $.clock.now()
  if (gh.refreshedAt === null || now - gh.refreshedAt >= config.pollMs) {
    ensureTimer($)
    await forcePoll($)
  }
  const after = await $.clock.now()
  const age = gh.refreshedAt === null ? null : after - gh.refreshedAt
  return toolReport(await read($, prs), number, age, holdNote(gh.hold, gh.isPlainBlocked, gh.holdUntil, after))
}

const USAGE = 'Usage: /prs (list and refresh) · /prs watch <n|url> [owner/repo] · /prs forget <n|all>'

/** Answers /prs: `watch <n|url> [owner/repo]`, `forget <n|all>`, or the listing, gh asked again first. */
async function runPrs($: Engine, args: string): Promise<string> {
  const [verb = '', target = '', repoArg = ''] = args.trim().split(/\s+/)
  if (verb === 'watch') {
    const fromUrl = parsePrUrls(target)[0]
    const number = fromUrl?.number ?? Number(target.replace(/^#/, ''))
    if (!Number.isInteger(number) || number <= 0) {
      return USAGE
    }
    const repo = fromUrl?.repo ?? (repoArg || null)
    const { view } = await viewPr($, String(number), repo)
    const resolved = repo ?? (view ? parsePrUrls(view.url)[0]?.repo : undefined)
    if (!view || !resolved) {
      return `pr-autopilot: gh found no PR #${number} in ${repo ?? "this folder's repository"}.`
    }
    await remember($, { repo: resolved, number, url: view.url }, view, true)
    await poll($)
    const watched = (await read($, prs)).find(pr => isSame(pr, { repo: resolved, number }))
    return watched ? `Watching ${describePrs([watched])}` : `Watching #${number}.`
  }
  if (verb === 'forget') {
    if (!target) {
      return USAGE
    }
    const before = await read($, prs)
    const number = Number(target.replace(/^#/, ''))
    const keep = target === 'all' ? [] : before.filter(pr => pr.number !== number)
    await update($, prs, list => list.filter(pr => keep.some(one => isSame(one, pr))))
    await showStatus($)
    const removed = before.length - keep.length
    return removed > 0 ? `Stopped watching ${removed} PR(s).` : `#${target} is not watched.`
  }
  if (verb !== '') {
    return USAGE
  }
  ensureTimer($)
  await forcePoll($)
  const listed = describePrs(await read($, prs))
  const note = holdNote(gh.hold, gh.isPlainBlocked, gh.holdUntil, await $.clock.now())
  return note ? `${listed}\n${note}` : listed
}

export const register: Register = (on, options) => {
  config = {
    pollMs: Math.max(10, Number(options.pollSeconds ?? 60)) * 1000,
    authRetryMs: Math.max(1, Number(options.authRetryMinutes ?? 30)) * 60_000,
    deleteRemoteBranch: options.deleteRemoteBranch === true,
    attachCiLogs: options.attachCiLogs !== false,
    logLines: Math.max(10, Math.min(2000, Number(options.logLines ?? 120))),
    toastAdoptedCi: options.toastAdoptedCi === true,
  }
  gh = standing()
  timer = null
  polling = null
  isTurnRunning = false
  shownStatus = null
  sessionCwd = null

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.command.register({
      name: 'prs',
      description: 'Watched pull requests: CI state, and the cleanup after a merge',
      argumentHint: '[watch <n> [owner/repo] | forget <n|all>]',
      immediate: true,
    })
    await $.tool.register(PRS_STATUS_TOOL).catch((error: unknown) => debug($, `the prs_status tool did not register: ${String(error)}`))
    ensureTimer($)
    void adopt($, e.cwd).catch((error: unknown) => debug($, `could not adopt open PRs: ${String(error)}`))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      const list = await read($, prs)
      if (list.some(pr => pr.state === 'merged' && !pr.cleaned)) {
        void poll($)
      }
    }
    return done
  })

  // Watches the PR a `gh pr create` opened (or names as already existing).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !CREATE.test(e.command)) {
      return ran
    }
    try {
      for (const ref of parsePrUrls(ran.text)) {
        await remember($, ref, (await viewPr($, String(ref.number), ref.repo)).view, true)
      }
      await showStatus($)
    } catch (error) {
      await debug($, `could not watch the new PR: ${String(error)}`)
    }
    return ran
  })

  // Claude reads the watched PRs here rather than with gh.
  on('tool.call', { tool: TOOL }, async ($, e) => ({ result: await prsStatus($, numberArg(e.number)) }))

  // Hands the model the failing checks and the failed log's tail when the person mentions a failing PR.
  on('prompt.submit', async ($, e, next) => {
    if (!config.attachCiLogs || !PERSONAL.has(e.origin.kind)) {
      return next(e)
    }
    const blocks: string[] = []
    try {
      const list = await read($, prs)
      for (const number of mentionedPrs(e.text, list)) {
        const matches = list.filter(pr => pr.number === number)
        const pr = matches.find(one => one.state === 'open') ?? matches[0] ?? null
        const block = await ciContext($, number, pr)
        if (block) {
          blocks.push(block)
        }
      }
    } catch (error) {
      await debug($, `could not attach CI logs: ${String(error)}`)
    }
    return blocks.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => ({ text: await runPrs($, e.args) }))
}
