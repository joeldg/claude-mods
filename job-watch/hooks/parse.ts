import type { Disk, Progress } from '../types'

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
/** The line Claude Code's task runner appends to a background task's .output file when it ends. */
const EXITED = /^\[exited with code (\d+)\]$/

/** The .output file a background Bash task writes to, read from the text the model got back. */
export const outputFileFromText = (text: string | undefined): string | null =>
  text?.match(/Output is being written to: (\S+?\.output)\b/)?.[1] ?? null

const LAUNCH_NOISE = new Set(['nohup', 'nice', 'caffeinate', 'env', 'exec', 'time', 'setsid'])
const GENERIC = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node', 'uv', 'poetry', 'ruby'])
const POLLERS = /^(sleep|tail|until|while|watch|wait|gh|git|ls|cat|echo|ps|pgrep)$/

const unquote = (word: string): string => word.replace(/^["']|["']$/g, '')

const splitWords = (segment: string): string[] => segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) ?? []

/**
 * The index of the first word that is a program: past assignments, the `skipped` words (launch
 * wrappers, and for the timer detector the shell's keywords) and a wrapper's options (`nice -n 15`).
 */
const programIndex = (words: readonly string[], skipped: ReadonlySet<string>): number => {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || skipped.has(word)) {
      index += word === 'nice' && words[index + 1] === '-n' ? 3 : 1
      continue
    }
    if (word.startsWith('-') && index > 0 && LAUNCH_NOISE.has(words[index - 1] ?? '')) {
      index += 1
      continue
    }
    break
  }
  return index
}

/**
 * A substring that `ps -axo command=` shows while the job runs: a `-m` module, a
 * script path, or the executable, after launch wrappers and env assignments.
 */
