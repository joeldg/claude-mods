import type { Ci, PrState, WatchedPr } from '../types'

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

export const shortSha = (sha: string): string => sha.slice(0, 7)

export type PrRef = { repo: string; number: number; url: string }

const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g

/** Every GitHub pull request URL in the text (what `gh pr create` prints), each once, in order. */
export const parsePrUrls = (output: string | undefined): PrRef[] => {
  const found: PrRef[] = []
  for (const match of (output ?? '').matchAll(PR_URL)) {
    const repo = `${match[1]}/${match[2]}`
    const number = Number(match[3])
    if (!found.some(ref => ref.repo === repo && ref.number === number)) {
      found.push({ repo, number, url: `https://github.com/${repo}/pull/${number}` })
    }
  }
  return found
}

/** `owner/name` from a GitHub remote URL (https, ssh or scp-like); null for another host. */
export const repoFromRemote = (url: string): string | null => {
  const found = url.trim().match(/github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return found ? `${found[1]}/${found[2]}` : null
}

/** `gh repo view --json nameWithOwner`: `{ "nameWithOwner": "owner/name" }`. */
export const nameWithOwner = (json: unknown): string | null => {
  const value = json && typeof json === 'object' ? text((json as Record<string, unknown>).nameWithOwner) : ''
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null
}

/** `gh repo view --json defaultBranchRef`: `{ "defaultBranchRef": { "name": "main" } }`. */
export const defaultBranchOf = (json: unknown): string | null => {
  const ref = json && typeof json === 'object' ? (json as Record<string, unknown>).defaultBranchRef : null
  const name = ref && typeof ref === 'object' ? text((ref as Record<string, unknown>).name) : ''
  return name || null
}

export type Check = { name: string; state: string; url: string }

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE'])

/**
 * One `statusCheckRollup` entry as a check: a CheckRun `{ name, status, conclusion, detailsUrl }`
 * (its status while it runs, its conclusion once completed) or a StatusContext `{ context, state, targetUrl }`.
 */
const checkOf = (entry: unknown): Check | null => {
  if (!entry || typeof entry !== 'object') {
    return null
  }
  const e = entry as Record<string, unknown>
  if (e.__typename === 'StatusContext' || (e.context !== undefined && e.name === undefined)) {
    return { name: text(e.context), state: text(e.state).toUpperCase(), url: text(e.targetUrl) }
  }
  const status = text(e.status).toUpperCase()
  const state = status && status !== 'COMPLETED' ? status : text(e.conclusion).toUpperCase()
  return { name: text(e.name), state, url: text(e.detailsUrl) }
}

/** The GitHub Actions run id in a check's details URL (`…/actions/runs/123/job/456`). */
export const runIdOf = (url: string): number | null => {
  const found = url.match(/\/actions\/runs\/(\d+)/)
  return found ? Number(found[1]) : null
}

export type Rollup = { ci: Ci; failing: string[]; runIds: number[] }

/**
 * A PR's checks as a whole: any failed check fails it, then any check not yet passed keeps it
 * pending (queued, running, waiting, or a state this does not know); all passed or skipped
 * passes it; no checks at all is `none`.
 */
export const summarizeRollup = (rollup: unknown): Rollup => {
  const checks = (Array.isArray(rollup) ? rollup : [])
    .map(checkOf)
    .filter((check): check is Check => check !== null)
  if (checks.length === 0) {
    return { ci: 'none', failing: [], runIds: [] }
  }
  const failed = checks.filter(check => FAILED.has(check.state))
  const failing = [...new Set(failed.map(check => check.name || 'unnamed check'))]
  const runIds = [...new Set(failed.map(check => runIdOf(check.url)).filter((id): id is number => id !== null))]
  const ci: Ci = failed.length > 0 ? 'fail' : checks.some(check => !PASSED.has(check.state)) ? 'pending' : 'pass'
  return { ci, failing, runIds }
}

/** What a view read without its checks says of them: a token lacking "Checks: read" may still read the rest. */
const unknownChecks = (): Rollup => ({ ci: 'unknown', failing: [], runIds: [] })

export type PrView = {
  number: number | null
  url: string
  /** `OPEN`, `MERGED` or `CLOSED`. */
  state: string
  title: string
  branch: string
  headSha: string
  rollup: Rollup
}

/**
 * One PR as `gh pr view --json …` (or one entry of `gh pr list --json …`) prints it; null when it is
 * not one. Read without the `statusCheckRollup` field, its CI is unknown (not none).
 */
export const parseView = (json: unknown): PrView | null => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return null
  }
  const v = json as Record<string, unknown>
  const state = text(v.state).toUpperCase()
  if (!state) {
    return null
  }
  return {
    number: typeof v.number === 'number' ? v.number : null,
    url: text(v.url),
    state,
    title: text(v.title),
    branch: text(v.headRefName),
    headSha: text(v.headRefOid),
    rollup: v.statusCheckRollup === undefined ? unknownChecks() : summarizeRollup(v.statusCheckRollup),
  }
}

