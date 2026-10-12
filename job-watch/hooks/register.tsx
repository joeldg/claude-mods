import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { Disk, Job, JobState, Progress } from '../types'
import {
  bar,
  doneOf,
  etaFrom,
  exitCodeOf,
  formatCount,
  formatDuration,
  isAlive,
  isPidAlive,
  launchFromCommand,
  matchToken,
  outputFileFromText,
  parseDf,
  parseProgress,
  resolvePath,
} from './parse'

type Engine = EngineInterface
type Json = Record<string, unknown>

const PANE = 'job-watch'
const TITLE = 'Jobs'
/** The context block that tells Claude jobs are watched for it, and names the tools. */
const BLOCK = 'jobWatch'
/** A job that ends sooner than this was a quick command, not a long job: it leaves silently. */
const SHORT_MS = 60_000
/** How long a probe (`ps`, `df`, `tail`) may run before it is abandoned. */
const PROBE_TIMEOUT_MS = 10_000
/** A probe slower than this, or one that timed out, doubles its interval, up to BACKOFF_MAX_MS. */
const SLOW_MS = 2_000
const BACKOFF_MAX_MS = 300_000
/** How often disks are re-read while `df` is quick. */
const DF_MS = 60_000

const TOOLS = ['mcp__job-watch__jobs_list', 'mcp__job-watch__jobs_watch', 'mcp__job-watch__jobs_unwatch'] as const

const LIST_DESCRIPTION = [
  'List the long-running jobs job-watch follows: background Bash tasks, detached nohup launches, and anything added with jobs_watch.',
  'For each: its state (running, quiet, stalled, or finished with its exit code), how long since it last wrote output, progress and ETA when its log shows them, its last log line and its log path.',
  'Call this to follow or wait for long-running work instead of writing `until … sleep` / `while … sleep` loops or running `ps`: background Bash jobs (run_in_background: true) are picked up automatically the moment they start.',
].join(' ')

const WATCH_DESCRIPTION = [
  'Add a process or a log file to the jobs job-watch follows, so jobs_list can report on it: `pid` (followed until it exits), `log` (a file whose growth, progress figures and last line are read), or both; `name` labels it and `quietMinutes` says after how long without output it counts as stalled.',
  "Only needed for work started outside this session's Bash (another session, a cron job, a pid you were given): background Bash tasks (run_in_background: true) and `nohup … > log 2>&1 &` launches are picked up automatically.",
  'It does not start commands: run those with Bash. Use it instead of `ps` or sleep loops.',
].join(' ')

const UNWATCH_DESCRIPTION =
  'Stop following a job, by the name or id jobs_list prints; `done` removes every finished job, `all` removes them all.'

const EMPTY =
  'No jobs are being watched. Background Bash tasks (run_in_background: true) and detached `nohup … > log 2>&1 &` launches are picked up automatically once they run; jobs_watch adds any other process (by pid) or log file.'

/** What the first user message carries: three short lines, so Claude asks the tools rather than polling. */
const CONTEXT = [
  'job-watch follows long-running work for you: background Bash tasks (run_in_background: true) and `nohup … > log &` launches are picked up automatically, with progress, ETA, stalls and finishes.',
  'To check on or wait for a job call mcp__job-watch__jobs_list, never an `until/while … sleep` loop or `ps`.',
  'mcp__job-watch__jobs_watch adds a pid or log file started elsewhere; mcp__job-watch__jobs_unwatch removes one.',
].join('\n')

const jobs = atom({ plugin: 'job-watch', key: 'jobs' } as const, [])
const disks = atom({ plugin: 'job-watch', key: 'disks' } as const, [])

