import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register } from 'claude-code'

import type { WatchedPr } from '../types'
import {
  ciAttachment,
  clip,
  defaultBranchOf,
  describePrs,
  failingRunIds,
  gitError,
  mentionedPrs,
  nameWithOwner,
  parsePrUrls,
  parseView,
  repoFromRemote,
  shortSha,
  statusLine,
  watchedFrom,
  worktreeHolding,
} from './pr'
import type { PrRef, PrView } from './pr'

type Engine = EngineInterface

const prs = atom({ plugin: 'pr-autopilot', key: 'prs' } as const, [])

const VIEW_FIELDS = 'number,url,state,title,headRefName,headRefOid,statusCheckRollup,mergedAt'
const LIST_FIELDS = 'number,url,state,title,headRefName,headRefOid,statusCheckRollup'
const CREATE = /\bgh\s+pr\s+create\b/
/** Prompts the person wrote (typed, through Remote Control, or an SDK host's own turn). */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
/** How many PRs are kept: merged ones beyond this are dropped first. */
const KEEP = 30

type Ran = { ok: boolean; out: string; err: string }
type Outcome = { steps: string[]; issues: string[] }
type Config = { pollMs: number; deleteRemoteBranch: boolean; attachCiLogs: boolean; logLines: number }

let config: Config = { pollMs: 60_000, deleteRemoteBranch: false, attachCiLogs: true, logLines: 120 }
let timer: { cancel: () => void } | null = null
let polling: Promise<void> | null = null
let isTurnRunning = false
/** The status line last shown; null before the first. */
let shownStatus: string | undefined | null = null

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

async function ghJson($: Engine, args: readonly string[], cwd?: string): Promise<unknown> {
  const ran = await exec($, ['gh', ...args], cwd)
  if (!ran.ok) {
    return null
  }
  try {
    return JSON.parse(ran.out) as unknown
  } catch {
    return null
  }
}

async function viewPr($: Engine, ref: string, repo: string | null): Promise<PrView | null> {
  return parseView(await ghJson($, ['pr', 'view', ref, ...(repo ? ['--repo', repo] : []), '--json', VIEW_FIELDS]))
}

async function debug($: Engine, line: string) {
  await $.ui.log(`pr-autopilot: ${line}`, { to: 'debug' })
}

async function showStatus($: Engine) {
  const line = statusLine(await read($, prs))
  if (line !== shownStatus) {
    shownStatus = line
    $.ui.status(line)
  }
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void poll($))
  }
}

async function patch($: Engine, pr: WatchedPr, changes: Partial<WatchedPr>) {
  await update($, prs, list => list.map(one => (isSame(one, pr) ? { ...one, ...changes } : one)))
}

/** Watches a PR, or refreshes what is known of one already watched (its CI state stays the poll's to change). */
async function remember($: Engine, ref: PrRef, view: PrView | null) {
  const now = await $.clock.now()
  const fresh = watchedFrom(ref, view, now)
  await update($, prs, list => {
    const known = list.find(one => isSame(one, ref))
    if (!known) {
      return capped([...list, fresh])
    }
    const facts = view ? { title: fresh.title, branch: fresh.branch, headSha: fresh.headSha, url: fresh.url } : {}
    return list.map(one => (one === known ? { ...one, ...facts } : one))
  })
  ensureTimer($)
}

