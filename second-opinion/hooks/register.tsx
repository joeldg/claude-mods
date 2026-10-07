import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, ModelEffort, Register } from 'claude-code'

import type { Opinion, OpinionRun } from '../types'
import {
  DEFAULT_COUNT,
  DEFAULT_EFFORT,
  DEFAULT_MAX_CHARS,
  DEFAULT_MODEL,
  attachmentBlock,
  baseName,
  buildPrompt,
  chunkMarkdown,
  commits,
  configFrom,
  countFiles,
  describeSaved,
  failureReason,
  fillText,
  modelLabel,
  parseArgs,
  parseSaved,
  pickDefaultBranch,
  projectKey,
  resolvePath,
  savedText,
  stampOf,
  timeOfStamp,
  whenOf,
} from './review'
import type { Config, ReviewRequest, Section } from './review'

type Engine = EngineInterface

const COMMAND = 'second-opinion'
const PANE = 'second-opinion'
const TITLE = 'Second opinion'
const STATUS = 'second opinion: reviewing…'
/** The reply's cap: room for the reviewer's thinking and a full review. */
const MAX_TOKENS = 32_000
/** A backstop on the one call; a provider ends a request this long at ten minutes anyway. */
const TIMEOUT_MS = 12 * 60_000
const GIT_MS = 30_000
/** `git log` per commit: hash, date, author and subject, then the body. */
const LOG_FORMAT = '%h %ad %an: %s%n%b'
/** The empty tree, to diff a repository's first commit against when `git hash-object` cannot say. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Prompts the person wrote (typed, through Remote Control, or an SDK host's own turn). */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
/** How many saved reviews `/second-opinion list` reads. */
const LIST_LIMIT = 20

const current = atom({ plugin: 'second-opinion', key: 'current' } as const, null)
const running = atom({ plugin: 'second-opinion', key: 'running' } as const, null)
const armed = atom({ plugin: 'second-opinion', key: 'armed' } as const, null)

let config: Config = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, maxChars: DEFAULT_MAX_CHARS }
/** True while this environment's review runs; a reload drops it with the call, unlike `running`. */
let isReviewing = false

type Ran = { ok: boolean; out: string; err: string; started: boolean }

/** The context gathered for one review. */
type Gathered = {
  root: string
  branch: string | null
  /** What is under review, in words, for the prompt and the saved file. */
  subject: string
  /** The same, short, for the command's answer: "12 commits". */
  short: string
  sections: Section[]
}

/** A review that could not start, and why. */
type Failure = { error: string }

/** Everything the background half of a review needs. */
type Job = OpinionRun & {
  effort: ModelEffort
  focus: string
  prompt: string
  root: string
  home: string | undefined
}

const usage = (): string => {
  const label = modelLabel(config.model)
  return [
    'Usage: /second-opinion [what]',
    '  (nothing)     your branch against the default branch, or the last 12 commits',
    '  commits N     the last N commits',
    '  diff          the uncommitted changes',
    '  file <path>   a plan, spec or ADR',
    '  <question>    the default review, focused on your question',
    '  show [n]      reopen the last review (or the nth from list)',
    '  list          the reviews saved for this project',
    `Each review is one ${label} call (${config.model}, effort ${config.effort}), billed to your usage.`,
  ].join('\n')
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function git($: Engine, cwd: string, args: readonly string[]): Promise<Ran> {
  try {
    const out = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_MS })
    return { ok: out.exitCode === 0, out: out.stdout, err: out.stderr, started: true }
  } catch (error) {
    return { ok: false, out: '', err: messageOf(error), started: false }
  }
}

/** The repository's top folder, or null outside one; `started` false when git itself could not run. */
async function repoRoot($: Engine, cwd: string): Promise<Ran> {
  return git($, cwd, ['rev-parse', '--show-toplevel'])
}

async function defaultBranch($: Engine, root: string): Promise<string | null> {
  const symbolic = await git($, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (symbolic.ok && symbolic.out.trim()) {
    return pickDefaultBranch(symbolic.out, null)
  }
  const candidates = await git($, root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ])
  return pickDefaultBranch(null, candidates.ok ? candidates.out : null)
}