const hashOf = (text: string): string => {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

type Config = {
  stallMs: number
  pollMs: number
  keepDoneMs: number
  autoOpen: boolean
  wantedDisks: string[]
}

let config: Config = { stallMs: 600_000, pollMs: 10_000, keepDoneMs: 7_200_000, autoOpen: true, wantedDisks: [] }
let timer: { cancel: () => void } | null = null
/** The pass over the jobs now running, shared by whoever asks for one meanwhile. */
let inflight: Promise<void> | null = null
let hasOpened = false

/**
 * A probe's pacing, in ticks of the poll timer: a timeout or a run slower than SLOW_MS doubles
 * the ticks between runs (up to BACKOFF_MAX_MS), a fast run restores the base. `last` is the
 * newest answer (null after a failure) and stands in on the ticks in between.
 */
type Pace = { name: string; baseTicks: number; everyTicks: number; sinceTicks: number; last: ProcessRunResult | null }

const paceOf = (name: string, baseMs: number): Pace => {
  const baseTicks = Math.max(1, Math.round(baseMs / config.pollMs))
  return { name, baseTicks, everyTicks: baseTicks, sinceTicks: baseTicks, last: null }
}

let psPace = paceOf('ps', config.pollMs)
let dfPace = paceOf('df', DF_MS)

/** Counts a tick for the probe: true when it is due to run again. */
const isDue = (pace: Pace): boolean => {
  pace.sinceTicks += 1
  if (pace.sinceTicks < pace.everyTicks) {
    return false
  }
  pace.sinceTicks = 0
  return true
}

/** Runs a due probe, adjusts its pace from how long it took, and logs the change once. */
async function probe($: Engine, pace: Pace, argv: readonly string[]): Promise<ProcessRunResult | null> {
  const startedAt = await $.clock.now()
  const ran = await $.process.run(argv, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
  const tookMs = (await $.clock.now()) - startedAt
  const isSlow = ran === null || tookMs > SLOW_MS
  const maxTicks = Math.max(pace.baseTicks, Math.ceil(BACKOFF_MAX_MS / config.pollMs))
  const everyTicks = isSlow ? Math.min(pace.everyTicks * 2, maxTicks) : pace.baseTicks
  if (everyTicks !== pace.everyTicks) {
    const why = ran === null ? 'timed out' : isSlow ? `took ${formatDuration(tookMs / 1000)}` : 'is fast again'
    $.ui.log(`job-watch: ${pace.name} ${why}: probing every ${formatDuration((everyTicks * config.pollMs) / 1000)}`, {
      to: 'debug',
    })
  }
  pace.everyTicks = everyTicks
  pace.last = ran
  return ran
}

function etaText(job: Job, now: number): string {
  if (job.etaSeconds === null || job.etaAt === null) {
    return ''
  }
  const left = job.etaSeconds - (now - job.etaAt) / 1000
  return left > 0 ? `ETA ${formatDuration(left)}` : 'ETA due'
}

const progressText = (progress: Progress): string =>
  `${progress.pct.toFixed(progress.pct < 10 ? 1 : 0)}%` +
  (progress.total > 0 ? ` (${formatCount(progress.done)}/${formatCount(progress.total)})` : '')

function summary(list: readonly Job[]): string | undefined {
  const count = (state: JobState) => list.filter(job => job.state === state).length
  const parts = [
    count('running') && `${count('running')} running`,
    count('stalled') && `${count('stalled')} stalled`,
    count('quiet') && `${count('quiet')} quiet`,
  ].filter(Boolean)
  return parts.length > 0 ? `jobs: ${parts.join(' · ')}` : undefined
}

/** A job as this version keeps it: fields a job stored before a reload may lack are filled in. */
const normalize = (job: Job): Job => ({
  ...job,
  pid: job.pid ?? null,
  stallMs: job.stallMs ?? null,
  exitCode: job.exitCode ?? null,
})

async function refreshDisks($: Engine) {
  if (!isDue(dfPace)) {
    return
  }
  const df = await probe($, dfPace, ['df', '-k'])
  if (df?.exitCode === 0) {
    const next: Disk[] = parseDf(df.stdout, config.wantedDisks)
    await update($, disks, () => next)
  }
}

/**
 * The `ps` listing the live jobs are judged by: every command line when one must be matched,
 * a per-pid lookup (cheap under load) when pids alone are followed; null when none is needed
 * or `ps` did not answer. Between due ticks the last answer stands.
 */
async function processes($: Engine, list: readonly Job[]): Promise<string | null> {
  const live = list.filter(job => job.state !== 'done')
  const pids = live.flatMap(job => (job.pid !== null ? [String(job.pid)] : []))
  const needsCommands = live.some(job => job.match !== null && job.pid === null)
  if (!needsCommands && pids.length === 0) {
    return null
  }
  const argv = needsCommands ? ['ps', '-axo', 'pid=,command='] : ['ps', '-o', 'pid=', '-p', pids.join(',')]
  const ran = isDue(psPace) ? await probe($, psPace, argv) : psPace.last
  return ran?.stdout ?? null
}

/** The log re-read once it has grown: size, last line, progress, the ETA's baseline and the exit marker. */
async function readLog($: Engine, job: Job, now: number): Promise<Job> {
  const stat = job.log === '' ? null : await $.fs.stat(job.log).catch(() => null)
  if (!stat || stat.size === job.size) {
    return job
  }
  const tail = await $.process.run(['tail', '-c', '8192', job.log], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
  const text = tail?.stdout ?? ''
  const reading = parseProgress(text)
  const restarted = reading.progress && job.progress && doneOf(reading.progress) < doneOf(job.progress)
  const baseline =
    reading.progress && (!job.baseline || restarted) ? { at: now, done: doneOf(reading.progress) } : job.baseline
  return {
    ...job,
    size: stat.size,
    changedAt: stat.mtimeMs,
    lastLine: reading.lastLine || job.lastLine,
    progress: reading.progress ?? job.progress,
    baseline,
    etaSeconds: reading.etaSeconds ?? etaFrom(baseline, now, reading.progress ?? job.progress),
    etaAt: now,
    exitCode: exitCodeOf(text),
  }
}

/** What `ps` says of the job: by its pid, else by its command-line token; null when it cannot tell. */
const aliveIn = (ps: string | null, job: Job): boolean | null =>
  ps === null ? null : job.pid !== null ? isPidAlive(ps, job.pid) : job.match !== null ? isAlive(ps, job.match) : null

/** Running, or quiet / stalled once the log has been silent past the job's threshold; a pid alone never stalls. */
const quietState = (job: Job, now: number, alive: boolean | null): JobState => {
  const quietFor = now - Math.max(job.changedAt, job.addedAt)
  if (job.log === '' || quietFor <= (job.stallMs ?? config.stallMs)) {
    return 'running'
  }
  return alive === true ? 'stalled' : 'quiet'
}

async function readJob($: Engine, job: Job, now: number, ps: string | null): Promise<Job> {
  if (job.state === 'done') {
    return job
  }
  let next = await readLog($, job, now)
  const alive = aliveIn(ps, next)
  const isUnseen = alive === false && !next.seenAlive && now - next.addedAt > config.pollMs * 2
  if (alive === true && !next.seenAlive) {
    next = { ...next, seenAlive: true }
  }
  if (isUnseen && next.pid === null) {
    // `ps` never showed the token: it was a bad guess, so judge this job by its log alone.
    next = { ...next, match: null }
  }
  // A pid never seen in two polls is a process that is not running, whatever it was.
  const isGone = alive === false && (next.seenAlive || (isUnseen && next.pid !== null))
  const state: JobState = isGone || next.exitCode !== null ? 'done' : quietState(next, now, alive)
  return state === 'done' ? { ...next, state, finishedAt: now, etaSeconds: null, etaAt: null } : { ...next, state }
}

/** Toasts a finish or a stall the tick it first shows; false for a quick command, which leaves unannounced. */
function announce($: Engine, was: Job, job: Job, now: number): boolean {
  if (job.state === 'done' && was.state !== 'done') {
    const lived = now - job.addedAt
    if (lived < SHORT_MS) {
      return false
    }
    $.ui.toast(`${job.label} finished after ${formatDuration(lived / 1000)}: ${shorten(job.lastLine, 80)}`, {
      timeoutMs: 10_000,
    })
  }
  if (job.state === 'stalled' && was.state !== 'stalled') {
    $.ui.toast(`${job.label} has written nothing for ${formatDuration((job.stallMs ?? config.stallMs) / 1000)}`, {
      timeoutMs: 10_000,
    })
  }
  return true
}

/** Whether a finished or quiet job has stayed its keepDoneMinutes and leaves the list. */
const isExpired = (job: Job, now: number): boolean =>
  (job.state === 'done' && job.finishedAt !== null && now - job.finishedAt > config.keepDoneMs) ||
  (job.state === 'quiet' && now - job.changedAt > config.keepDoneMs)

/** One pass: disks when due, then every job read, judged, toasted and kept or dropped. */
async function pass($: Engine) {
  await refreshDisks($)
  const list = (await read($, jobs)).map(normalize)
  if (list.length === 0) {
    $.ui.status(undefined)
    return
  }
  const now = await $.clock.now()
  const ps = await processes($, list)

  const fresh: Job[] = []
  for (const job of list) {
    const next = await readJob($, job, now, ps)
    if (announce($, job, next, now) && !isExpired(next, now)) {
      fresh.push(next)
    }
  }
  await update($, jobs, () => fresh)
  $.ui.status(summary(fresh))

  const isLong = fresh.some(job => job.state !== 'done' && now - job.addedAt >= SHORT_MS)
  if (config.autoOpen && !hasOpened && isLong) {
    hasOpened = true
    void $.ui.open({ id: PANE, title: TITLE })
  }
}

/** The pass now running, or a new one: a timer tick that lands mid-pass joins it rather than doubling it. */
function tick($: Engine): Promise<void> {
  if (!inflight) {
    inflight = pass($)
      .catch((error: unknown) => $.ui.log(`job-watch: a poll failed: ${String(error)}`, { to: 'debug' }))
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** A pass that reads the jobs as they stand now: one already running is awaited first, then a fresh one runs. */
async function tickNow($: Engine): Promise<void> {
  if (inflight) {
    await inflight
  }
  await tick($)
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void tick($))
  }
}

type NewJob = Pick<Job, 'id' | 'label' | 'log' | 'match'> & Partial<Pick<Job, 'pid' | 'stallMs'>>

async function addJob($: Engine, job: NewJob) {
  const now = await $.clock.now()
  const added: Job = {
    ...job,
    pid: job.pid ?? null,
    stallMs: job.stallMs ?? null,
    seenAlive: false,
    addedAt: now,
    size: -1,
    changedAt: now,
    lastLine: '',
    progress: null,
    etaSeconds: null,
    etaAt: null,
    baseline: null,
    state: 'running',
    finishedAt: null,
    exitCode: null,
  }
  await update($, jobs, list =>
    [...list.filter(one => one.id !== added.id && (added.log === '' || one.log !== added.log)), added].slice(-20),
  )
  ensureTimer($)
}

type Watch = { log: string | null; pid: number | null; label: string | null; stallMs: number | null }

/** Registers a job the way /watch does and reads it once; the text of the refusal when the log cannot be used. */
async function watchJob($: Engine, want: Watch): Promise<Job | string> {
  let log = ''
  if (want.log !== null) {
    const resolved = resolvePath(want.log, await $.env.get('HOME'), await $.session.cwd())
    if (!resolved || !(await $.fs.exists(resolved))) {
      return `job-watch: ${resolved ?? want.log} does not exist.`
    }
    log = resolved
  }
  const id = log !== '' ? hashOf(log) : `pid-${want.pid}`
  const label = shorten(want.label || (log !== '' ? log.split('/').pop() || log : `pid ${want.pid}`), 40)
  await addJob($, { id, label, log, match: null, pid: want.pid, stallMs: want.stallMs })
  // A fresh `ps` on a pass that sees this job, so a pid is judged now rather than from the last listing.
  if (inflight) {
    await inflight
  }
  psPace.sinceTicks = psPace.everyTicks
  await tick($)
  return (await read($, jobs)).find(job => job.id === id) ?? `job-watch: ${label} could not be added.`
}

/** Drops the jobs `what` names (all, done, or one by id or label); how many went and what stays. */
async function removeJobs($: Engine, what: string): Promise<{ removed: number; kept: Job[] }> {
  const before = await read($, jobs)
  const kept = before.filter(job =>
    what === 'all'
      ? false
      : what === 'done' || what === ''
        ? job.state !== 'done'
        : job.id !== what && job.label !== what,
  )
  await update($, jobs, () => kept)
  $.ui.status(summary(kept))
  return { removed: before.length - kept.length, kept }
}

/** One job as jobs_list prints it: a line of figures, then its log path and last line indented. */
function describeJob(job: Job, now: number): string {
  const age = formatDuration((now - Math.max(job.changedAt, job.addedAt)) / 1000)
  const state =
    job.state === 'done'
      ? `finished ${formatDuration((now - (job.finishedAt ?? now)) / 1000)} ago` +
        (job.exitCode !== null ? ` (exit ${job.exitCode})` : '')
      : job.state === 'running'
        ? 'running'
        : `${job.state} (no output for ${formatDuration((job.stallMs ?? config.stallMs) / 1000)})`
  const parts = [
    state,
    job.pid !== null && `pid ${job.pid}`,
    job.progress && progressText(job.progress),
    job.state !== 'done' && etaText(job, now),
    job.log === '' ? `no log (added ${age} ago)` : `last output ${age} ago`,
  ].filter(Boolean)
  const lines = [`${job.label} [${job.id}]: ${parts.join(' · ')}`]
  if (job.log !== '') {
    lines.push(`  log ${job.log}`)
  }
  if (job.lastLine) {
    lines.push(`  › ${job.lastLine}`)
  }
  return lines.join('\n')
}

async function listTool($: Engine): Promise<string> {
  await tickNow($)
  const list = (await read($, jobs)).map(normalize)
  if (list.length === 0) {
    return EMPTY
  }
  const now = await $.clock.now()
  const footer =
    `quiet = no output for ${formatDuration(config.stallMs / 1000)} with no process to check · ` +
    `stalled = the process is alive but has written nothing for that long · ` +
    `finished jobs stay listed for ${formatDuration(config.keepDoneMs / 1000)}; jobs_unwatch removes one.`
  return [...list.slice().reverse().map(job => describeJob(job, now)), '', footer].join('\n')
}

/** jobs_watch's input checked: what to watch, or the text of the refusal. */
function watchInput(e: Json): Watch | string {
  if (e.command !== undefined) {
    return 'job-watch: jobs_watch does not start commands. Run it with Bash (run_in_background: true, or `nohup … > log 2>&1 &`): it is watched automatically, and jobs_list reports on it.'
  }
  const pid = e.pid === undefined ? null : Number(e.pid)
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) {
    return 'job-watch: pid must be a positive integer.'
  }
  const log = typeof e.log === 'string' && e.log.trim() !== '' ? e.log.trim() : null
  if (pid === null && log === null) {
    return 'job-watch: jobs_watch needs a pid, a log path, or both.'
  }
  const quiet = e.quietMinutes === undefined ? null : Number(e.quietMinutes)
  if (quiet !== null && !(quiet > 0)) {
    return 'job-watch: quietMinutes must be a positive number.'
  }
  const label = typeof e.name === 'string' ? e.name.trim() : ''
  return { log, pid, label: label || null, stallMs: quiet === null ? null : quiet * 60_000 }
}

/** jobs_watch's answer: where the job is read from, and what changes its state. */
function watchedText(job: Job): string {
  const where = [job.pid !== null && `pid ${job.pid}`, job.log !== '' && `log ${job.log}`].filter(Boolean).join(', ')
  const quietText = `after ${formatDuration((job.stallMs ?? config.stallMs) / 1000)} without output`
  const counts = [
    job.log !== '' && (job.pid !== null ? `stalled ${quietText}` : `quiet ${quietText} (no process to check)`),
    job.pid !== null && 'finished when the process exits',
  ].filter(Boolean)
  return `Watching ${job.label} [${job.id}]: ${where}. Call jobs_list to check on it: it counts as ${counts.join(' and as ')}.`
}

async function watchTool($: Engine, e: Json): Promise<string> {
  const want = watchInput(e)
  if (typeof want === 'string') {
    return want
  }
  const job = await watchJob($, want)
  if (typeof job === 'string') {
    return job
  }
  // A pid the fresh listing does not show is not running: say so now rather than wait on it.
  if (job.pid !== null && !job.seenAlive && psPace.last !== null) {
    await update($, jobs, list => list.filter(one => one.id !== job.id))
    return `job-watch: no process with pid ${job.pid} is running.`
  }
  return watchedText(job)
}

async function unwatchTool($: Engine, e: Json): Promise<string> {
  const what = typeof e.name === 'string' ? e.name.trim() : ''
  if (what === '') {
    return 'job-watch: jobs_unwatch needs the name or id of a job as jobs_list prints it, or done, or all.'
  }
  const before = await read($, jobs)
  if (what !== 'all' && what !== 'done' && !before.some(job => job.id === what || job.label === what)) {
    const watched = before.map(job => `${job.label} [${job.id}]`).join(', ')
    return `job-watch: no job named ${what}. ${before.length > 0 ? `Watched: ${watched}.` : 'No jobs are being watched.'}`
  }
  return `Removed ${(await removeJobs($, what)).removed} job(s).`
}

async function registerTools($: Engine): Promise<void> {
  const tools = [
    { name: 'jobs_list', description: LIST_DESCRIPTION, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'jobs_watch',
      description: WATCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'The process to follow until it exits.' },
          log: {
            type: 'string',
            description: 'A log file to read progress and the last line from (~ and relative paths are expanded).',
          },
          name: { type: 'string', description: 'A label for the job (default: the log file name, or the pid).' },
          quietMinutes: {
            type: 'number',
            description: 'Minutes without output after which the job counts as stalled (default from settings).',
          },
        },
      },
    },
    {
      name: 'jobs_unwatch',
      description: UNWATCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name or id jobs_list prints, or done, or all.' } },
        required: ['name'],
      },
    },
  ]
  for (const tool of tools) {
    // In the prompt's own tool list, so the model reaches for them instead of a sleep loop.
    await $.tool
      .register({ ...tool, isDeferred: false })
      .catch((error: unknown) => $.ui.log(`job-watch: ${tool.name} did not register: ${String(error)}`, { to: 'debug' }))
  }
}

