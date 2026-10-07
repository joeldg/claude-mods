import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Disk, Job, JobState } from '../types'
import {
  bar,
  doneOf,
  etaFrom,
  formatCount,
  formatDuration,
  isAlive,
  launchFromCommand,
  matchToken,
  outputFileFromText,
  parseDf,
  parseProgress,
  resolvePath,
} from './parse'

type Engine = EngineInterface

const PANE = 'job-watch'
const TITLE = 'Jobs'
/** A job that ends sooner than this was a quick command, not a long job: it leaves silently. */
const SHORT_MS = 60_000

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
let isTicking = false
let ticks = 0
let hasOpened = false

function etaText(job: Job, now: number): string {
  if (job.etaSeconds === null || job.etaAt === null) {
    return ''
  }
  const left = job.etaSeconds - (now - job.etaAt) / 1000
  return left > 0 ? `ETA ${formatDuration(left)} · ` : 'ETA due · '
}

function summary(list: readonly Job[]): string | undefined {
  const count = (state: JobState) => list.filter(job => job.state === state).length
  const parts = [
    count('running') && `${count('running')} running`,
    count('stalled') && `${count('stalled')} stalled`,
    count('quiet') && `${count('quiet')} quiet`,
  ].filter(Boolean)
  return parts.length > 0 ? `jobs: ${parts.join(' · ')}` : undefined
}

async function refreshDisks($: Engine) {
  const df = await $.process.run(['df', '-k'], { timeoutMs: 10_000 }).catch(() => null)
  if (df?.exitCode === 0) {
    const next: Disk[] = parseDf(df.stdout, config.wantedDisks)
    await update($, disks, () => next)
  }
}

async function readJob($: Engine, job: Job, now: number, ps: string | null): Promise<Job> {
  if (job.state === 'done') {
    return job
  }
  let next = job
  const stat = await $.fs.stat(job.log).catch(() => null)
  if (stat && stat.size !== job.size) {
    const tail = await $.process.run(['tail', '-c', '8192', job.log], { timeoutMs: 10_000 }).catch(() => null)
    const reading = parseProgress(tail?.stdout ?? '')
    const restarted = reading.progress && job.progress && doneOf(reading.progress) < doneOf(job.progress)
    const baseline =
      reading.progress && (!job.baseline || restarted) ? { at: now, done: doneOf(reading.progress) } : job.baseline
    next = {
      ...next,
      size: stat.size,
      changedAt: stat.mtimeMs,
      lastLine: reading.lastLine || job.lastLine,
      progress: reading.progress ?? job.progress,
      baseline,
      etaSeconds: reading.etaSeconds ?? etaFrom(baseline, now, reading.progress ?? job.progress),
      etaAt: now,
    }
  }

  const alive = next.match && ps !== null ? isAlive(ps, next.match) : null
  if (alive === true && !next.seenAlive) {
    next = { ...next, seenAlive: true }
  }
  if (alive === false && !next.seenAlive && now - next.addedAt > config.pollMs * 2) {
    // `ps` never showed the token: it was a bad guess, so judge this job by its log alone.
    next = { ...next, match: null }
  }

  const quietFor = now - Math.max(next.changedAt, next.addedAt)
  const state: JobState =
    alive === false && next.seenAlive
      ? 'done'
      : quietFor > config.stallMs
        ? alive === true
          ? 'stalled'
          : 'quiet'
        : 'running'
  return state === 'done' ? { ...next, state, finishedAt: now, etaSeconds: null, etaAt: null } : { ...next, state }
}

async function tick($: Engine) {
  if (isTicking) {
    return
  }
  isTicking = true
  try {
    ticks += 1
    if (ticks === 1 || ticks % Math.max(1, Math.round(60_000 / config.pollMs)) === 0) {
      await refreshDisks($)
    }
    const list = await read($, jobs)
    if (list.length === 0) {
      $.ui.status(undefined)
      return
    }
    const now = await $.clock.now()
    const needsPs = list.some(job => job.state !== 'done' && job.match)
    const ps = needsPs
      ? await $.process
          .run(['ps', '-axo', 'command='], { timeoutMs: 10_000 })
          .then(out => out.stdout)
          .catch(() => null)
      : null

    const fresh: Job[] = []
    for (const job of list) {
      const next = await readJob($, job, now, ps)
      const lived = now - next.addedAt
      if (next.state === 'done' && job.state !== 'done') {
        if (lived < SHORT_MS) {
          continue
        }
        $.ui.toast(`${next.label} finished after ${formatDuration(lived / 1000)}: ${shorten(next.lastLine, 80)}`, {
          timeoutMs: 10_000,
        })
      }
      if (next.state === 'stalled' && job.state !== 'stalled') {
        $.ui.toast(`${next.label} has written nothing for ${formatDuration(config.stallMs / 1000)}`, {
          timeoutMs: 10_000,
        })
      }
      if (next.state === 'done' && next.finishedAt !== null && now - next.finishedAt > config.keepDoneMs) {
        continue
      }
      if (next.state === 'quiet' && now - next.changedAt > config.keepDoneMs) {
        continue
      }
      fresh.push(next)
    }
    await update($, jobs, () => fresh)
    $.ui.status(summary(fresh))

    const isLong = fresh.some(job => job.state !== 'done' && now - job.addedAt >= SHORT_MS)
    if (config.autoOpen && !hasOpened && isLong) {
      hasOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
  } finally {
    isTicking = false
  }
}

function ensureTimer($: Engine) {
  if (!timer) {
    timer = $.clock.every(config.pollMs, () => void tick($))
  }
}

type NewJob = Pick<Job, 'id' | 'label' | 'log' | 'match'>

async function addJob($: Engine, job: NewJob) {
  const now = await $.clock.now()
  const added: Job = {
    ...job,
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
  }
  await update($, jobs, list => [...list.filter(one => one.log !== added.log), added].slice(-20))
  ensureTimer($)
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
  hasOpened = false

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
    ensureTimer($)
    void tick($)
    return next(e)
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
    const log = resolvePath(path, await $.env.get('HOME'), await $.session.cwd())
    if (!log || !(await $.fs.exists(log))) {
      return { text: `job-watch: ${path} does not exist.` }
    }
    const label = labelWords.join(' ') || log.split('/').pop() || log
    await addJob($, { id: hashOf(log), label: shorten(label, 40), log, match: null })
    await tick($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: `Watching ${log}` }
  })

  on('command.run', { command: 'unwatch' }, async ($, e) => {
    const what = e.args.trim()
    const before = await read($, jobs)
    const keep = before.filter(job =>
      what === 'all'
        ? false
        : what === 'done' || what === ''
          ? job.state !== 'done'
          : job.id !== what && job.label !== what,
    )
    await update($, jobs, () => keep)
    $.ui.status(summary(keep))
    return { text: `Removed ${before.length - keep.length} job(s).` }
  })

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
            const timing =
              job.state === 'done'
                ? `finished ${formatDuration((now - (job.finishedAt ?? now)) / 1000)} ago`
                : `${etaText(job, now)}log ${age} ago`
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