/** Adopts the person's open PRs in the session's repository, when it is a GitHub repository. */
async function adopt($: Engine, cwd: string) {
  try {
    const inside = await git($, cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok) {
      return
    }
    const repo = nameWithOwner(await ghJson($, ['repo', 'view', '--json', 'nameWithOwner'], cwd))
    if (!repo) {
      return
    }
    const listed = await ghJson(
      $,
      ['pr', 'list', '--author', '@me', '--state', 'open', '--json', LIST_FIELDS, '--limit', '20'],
      cwd,
    )
    for (const item of Array.isArray(listed) ? listed : []) {
      const view = parseView(item)
      if (view?.number) {
        await remember($, { repo, number: view.number, url: view.url }, view)
      }
    }
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
  return defaultBranchOf(await ghJson($, ['repo', 'view', repo, '--json', 'defaultBranchRef'], cwd))
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

/**
 * The post-merge ritual in the session's folder, plain local git and safe: fetch --prune; switch
 * to the default branch (only from the PR's branch) and pull it --ff-only, never with uncommitted
 * changes; delete the PR's branch only when nothing on it would be lost; never --force.
 */
async function cleanup($: Engine, pr: WatchedPr): Promise<Outcome> {
  const out: Outcome = { steps: [], issues: [] }
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
  const base = await defaultBranch($, cwd, pr.repo)
  const current = (await git($, cwd, ['branch', '--show-current'])).out.trim()
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
  return out
}

async function finishMerged($: Engine, pr: WatchedPr) {
  await patch($, pr, { cleaned: true })
  const out = await cleanup($, pr)
  const steps = out.steps.length > 0 ? out.steps.join(' · ') : 'nothing to clean up'
  $.ui.toast(`#${pr.number} merged → ${steps}`, { timeoutMs: 12_000 })
  const text =
    out.issues.length === 0
      ? `#${pr.number} is merged and cleaned up. Carry on with the next task.`
      : `#${pr.number} is merged (${out.issues[0]}). Carry on with the next task.`
  await $.prompt.suggest({ text }).catch(() => undefined)
}

/** Reads one open PR's state and checks, and says when CI flips or the PR is merged or closed. */
async function refresh($: Engine, pr: WatchedPr) {
  const view = await viewPr($, String(pr.number), pr.repo)
  if (!view) {
    return
  }
  const facts = { title: view.title || pr.title, branch: view.branch || pr.branch, headSha: view.headSha || pr.headSha }
  if (view.state === 'MERGED') {
    await patch($, pr, { ...facts, state: 'merged', cleaned: false })
    return
  }
  if (view.state === 'CLOSED') {
    await update($, prs, list => list.filter(one => !isSame(one, pr)))
    $.ui.toast(`#${pr.number} was closed without merging; no longer watched`)
    return
  }
  const { ci, failing, runIds } = view.rollup
  await patch($, pr, { ...facts, ci, failing, runIds })
  if (ci !== pr.ci && ci === 'fail') {
    $.ui.toast(`CI failed on #${pr.number}: ${clip(failing.join(', '), 100)}`, { timeoutMs: 10_000 })
  } else if (ci !== pr.ci && ci === 'pass') {
    $.ui.toast(`CI passed on #${pr.number}`)
  }
}

async function pollOnce($: Engine) {
  for (const pr of await read($, prs)) {
    if (pr.state === 'open') {
      await refresh($, pr).catch((error: unknown) => debug($, `could not read #${pr.number}: ${String(error)}`))
    }
  }
  // A merge seen mid-turn is cleaned up once the turn ends, so git never races the model's own commands.
  if (!isTurnRunning) {
    for (const pr of await read($, prs)) {
      if (pr.state === 'merged' && !pr.cleaned) {
        await finishMerged($, pr)
      }
    }
  }
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

const USAGE = 'Usage: /prs (list and refresh) · /prs watch <n|url> [owner/repo] · /prs forget <n|all>'

export const register: Register = (on, options) => {
  config = {
    pollMs: Math.max(10, Number(options.pollSeconds ?? 60)) * 1000,
    deleteRemoteBranch: options.deleteRemoteBranch === true,
    attachCiLogs: options.attachCiLogs !== false,
    logLines: Math.max(10, Math.min(2000, Number(options.logLines ?? 120))),
  }
  timer = null
  polling = null
  isTurnRunning = false
  shownStatus = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Watched pull requests: CI state, and the cleanup after a merge',
      argumentHint: '[watch <n> [owner/repo] | forget <n|all>]',
      immediate: true,
    })
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
        await remember($, ref, await viewPr($, String(ref.number), ref.repo))
      }
      await showStatus($)
    } catch (error) {
      await debug($, `could not watch the new PR: ${String(error)}`)
    }
    return ran
  })

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

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', target = '', repoArg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'watch') {
      const fromUrl = parsePrUrls(target)[0]
      const number = fromUrl?.number ?? Number(target.replace(/^#/, ''))
      if (!Number.isInteger(number) || number <= 0) {
        return { text: USAGE }
      }
      const repo = fromUrl?.repo ?? (repoArg || null)
      const view = await viewPr($, String(number), repo)
      const resolved = repo ?? (view ? parsePrUrls(view.url)[0]?.repo : undefined)
      if (!view || !resolved) {
        return { text: `pr-autopilot: gh found no PR #${number} in ${repo ?? "this folder's repository"}.` }
      }
      await remember($, { repo: resolved, number, url: view.url }, view)
      await poll($)
      const watched = (await read($, prs)).find(pr => isSame(pr, { repo: resolved, number }))
      return { text: watched ? `Watching ${describePrs([watched])}` : `Watching #${number}.` }
    }
    if (verb === 'forget') {
      if (!target) {
        return { text: USAGE }
      }
      const before = await read($, prs)
      const number = Number(target.replace(/^#/, ''))
      const keep = target === 'all' ? [] : before.filter(pr => pr.number !== number)
      await update($, prs, list => list.filter(pr => keep.some(one => isSame(one, pr))))
      await showStatus($)
      const removed = before.length - keep.length
      return { text: removed > 0 ? `Stopped watching ${removed} PR(s).` : `#${target} is not watched.` }
    }
    if (verb !== '') {
      return { text: USAGE }
    }
    ensureTimer($)
    await poll($)
    return { text: describePrs(await read($, prs)) }
  })
}