export const register: Register = (on, options) => {
  config = {
    stallMs: Math.max(1, Number(options.stallMinutes ?? 10)) * 60_000,
    pollMs: Math.max(2, Number(options.pollSeconds ?? 10)) * 1000,
    keepDoneMs: Math.max(1, Number(options.keepDoneMinutes ?? 120)) * 60_000,
    autoOpen: options.autoOpen !== false,
    wantedDisks: String(options.disks ?? '')
      .split(',')
      .map(mount => mount.trim())
      .filter(Boolean),
  }
  timer = null
  inflight = null
  hasOpened = false
  psPace = paceOf('ps', config.pollMs)
  dfPace = paceOf('df', DF_MS)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jobs', description: 'Open the Jobs pane (long-running jobs and disk space)' })
    await $.command.register({
      name: 'watch',
      description: 'Watch a log file in the Jobs pane',
      argumentHint: '<log path> [label]',
    })
    await $.command.register({
      name: 'unwatch',
      description: 'Stop watching a job (by label or id), or clear finished ones',
      argumentHint: '<label|id|done|all>',
    })
    await registerTools($)
    ensureTimer($)
    void tick($)
    return next(e)
  })

  // Once per conversation, and again after a compaction: the model learns jobs are watched for it.
  on('prompt.context', async (_$, e, next) => {
    const result = await next(e)
    return { ...result, blocks: [...result.blocks.filter(block => block.name !== BLOCK), { name: BLOCK, text: CONTEXT }] }
  })

  // Picks up background Bash tasks and detached `nohup … > log &` launches once they have started.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    try {
      const output = e.run_in_background ? outputFileFromText(ran.text) : null
      if (output) {
        const match = matchToken(e.command.split(/\s*(?:&&|;|\n)\s*/).pop() ?? e.command)
        if (match !== null || e.description) {
          await addJob($, {
            id: output.split('/').pop()?.replace(/\.output$/, '') ?? hashOf(output),
            label: shorten(e.description || match || 'background task', 40),
            log: output,
            match,
          })
        }
        return ran
      }
      const launch = launchFromCommand(e.command)
      if (launch) {
        const home = await $.env.get('HOME')
        const cwd = await $.session.cwd()
        const base = launch.cwd ? (resolvePath(launch.cwd, home, cwd) ?? cwd) : cwd
        const log = resolvePath(launch.log, home, base)
        if (log) {
          const match = matchToken(launch.segment)
          await addJob($, {
            id: hashOf(log),
            label: shorten(e.description || match || log.split('/').pop() || log, 40),
            log,
            match,
          })
        }
      }
    } catch (error) {
      $.ui.log(`job-watch: could not register a job: ${String(error)}`, { to: 'debug' })
    }
    return ran
  })

  // The three tools only read and edit the mod's own list of jobs: never a question for the person, though a deny in settings stands.
  on('tool.check', { tool: [...TOOLS] }, async ($, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny'
      ? verdict
      : { decision: 'allow', reason: 'job-watch: reads the watched jobs; starts and stops nothing' }
  })

  on('tool.call', { tool: 'mcp__job-watch__jobs_list' }, async $ => ({ result: await listTool($) }))
  on('tool.call', { tool: 'mcp__job-watch__jobs_watch' }, async ($, e) => ({ result: await watchTool($, e) }))
  on('tool.call', { tool: 'mcp__job-watch__jobs_unwatch' }, async ($, e) => ({ result: await unwatchTool($, e) }))

  on('command.run', { command: 'jobs' }, async $ => {
    ensureTimer($)
    await tick($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: summary(await read($, jobs)) ?? 'No jobs are being watched.' }
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    const [path, ...labelWords] = e.args.trim().split(/\s+/)
    if (!path) {
      return { text: 'Usage: /watch <log path> [label]' }
    }
    const job = await watchJob($, { log: path, pid: null, label: labelWords.join(' ') || null, stallMs: null })
    if (typeof job === 'string') {
      return { text: job }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: `Watching ${job.log}` }
  })

  on('command.run', { command: 'unwatch' }, async ($, e) => ({
    text: `Removed ${(await removeJobs($, e.args.trim())).removed} job(s).`,
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, jobs)
    const diskRows = await read($, disks)
    const now = await $.clock.now()
    const columns = e.viewport?.columns ?? 60
    const barWidth = Math.max(8, Math.min(24, columns - 40))
    const color = (state: JobState) =>
      state === 'running' ? 'green' : state === 'stalled' ? 'red' : state === 'quiet' ? 'yellow' : 'gray'

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && (
          <Text dimColor>
            No jobs yet. Background commands and nohup launches that write to a log show up here; /watch adds any log
            file.
          </Text>
        )}
        {list
          .slice()
          .reverse()
          .map(job => {
            const age = formatDuration((now - Math.max(job.changedAt, job.addedAt)) / 1000)
            const figures = job.progress
              ? `${bar(job.progress.pct, barWidth)} ${job.progress.pct.toFixed(job.progress.pct < 10 ? 1 : 0)}%` +
                (job.progress.total > 0
                  ? `  ${formatCount(job.progress.done)}/${formatCount(job.progress.total)}`
                  : '')
              : ''
            const eta = etaText(job, now)
            const timing =
              job.state === 'done'
                ? `finished ${formatDuration((now - (job.finishedAt ?? now)) / 1000)} ago`
                : `${eta ? `${eta} · ` : ''}log ${age} ago`
            return (
              <Box key={`job-${job.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold dimColor={job.state === 'done'} wrap="truncate-end">
                    {job.label}
                  </Text>
                  <Box flexDirection="row" gap={1}>
                    <Text color={color(job.state)}>{job.state}</Text>
                    <Button
                      key={`rm-${job.id}`}
                      label="×"
                      plain
                      onPress={() => update($, jobs, all => all.filter(one => one.id !== job.id))}
                    />
                  </Box>
                </Box>
                {(figures || timing) && (
                  <Text dimColor={job.state === 'done'}>
                    {figures}
                    {figures ? '  ' : ''}
                    {timing}
                  </Text>
                )}
                {job.lastLine && (
                  <Text dimColor wrap="truncate-end">
                    {job.lastLine}
                  </Text>
                )}
              </Box>
            )
          })}
        {list.some(job => job.state === 'done') && (
          <Button
            key="clear-done"
            label="Clear finished"
            onPress={() => update($, jobs, all => all.filter(job => job.state !== 'done'))}
          />
        )}
        {diskRows.length > 0 && (
          <Box flexDirection="column">
            {diskRows.map(disk => (
              <Text key={`disk-${disk.mount}`} dimColor color={disk.capacityPct >= 90 ? 'red' : undefined}>
                {disk.mount === '/' ? 'This Mac' : disk.mount.replace(/^\/Volumes\//, '')}: {disk.freeGB} GB free (
                {disk.capacityPct}% used)
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