const stateOf = (view: PrView): PrState =>
  view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open'

/** A newly watched PR, from what gh said of it (or only its URL when gh said nothing). */
export const watchedFrom = (ref: PrRef, view: PrView | null, now: number): WatchedPr => ({
  number: ref.number,
  repo: ref.repo,
  url: view?.url || ref.url,
  title: view?.title ?? '',
  branch: view?.branch ?? '',
  headSha: view?.headSha ?? '',
  ci: view ? view.rollup.ci : 'pending',
  failing: view?.rollup.failing ?? [],
  runIds: view?.rollup.runIds ?? [],
  state: view ? stateOf(view) : 'open',
  cleaned: false,
  addedAt: now,
})

const MARK: Record<Ci, string> = { pass: '✓', fail: '✗', pending: 'CI…', none: '', unknown: 'CI?' }

/** `PRs: #219 ✓ · #220 CI… · #221 ✗` over the open PRs; undefined when none is open. */
export const statusLine = (prs: readonly WatchedPr[]): string | undefined => {
  const open = prs.filter(pr => pr.state === 'open')
  return open.length > 0 ? `PRs: ${open.map(pr => `#${pr.number} ${MARK[pr.ci]}`.trim()).join(' · ')}` : undefined
}

const NONE_WATCHED = 'No PRs are watched. A PR opened with `gh pr create` is picked up by itself; /prs watch <n> adds one.'

/** The watched PR's state in words. */
const stateWord = (pr: WatchedPr): string =>
  pr.state === 'merged' ? (pr.cleaned ? 'merged, cleaned up' : 'merged, cleanup pending') : pr.state

/** The PR's CI in words; '' for a PR no longer open. */
const ciWord = (pr: WatchedPr): string => {
  if (pr.state !== 'open') {
    return ''
  }
  switch (pr.ci) {
    case 'fail':
      return `CI failing: ${pr.failing.join(', ') || 'unknown check'}`
    case 'pass':
      return 'CI passed'
    case 'pending':
      return 'CI running'
    case 'unknown':
      return "CI unknown — gh token can't read checks"
    default:
      return 'no CI checks'
  }
}

/** What `/prs` prints: one line per watched PR. */
export const describePrs = (prs: readonly WatchedPr[]): string => {
  if (prs.length === 0) {
    return NONE_WATCHED
  }
  return prs
    .map(pr => {
      const facts = [stateWord(pr), ciWord(pr), pr.branch].filter(Boolean).join(' · ')
      return `#${pr.number} ${pr.repo} · ${facts}${pr.title ? ` · ${pr.title}` : ''}`
    })
    .join('\n')
}

/** "just now", "30s ago" or "3m ago". */
const ago = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds < 1 ? 'just now' : seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`
}

const toolLine = (pr: WatchedPr): string =>
  [`#${pr.number} ${pr.title || '(no title)'}`, stateWord(pr), pr.branch, ciWord(pr), pr.url].filter(Boolean).join(' · ')

/**
 * What the prs_status tool answers: one line per watched PR (or the one asked for by number), when
 * gh last answered for them (`ageMs`; null before it has), and the note on a hold when there is one.
 */