export const matchToken = (segment: string): string | null => {
  const words = splitWords(segment.split(/\s(?:>>?|2>|&>|<)\s?/)[0] ?? '')
  const rest = words.slice(programIndex(words, LAUNCH_NOISE))
  const moduleAt = rest.indexOf('-m')
  if (moduleAt >= 0 && rest[moduleAt + 1]) {
    return rest[moduleAt + 1] ?? null
  }
  const script = rest.find(word => /\.(py|sh|js|mjs|ts|rb)$/.test(word))
  if (script) {
    return script.replace(/^\.\//, '')
  }
  const head = rest[0]?.split('/').pop()
  if (!head || POLLERS.test(head)) {
    return null
  }
  if (GENERIC.has(head.replace(/\d+(\.\d+)?$/, ''))) {
    return rest[1] && !rest[1].startsWith('-') ? rest[1] : null
  }
  // A plain executable (`tar`, `ffmpeg`) is too common alone: keep its first literal arguments.
  const literal: string[] = []
  for (const word of rest.slice(0, 3)) {
    if (/[$`]/.test(word)) {
      break
    }
    literal.push(word)
  }
  return literal.join(' ') || null
}

/** What a pure wait is made of: a `sleep`, or a bare `timeout`. */
const TIMER_PROGRAMS = new Set(['sleep', 'timeout'])
/** What may dress a timer without making it a job: echoes, shell tests and the clock. */
const TRIVIAL_PROGRAMS = new Set([
  'echo', 'printf', 'date', 'true', 'false', ':', 'test', '[', '[[', ']', ']]', 'wait', 'exit', 'seq',
])
/**
 * Programs that only read. A task described as a wait may poll a log or a process with these and
 * report with them when it wakes (`until rg -q done log; do sleep 30; done; tail -3 log`) and still
 * be a wait, not a job.
 */
const READING_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'wc', 'cut', 'tr', 'sort', 'uniq', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'jq',
  'ls', 'stat', 'du', 'df', 'file', 'basename', 'dirname', 'readlink', 'realpath', 'pwd',
  'pgrep', 'ps', 'top', 'sysctl', 'vm_stat', 'uptime', 'uname', 'hostname', 'ioreg', 'plutil',
])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'in', '!', '{', '}'])
const SKIPPED = new Set([...LAUNCH_NOISE, ...KEYWORDS])
/** `timeout`'s options that take a value. */
const TIMEOUT_VALUED = new Set(['-k', '-s', '--kill-after', '--signal'])
const TIMER_WORDS = /\b(wait|timer|pause|delay)\b/i
/** A command's words, quotes kept whole, and its control operators. */
const TOKENS = /"[^"]*"|'[^']*'|&&|\|\||[;|&\n]|[^\s;|&"']+/g
const OPERATOR = /^(?:&&|\|\||[;|&\n])$/
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g
/** A redirection (`> log`, `2>&1`, `&>/dev/null`), whose `&` is no control operator. */
const REDIRECTION = /\d*[<>]+&?\d*|&>>?/g

const basename = (word: string): string => word.split('/').pop() || word

/** The words of each simple command in `text`: split at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. */
const simpleCommands = (text: string): string[][] => {
  const commands: string[][] = [[]]
  for (const token of text.match(TOKENS) ?? []) {
    if (OPERATOR.test(token)) {
      commands.push([])
    } else {
      commands[commands.length - 1]?.push(unquote(token))
    }
  }
  return commands.filter(words => words.length > 0)
}

/** The command `timeout` runs, past its options and the duration; null for a bare `timeout N`. */
const timedOut = (words: readonly string[], from: number): string | null => {
  let at = from
  while (words[at]?.startsWith('-')) {
    at += TIMEOUT_VALUED.has(words[at] ?? '') ? 2 : 1
  }
  if (/^\d+(\.\d+)?[smhd]?$/.test(words[at] ?? '')) {
    at += 1
  }
  const wrapped = words[at]
  return wrapped ? basename(wrapped) : null
}

/**
 * The program each simple command of `command` runs (`sleep 600 && echo done` → sleep, echo): what
 * `$(…)` and backticks run counted too, assignments, launch wrappers (nohup, nice…) and shell keywords
 * skipped, redirections ignored, a `for` list passed over, and the command `timeout` wraps named after it.
 */
export const programsOf = (command: string): string[] => {
  const programs: string[] = []
  const text = command
    .replace(SUBSTITUTION, (_whole: string, inner: string | undefined, ticked: string | undefined) => {
      programs.push(...programsOf(inner ?? ticked ?? ''))
      return ' '
    })
    .replace(REDIRECTION, ' ')
    .replace(/[()]/g, ' ')
  for (const words of simpleCommands(text)) {
    const index = programIndex(words, SKIPPED)
    const head = words[index]
    if (!head || words[0] === 'for') {
      continue
    }
    const program = basename(head)
    programs.push(program)
    const wrapped = program === 'timeout' ? timedOut(words, index + 1) : null
    if (wrapped) {
      programs.push(wrapped)
    }
  }
  return programs
}

/**
 * Whether a background command is a pure wait: a `sleep` (or a bare `timeout`) dressed at most with
 * echoes, tests and the clock; or, when described as a wait, timer, pause or delay, one that at most
 * polls and reports with programs that only read (rg, tail, pgrep…). Such a task is tracked but never
 * announced. Anything that runs a real program is a job, however it is described.
 */
export const isTimerTask = (command: string, description = ''): boolean => {
  const programs = programsOf(command)
  if (programs.length === 0) {
    return false
  }
  const isAllowed = (program: string, mayRead: boolean) =>
    TIMER_PROGRAMS.has(program) || TRIVIAL_PROGRAMS.has(program) || (mayRead && READING_PROGRAMS.has(program))
  const isPureTimer =
    programs.some(program => TIMER_PROGRAMS.has(program)) && programs.every(program => isAllowed(program, false))
  const isDescribedWait = TIMER_WORDS.test(description) && programs.every(program => isAllowed(program, true))
  return isPureTimer || isDescribedWait
}

export type Launch = { log: string; segment: string; cwd: string | null }

/**
 * A detached launch the command starts (`nohup … > log &`, `… >> log 2>&1 & disown`):
 * the redirect target and the segment that writes to it, with the last `cd` before it.
 */
export const launchFromCommand = (command: string): Launch | null => {
  const segments = command.split(/\s*(?:&&|;|\n|\|\|)\s*/)
  let cwd: string | null = null
  for (let i = 0; i < segments.length; i++) {
    const segment = (segments[i] ?? '').trim()
    const cd = segment.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/)
    if (cd?.[1]) {
      cwd = cd[1].replace(/^["']|["']$/g, '')
      continue
    }
    const isDetached = /^nohup\b|\bnohup\s/.test(segment) || /&\s*(disown)?\s*$/.test(segment)
    if (!isDetached) {
      continue
    }
    const target = [...segment.matchAll(/(?:^|\s)(?:\d?>>?|&>)\s*("[^"]+"|'[^']+'|[^\s&;|]+)/g)]
      .map(found => (found[1] ?? '').replace(/^["']|["']$/g, ''))
      .find(path => path !== '/dev/null' && !path.startsWith('&'))
    if (target) {
      return { log: target, segment: segment.replace(/&\s*(disown)?\s*$/, '').trim(), cwd }
    }
  }
  return null
}

/** `~` and `$HOME` expanded, relative paths put under `cwd`; null when another variable is left. */
export const resolvePath = (path: string, home: string | undefined, cwd: string): string | null => {
  let out = path
  if (home) {
    out = out.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home)
  }
  if (out.includes('$') || out.startsWith('~')) {
    return null
  }
  if (!out.startsWith('/')) {
    out = `${cwd.replace(/\/$/, '')}/${out.replace(/^\.\//, '')}`
  }
  return out
}

const UNITS: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }

const amount = (value: string, unit = ''): number =>
  Number(value.replace(/,/g, '')) * (UNITS[unit.toUpperCase().replace(/I?B$/, '')] ?? 1)

const clockSeconds = (text: string): number | null => {
  if (!/^\d+(:\d+){1,2}$/.test(text)) {
    return null
  }
  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

const progressOf = (done: number, total: number): Progress | null =>
  total > 0 && done >= 0 && done <= total * 1.001
    ? { done, total, pct: Math.min(100, (done / total) * 100) }
    : null

export type Reading = { progress: Progress | null; etaSeconds: number | null; lastLine: string }

const TQDM = /(\d{1,3}(?:\.\d+)?)%\|[^|]*\|\s*([\d.,]+)([kKMGT]?)\/([\d.,]+)([kKMGT]?)\s*\[[^<\]]*<([\d:]+|\?)/
const COUNTED =
  /\b(?:step|iter(?:ation)?|epoch|batch|item|file|object|asset|sample|shard|chunk|scan|mesh|video|frame)s?\b\s*[:=#]?\s*([\d,]+)\s*(?:\/|of)\s*([\d,]+)/i
const COUNTED_AFTER =
  /\b([\d,]+)\s*(?:\/|of)\s*([\d,]+)\s+(?:steps|iterations|epochs|batches|items|files|objects|assets|samples|shards|chunks|scans|meshes|videos|frames)\b/i
const BRACKETED = /\[\s*([\d,]+)\s*\/\s*([\d,]+)\s*\]/
const SIZED = /([\d.]+)\s*([KMGT])i?B?\s*(?:\/|of)\s*([\d.]+)\s*([KMGT])i?B?\b/i
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/g

/** Reads the newest progress figure from a log's tail, and its last line. */
export const parseProgress = (tail: string): Reading => {
  const lines = tail
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !EXITED.test(line))
  const lastLine = (lines[lines.length - 1] ?? '').slice(0, 200)

  for (const line of lines.slice(-60).reverse()) {
    const tqdm = line.match(TQDM)
    if (tqdm) {
      const done = amount(tqdm[2] ?? '0', tqdm[3])
      const total = amount(tqdm[4] ?? '0', tqdm[5])
      const progress = progressOf(done, total) ?? { done: 0, total: 0, pct: Number(tqdm[1]) }
      return { progress, etaSeconds: clockSeconds(tqdm[6] ?? ''), lastLine }
    }
    const counted = line.match(COUNTED) ?? line.match(COUNTED_AFTER) ?? line.match(BRACKETED)
    if (counted) {
      const progress = progressOf(amount(counted[1] ?? ''), amount(counted[2] ?? ''))
      if (progress) {
        return { progress, etaSeconds: null, lastLine }
      }
    }
    const sized = line.match(SIZED)
    if (sized) {
      const progress = progressOf(amount(sized[1] ?? '', sized[2]), amount(sized[3] ?? '', sized[4]))
      if (progress) {
        return { progress, etaSeconds: null, lastLine }
      }
    }
    const percents = [...line.matchAll(PERCENT)].map(found => Number(found[1]))
    const pct = percents.filter(value => value <= 100).pop()
    if (pct !== undefined) {
      return { progress: { done: 0, total: 0, pct }, etaSeconds: null, lastLine }
    }
  }
  return { progress: null, etaSeconds: null, lastLine }
}

/** The exit code a background task's .output file ends with, read from its tail; null while it still runs. */
export const exitCodeOf = (tail: string): number | null => {
  const last = tail
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .pop()
  const found = last?.match(EXITED)
  return found ? Number(found[1]) : null
}

/** How far along, in the reading's own unit: its count, or its percentage when it has no count. */
export const doneOf = (progress: Progress): number => (progress.total > 0 ? progress.done : progress.pct)

const totalOf = (progress: Progress): number => (progress.total > 0 ? progress.total : 100)

/** Seconds left from the average rate since `baseline`, or null when it cannot be told yet. */
export const etaFrom = (
  baseline: { at: number; done: number } | null,
  now: number,
  progress: Progress | null,
): number | null => {
  if (!baseline || !progress || now <= baseline.at) {
    return null
  }
  const perMs = (doneOf(progress) - baseline.done) / (now - baseline.at)
  return perMs > 0 ? Math.round((totalOf(progress) - doneOf(progress)) / perMs / 1000) : null
}

/** Whether a `ps` listing of command lines (with or without a pid column) shows the job, ignoring our own probes. */
export const isAlive = (psOutput: string, match: string): boolean =>
  psOutput
    .split('\n')
    .some(line => line.includes(match) && !/^\s*(?:\d+\s+)?(ps|pgrep|tail -c)\b/.test(line))

/** Whether a `ps` listing led by a pid column (`pid=,command=`, or `pid=` alone) shows the pid. */
export const isPidAlive = (psOutput: string, pid: number): boolean =>
  psOutput.split('\n').some(line => /^\s*(\d+)\b/.exec(line)?.[1] === String(pid))

/** `df -k` rows for `/` and `/Volumes/*` (or the listed mounts), skipping Time Machine volumes. */
export const parseDf = (output: string, wanted: readonly string[]): Disk[] => {
  const disks: Disk[] = []
  for (const line of output.split('\n').slice(1)) {
    const found = line.match(/^\S+(?:\s+\S+)*?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(?:\d+\s+\d+\s+\d+%\s+)?(\/.*)$/)
    if (!found) {
      continue
    }
    const mount = found[5] ?? ''
    const isWanted =
      wanted.length > 0
        ? wanted.includes(mount)
        : mount === '/' || (mount.startsWith('/Volumes/') && !mount.includes('Backups of'))
    if (isWanted && !disks.some(disk => disk.mount === mount)) {
      disks.push({
        mount,
        freeGB: Math.round(Number(found[3]) / 1024 / 1024),
        capacityPct: Number(found[4]),
      })
    }
  }
  return disks
}

export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) {
    return `${s}s`
  }
  const minutes = Math.round(s / 60)
  if (minutes < 90) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.round(hours / 24)}d`
}

export const formatCount = (value: number): string =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(1)}G`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}M`
      : value >= 1e4
        ? `${(value / 1e3).toFixed(1)}k`
        : String(Math.round(value))

export const bar = (pct: number, width: number): string => {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