const statusSection = (status: string): Section => ({
  tag: 'git_status',
  label: 'Working tree (git status --short; uncommitted changes are listed, not shown)',
  body: status.trim() || '(clean)',
})

/** The default review: the branch's commits and diff against the default branch, or the last N commits. */
async function gatherWork($: Engine, request: ReviewRequest, root: string, branch: string | null, status: string) {
  const base = request.kind === 'work' ? await defaultBranch($, root) : null
  const baseLocal = base?.replace(/^origin\//, '') ?? null
  if (base && branch && branch !== baseLocal) {
    const ahead = Number((await git($, root, ['rev-list', '--count', `${base}..HEAD`])).out.trim()) || 0
    const mergeBase = ahead > 0 ? (await git($, root, ['merge-base', base, 'HEAD'])).out.trim() : ''
    if (ahead > 0 && mergeBase) {
      const [log, diff] = await Promise.all([
        git($, root, ['log', `-${DEFAULT_COUNT}`, '--stat', '--no-color', '--date=short', `--format=${LOG_FORMAT}`, `${base}..HEAD`]),
        git($, root, ['diff', '--no-color', '--no-ext-diff', `${mergeBase}...HEAD`]),
      ])
      const shown = ahead > DEFAULT_COUNT ? `the newest ${DEFAULT_COUNT} of ${ahead}` : commits(ahead)
      return {
        subject: `the branch ${branch}, ${commits(ahead)} ahead of ${base}`,
        short: `${commits(ahead)} on ${branch}`,
        sections: [
          { tag: 'git_log', label: `Commits on ${branch}, newest first (${shown}, git log --stat)`, body: log.out },
          { tag: 'git_diff', label: `The branch's diff against ${base} (git diff ${mergeBase.slice(0, 12)}...HEAD)`, body: diff.out },
          statusSection(status),
        ],
      }
    }
  }

  const total = Number((await git($, root, ['rev-list', '--count', 'HEAD'])).out.trim()) || 0
  const wanted = request.kind === 'commits' ? request.count : DEFAULT_COUNT
  const count = total > 0 ? Math.min(wanted, total) : wanted
  let from = `HEAD~${count}`
  const isAll = total > 0 && count >= total
  if (isAll) {
    const empty = await git($, root, ['hash-object', '-t', 'tree', '/dev/null'])
    from = (empty.ok && empty.out.trim()) || EMPTY_TREE
  }
  const [log, diff] = await Promise.all([
    git($, root, ['log', `-${count}`, '--stat', '--no-color', '--date=short', `--format=${LOG_FORMAT}`]),
    git($, root, ['diff', '--no-color', '--no-ext-diff', from, 'HEAD']),
  ])
  const where = branch ?? 'a detached HEAD'
  return {
    subject: count === 1 ? `the last commit on ${where}` : `the last ${count} commits on ${where}`,
    short: commits(count),
    sections: [
      { tag: 'git_log', label: `The last ${commits(count)}, newest first (git log -${count} --stat)`, body: log.out },
      {
        tag: 'git_diff',
        label: `Their combined diff (git diff ${isAll ? 'from the empty tree' : from} to HEAD)`,
        body: diff.out,
      },
      statusSection(status),
    ],
  }
}

/** Reads what the request names, in the session's folder; a Failure says why there is nothing to review. */
async function gather($: Engine, request: ReviewRequest, cwd: string, home: string | undefined): Promise<Gathered | Failure> {
  const top = await repoRoot($, cwd)
  if (!top.started && request.kind !== 'file') {
    return { error: `second-opinion: git could not run (${top.err}), so there is nothing to review.` }
  }

  if (request.kind === 'file') {
    const path = resolvePath(request.path, cwd, home)
    let text: string
    try {
      const read = await $.fs.read(path)
      text = typeof read === 'string' ? read : ''
    } catch (error) {
      return { error: `second-opinion: could not read ${request.path}: ${messageOf(error)}` }
    }
    if (!text.trim()) {
      return { error: `second-opinion: ${request.path} is empty, so there is nothing to review.` }
    }
    const sections: Section[] = [{ tag: 'document', label: `The document under review (${request.path})`, body: text }]
    let branch: string | null = null
    if (top.ok) {
      const root = top.out.trim()
      const [branchRan, log, status] = await Promise.all([
        git($, root, ['branch', '--show-current']),
        git($, root, ['log', '-8', '--no-color', '--date=short', '--format=%h %ad %s']),
        git($, root, ['status', '--short']),
      ])
      branch = branchRan.out.trim() || null
      if (log.ok && log.out.trim()) {
        sections.push({ tag: 'git_log', label: 'Recent commits in the repository, for orientation (git log -8)', body: log.out })
      }
      sections.push(statusSection(status.out))
    }
    return { root: top.ok ? top.out.trim() : cwd, branch, subject: request.path, short: request.path, sections }
  }

  if (!top.ok) {
    return {
      error: `second-opinion: ${cwd} is not inside a git repository. /second-opinion file <path> reviews a plan or spec without one.`,
    }
  }
  const root = top.out.trim() || cwd
  const [branchRan, head, statusRan] = await Promise.all([
    git($, root, ['branch', '--show-current']),
    git($, root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git($, root, ['status', '--short']),
  ])
  const branch = branchRan.out.trim() || null
  const status = statusRan.out

  if (request.kind === 'diff') {
    const diff = await git($, root, ['diff', '--no-color', '--no-ext-diff', ...(head.ok ? ['HEAD'] : ['--cached'])])
    if (!diff.out.trim() && !status.trim()) {
      return { error: 'second-opinion: there are no uncommitted changes to review.' }
    }
    const log = head.ok ? await git($, root, ['log', '-5', '--no-color', '--date=short', '--format=%h %ad %s']) : null
    const files = countFiles(status)
    return {
      root,
      branch,
      subject: `the uncommitted changes on ${branch ?? 'a detached HEAD'} (${files} file${files === 1 ? '' : 's'})`,
      short: 'the uncommitted changes',
      sections: [
        { tag: 'git_status', label: 'Changed files (git status --short; ?? files are new and not in the diff)', body: status.trim() || '(none)' },
        { tag: 'git_diff', label: `The uncommitted diff (git diff ${head.ok ? 'HEAD' : '--cached'})`, body: diff.out },
        ...(log?.out.trim() ? [{ tag: 'git_log', label: 'The last commits, for orientation (git log -5)', body: log.out }] : []),
      ],
    }
  }

  if (!head.ok) {
    return { error: 'second-opinion: this repository has no commits yet; /second-opinion diff reviews the uncommitted changes.' }
  }
  return { root, branch, ...(await gatherWork($, request, root, branch, status)) }
}

/** Where this project's reviews are saved: `~/.claude/second-opinions/<project-key>`. */
const folderOf = (home: string, root: string): string =>
  `${home.replace(/\/+$/, '')}/.claude/second-opinions/${projectKey(root)}`

/** This project's folder of saved reviews and their file names, newest first. */
async function savedFiles($: Engine): Promise<{ dir: string | null; names: string[] }> {
  const home = await $.env.get('HOME')
  if (!home) {
    return { dir: null, names: [] }
  }
  const cwd = await $.session.cwd()
  const top = await repoRoot($, cwd)
  const dir = folderOf(home, top.ok ? top.out.trim() || cwd : cwd)
  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(entry => entry.kind === 'file' && timeOfStamp(entry.name) !== null)
    .map(entry => entry.name)
    .sort()
    .reverse()
  return { dir, names }
}

async function listSaved($: Engine): Promise<string> {
  const { dir, names } = await savedFiles($)
  if (dir === null) {
    return 'second-opinion: HOME is not set, so the saved reviews cannot be found.'
  }
  const entries: { createdAt: number; subject: string }[] = []
  for (const name of names.slice(0, LIST_LIMIT)) {
    const text = await $.fs.read(`${dir}/${name}`).catch(() => '')
    const opinion = parseSaved(typeof text === 'string' ? text : '', `${dir}/${name}`)
    entries.push({ createdAt: opinion.createdAt, subject: opinion.subject })
  }
  const more = names.length > LIST_LIMIT ? `\n(${names.length - LIST_LIMIT} older ones are in the folder.)` : ''
  return describeSaved(entries, dir) + more
}

async function show($: Engine, index: number): Promise<string> {
  let opinion = index === 1 ? await read($, current) : null
  if (!opinion) {
    const { dir, names } = await savedFiles($)
    const name = names[index - 1]
    if (dir !== null && name !== undefined) {
      const path = `${dir}/${name}`
      const text = await $.fs.read(path).catch(() => null)
      if (typeof text === 'string') {
        opinion = parseSaved(text, path)
        const loaded = opinion
        await update($, current, () => loaded)
      }
    }
  }
  if (!opinion) {
    const run = await read($, running)
    if (run && isReviewing) {
      return `${modelLabel(run.model)} is still reviewing ${run.subject}; it opens here when it is ready.`
    }
    return index === 1
      ? 'No second opinion yet for this project. /second-opinion asks for one.'
      : `There is no saved second opinion #${index} for this project. /second-opinion list shows them.`
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch((error: unknown) => ({
    isPlaced: false as const,
    reason: messageOf(error),
  }))
  const where = opinion.path ? ` (${opinion.path})` : ''
  const said = `the second opinion on ${opinion.subject} from ${whenOf(opinion.createdAt)}${where}`
  return opened.isPlaced ? `Showing ${said}.` : `The pane could not be shown here (${opened.reason}); ${said} is saved.`
}

/** Starts a review: gathers the context now, makes the one model call in the background, answers at once. */
async function start($: Engine, request: ReviewRequest): Promise<string> {
  const busy = await read($, running)
  if (busy && isReviewing) {
    const seconds = Math.round(((await $.clock.now()) - busy.startedAt) / 1000)
    return `${modelLabel(busy.model)} is still reviewing ${busy.subject} (started ${seconds}s ago); one review runs at a time.`
  }
  if (busy) {
    // Left by an environment a reload replaced mid-review: that call ended with it.
    await update($, running, () => null)
    $.ui.status(undefined)
  }

  const cwd = await $.session.cwd()
  const home = await $.env.get('HOME')
  const gathered = await gather($, request, cwd, home)
  if ('error' in gathered) {
    $.ui.toast(gathered.error, { timeoutMs: 8_000 })
    return gathered.error
  }

  const { prompt, cut } = buildPrompt({
    project: baseName(gathered.root),
    branch: gathered.branch,
    subject: gathered.subject,
    focus: request.focus,
    sections: gathered.sections,
    maxChars: config.maxChars,
  })
  const job: Job = {
    model: config.model,
    effort: config.effort,
    subject: gathered.subject,
    startedAt: await $.clock.now(),
    focus: request.focus,
    prompt,
    root: gathered.root,
    home,
  }
  isReviewing = true
  await update($, running, () => ({ model: job.model, subject: job.subject, startedAt: job.startedAt }))
  $.ui.status(STATUS)
  // A timer, not this command's dispatch, carries the call: it runs on after the command has answered.
  $.clock.after(0, () => {
    void finish($, job).catch((error: unknown) => $.ui.log(`second-opinion: ${messageOf(error)}`, { to: 'debug' }))
  })

  const label = modelLabel(job.model)
  const trimmed = cut.length > 0 ? ` (cut to fit ${config.maxChars.toLocaleString('en-US')} characters: ${cut.join('; ')})` : ''
  return `${label} is reviewing ${gathered.short} (one ${label} call)… It opens in a pane when it is ready; /second-opinion show reopens it.${trimmed}`
}

async function save($: Engine, job: Job, opinion: Opinion, result: ModelCompleteResult): Promise<string | null> {
  if (!job.home) {
    return null
  }
  const path = `${folderOf(job.home, job.root)}/${stampOf(opinion.createdAt)}.md`
  const tokens = { input: result.usage.input_tokens, output: result.usage.output_tokens }
  try {
    await $.fs.write(path, savedText(opinion, baseName(job.root), tokens))
    return path
  } catch (error) {
    $.ui.log(`second-opinion: could not save ${path}: ${messageOf(error)}`, { to: 'debug' })
    return null
  }
}

/** The background half: the model call, then the file, the toast and the pane. */
async function finish($: Engine, job: Job) {
  const label = modelLabel(job.model)
  try {
    let result: ModelCompleteResult | null = null
    let refusal = ''
    try {
      result = await $.model.complete({
        model: job.model,
        prompt: job.prompt,
        effort: job.effort,
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
      })
    } catch (error) {
      refusal = messageOf(error)
    }
    const text = result?.isAnswered ? result.text.trim() : ''
    if (result === null || !text) {
      const why = result === null ? `the request was refused: ${refusal}` : failureReason(result)
      $.ui.toast(`Second opinion failed: ${why}`, { timeoutMs: 10_000 })
      $.ui.log(`second-opinion: ${label} could not review ${job.subject}: ${why}. Nothing was saved.`)
      return
    }
    const opinion: Opinion = {
      text,
      model: job.model,
      effort: job.effort,
      subject: job.subject,
      focus: job.focus,
      createdAt: await $.clock.now(),
      path: null,
    }
    const path = await save($, job, opinion, result)
    const done: Opinion = { ...opinion, path }
    await update($, current, () => done)
    $.ui.toast(
      path ? 'Second opinion ready (/second-opinion show)' : 'Second opinion ready (/second-opinion show); it could not be saved',
      { timeoutMs: 8_000 },
    )
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  } finally {
    isReviewing = false
    await update($, running, () => null)
    $.ui.status(undefined)
  }
}

/** Send to Claude: the review rides along with the person's next prompt, once, and the box is filled. */
async function sendToClaude($: Engine) {
  const opinion = await read($, current)
  if (!opinion) {
    return
  }
  await update($, armed, () => attachmentBlock(opinion))
  const filled = await $.prompt.fill({ text: fillText(opinion.model) }).catch(() => null)
  $.ui.toast(
    filled?.isFilled
      ? 'The review is attached to your next prompt'
      : 'The review is attached to your next prompt; write it and press Enter',
  )
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  isReviewing = false

  on('session.start', async ($, e, next) => {
    const label = modelLabel(config.model)
    await $.command.register({
      name: COMMAND,
      description: `Ask ${label} for a candid review of recent work, in the background (one ${label} call per run, billed to your usage)`,
      argumentHint: '[commits N | diff | file <path> | show [n] | list | <question>]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const request = parseArgs(e.args)
    try {
      switch (request.kind) {
        case 'help':
          return { text: usage() }
        case 'usage':
          return { text: `${request.message}\n\n${usage()}` }
        case 'list':
          return { text: await listSaved($) }
        case 'show':
          return { text: await show($, request.index) }
        default:
          return { text: await start($, request) }
      }
    } catch (error) {
      const text = `second-opinion: ${messageOf(error)}`
      $.ui.toast(text, { timeoutMs: 8_000 })
      return { text }
    }
  })

  // Hands Claude the review armed by Send to Claude, with the person's next prompt only.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSONAL.has(e.origin.kind) || (await read($, armed)) === null) {
      return next(e)
    }
    const taken: { block: string | null } = { block: null }
    await update($, armed, value => {
      taken.block = value
      return null
    })
    return taken.block ? next({ ...e, context: [...(e.context ?? []), taken.block] }) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const opinion = await read($, current)
    const run = await read($, running)
    const isArmed = (await read($, armed)) !== null
    const busy = run ? (
      <Text dimColor wrap="truncate-end">
        {modelLabel(run.model)} is reviewing {run.subject}…
      </Text>
    ) : null

    if (!opinion) {
      return (
        <Box flexDirection="column">
          {busy ?? <Text dimColor>No second opinion yet. /second-opinion asks for one.</Text>}
        </Box>
      )
    }
    const focus = opinion.focus ? ` · asked: ${opinion.focus.replace(/\s+/g, ' ')}` : ''
    return (
      <Box flexDirection="column" gap={1}>
        {busy}
        <Text dimColor wrap="truncate-end">
          {modelLabel(opinion.model)} on {opinion.subject} · {whenOf(opinion.createdAt)}
          {focus}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="send" label="Send to Claude" variant="primary" onPress={() => sendToClaude($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {isArmed && <Text dimColor>Attached to your next prompt.</Text>}
        {chunkMarkdown(opinion.text).map((chunk, i) => (
          <Markdown key={`review-${i}`} text={chunk} />
        ))}
      </Box>
    )
  })
}