export const toolReport = (
  prs: readonly WatchedPr[],
  number: number | null,
  ageMs: number | null,
  note: string | null,
): string => {
  const chosen = number === null ? prs : prs.filter(pr => pr.number === number)
  const lines: string[] = []
  if (prs.length === 0) {
    lines.push(NONE_WATCHED)
  } else if (chosen.length === 0) {
    lines.push(`#${number} is not watched (watched: ${prs.map(pr => `#${pr.number}`).join(', ')}); /prs watch ${number} adds it.`)
  } else {
    lines.push(...chosen.map(toolLine))
  }
  lines.push(ageMs === null ? 'Not refreshed yet: gh has not answered.' : `Refreshed ${ago(ageMs)}.`)
  if (note) {
    lines.push(note)
  }
  return lines.join('\n')
}

export type GhFailure = 'auth' | 'rate' | 'other'

const AUTH_FAILURE =
  /Resource not accessible by (?:personal access token|integration)|Requires authentication|HTTP 40[13]\b|not logged into|gh auth login|Bad credentials/i
const RATE_FAILURE = /rate limit/i

/**
 * Why a gh run failed, from what it printed: `rate` when GitHub's rate limit refused it (an HTTP 403
 * too, so it is read first), `auth` when the login or the token's permissions did (a fine-grained PAT
 * lacking "Checks: read" cannot read statusCheckRollup), `other` for the rest (no such PR, a timeout).
 */
export const ghFailure = (stdout: string, stderr: string): GhFailure => {
  const said = `${stderr}\n${stdout}`
  return RATE_FAILURE.test(said) ? 'rate' : AUTH_FAILURE.test(said) ? 'auth' : 'other'
}

/** True when gh was refused by the token's permissions (not by a missing or rejected login). */
export const isPermissionFailure = (detail: string): boolean => /Resource not accessible/i.test(detail)

/** The status line while gh cannot read the PRs themselves. */
export const AUTH_STATUS = "PRs: gh can't read them"

/** The one toast a session gets when gh's auth stands in the way: the cause, the fix, and when it tries again. */
export const authToast = (isAboutChecks: boolean, retryMinutes: number): string =>
  isAboutChecks
    ? 'pr-autopilot: gh can\'t read PR checks — its token lacks "Checks: read" (a fine-grained PAT). ' +
      `Fix: gh auth login --web, or grant the token "Checks: read". CI shows as unknown; it retries in ${retryMinutes} min, or now with /prs.`
    : `pr-autopilot: gh can't read PRs — not logged in, or its token was rejected. Fix: gh auth login --web. It retries in ${retryMinutes} min, or now with /prs.`

/** Minutes until `until`, at least one. */
const minutesUntil = (until: number, now: number): number => Math.max(1, Math.ceil((until - now) / 60_000))

/** The line /prs and the tool add while polls are held back; null when they are not. */
export const holdNote = (hold: GhFailure | null, isPlainBlocked: boolean, holdUntil: number, now: number): string | null => {
  if (hold === null) {
    return null
  }
  const left = minutesUntil(holdUntil, now)
  if (hold === 'rate') {
    return `gh is rate limited: polling resumes in ${left} min.`
  }
  if (hold === 'other') {
    return `gh failed; polling again in ${left} min.`
  }
  return isPlainBlocked
    ? `gh can't read PRs (not logged in, or its token was rejected): what is shown may be stale. Fix gh auth; /prs retries now, else in ${left} min.`
    : `gh can't read checks (its token lacks "Checks: read"): CI is unknown. Fix gh auth; /prs retries now, else in ${left} min.`
}

const CI_WORD = /\b(?:fail(?:s|ed|ing|ures?)?|checks|ci|lint(?:s|ing|er)?)\b/i
const PR_REF = /(?:#|\bPR\s*#?\s*|\/pull\/)(\d{1,7})\b/gi
const BARE_NUMBER = /(?:^|[^#\w/.-])(\d{1,7})\b/g
const CI_FAILED =
  /\b(?:ci|checks?|build|lint)\b[^.!?\n]{0,40}?\b(?:fail(?:s|ed|ing|ures?)?|red|broken)\b|\bfail(?:s|ed|ing|ures?)?\b[^.!?\n]{0,40}?\b(?:ci|checks)\b/i

/**
 * The PRs whose failing CI the person's prompt is about, at most two: a `#258` (or `PR 258`)
 * in a clause that speaks of failing, checks, CI or lint, a bare `258` there when PR 258 is
 * watched, and with no number at all, "CI failed" means the watched PRs failing now, newest first.
 */
export const mentionedPrs = (
  prompt: string,
  watched: readonly Pick<WatchedPr, 'number' | 'ci' | 'state' | 'addedAt'>[],
): number[] => {
  const known = new Set(watched.map(pr => pr.number))
  const found: number[] = []
  const add = (number: number) => {
    if (!found.includes(number)) {
      found.push(number)
    }
  }
  for (const clause of prompt.split(/[.!?;](?=\s|$)|\n+/)) {
    if (!CI_WORD.test(clause)) {
      continue
    }
    for (const match of clause.matchAll(PR_REF)) {
      add(Number(match[1]))
    }
    for (const match of clause.matchAll(BARE_NUMBER)) {
      const number = Number(match[1])
      if (known.has(number)) {
        add(number)
      }
    }
  }
  if (found.length === 0 && CI_FAILED.test(prompt)) {
    watched
      .filter(pr => pr.state === 'open' && pr.ci === 'fail')
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .forEach(pr => add(pr.number))
  }
  return found.slice(0, 2)
}

/** Run ids of the failing rows of `gh pr checks` (tab-separated: name, bucket, elapsed, link, description). */
export const failingRunIds = (checks: string): number[] => {
  const ids = checks
    .split('\n')
    .map(line => line.split('\t'))
    .filter(columns => (columns[1] ?? '').trim() === 'fail')
    .map(columns => runIdOf(columns[3] ?? ''))
    .filter((id): id is number => id !== null)
  return [...new Set(ids)]
}

/** A timestamp GitHub puts after the job and step columns of `gh run view --log-failed`. */
const STAMP = /^([^\t]*\t[^\t]*\t)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/

/**
 * The last `count` lines of a log, colors, carriage returns, BOMs and per-line timestamps taken
 * out, and the runner's post-job cleanup after the last `##[error]` dropped (it is noise).
 */
export const tailLines = (log: string, count: number): string => {
  let lines = log
    .replace(ANSI, '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(STAMP, '$1').trimEnd())
  let lastError = -1
  lines.forEach((line, index) => {
    if (line.includes('##[error]')) {
      lastError = index
    }
  })
  const cleanupAt = lastError < 0 ? -1 : lines.findIndex((line, index) => index > lastError && /Post job cleanup\.?$/.test(line))
  if (cleanupAt > 0) {
    lines = lines.slice(0, cleanupAt)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.slice(-Math.max(1, Math.round(count))).join('\n')
}

/** The end of a text that fits in `room` characters, cut at a line start. */
const keepEnd = (value: string, room: number): string => {
  if (value.length <= room) {
    return value
  }
  const end = value.slice(value.length - Math.max(0, room - 2))
  const lineStart = end.indexOf('\n')
  return `…\n${lineStart >= 0 ? end.slice(lineStart + 1) : end}`
}

export const MAX_ATTACHMENT = 12_000
const MAX_CHECKS = 3_000

export type Attachment = {
  number: number
  /** `owner/name`, or null when gh resolved it from the working directory. */
  repo: string | null
  /** `gh pr checks` output. */
  checks: string
  runId: number | null
  /** `gh run view --log-failed` output. */
  log: string
  logLines: number
}

/** The context block handed to the model beside the prompt, under MAX_ATTACHMENT characters; null when there is nothing to say. */
export const ciAttachment = (a: Attachment): string | null => {
  const repoArgs = a.repo ? ` --repo ${a.repo}` : ''
  const intro = `pr-autopilot: the prompt mentions failing CI on #${a.number}${a.repo ? ` (${a.repo})` : ''}, so here is what gh reports.`
  const parts: string[] = []
  const checks = a.checks.replace(ANSI, '').trim()
  if (checks) {
    parts.push(`Checks (\`gh pr checks ${a.number}${repoArgs}\`):\n${clip(checks, MAX_CHECKS)}`)
  }
  const log = a.runId === null ? '' : tailLines(a.log, a.logLines)
  if (a.runId !== null && log) {
    const head = (lines: number) =>
      `Last ${lines} lines of the failed log (\`gh run view ${a.runId}${repoArgs} --log-failed\`):\n`
    const used = intro.length + parts.reduce((sum, part) => sum + part.length + 2, 0) + 2
    const kept = keepEnd(log, MAX_ATTACHMENT - used - head(log.split('\n').length).length)
    parts.push(head(kept.split('\n').filter(line => line !== '…').length) + kept)
  }
  return parts.length > 0 ? [intro, ...parts].join('\n\n') : null
}

/** The worktree (its path) that has `branch` checked out, from `git worktree list --porcelain`; null when none has. */
export const worktreeHolding = (porcelain: string, branch: string): string | null => {
  let path = ''
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.trim() === `branch refs/heads/${branch}`) {
      return path
    }
  }
  return null
}

/** The line of git's stderr that says what went wrong (`fatal:`/`error:` first), short. */
export const gitError = (stderr: string): string => {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const line = lines.find(one => /^(?:fatal|error):/.test(one)) ?? lines[0] ?? 'failed'
  return clip(line.replace(/^(?:fatal|error):\s*/, ''), 80)
}
