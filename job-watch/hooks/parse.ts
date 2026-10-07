import type { Disk, Progress } from '../types'

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** The .output file a background Bash task writes to, read from the text the model got back. */
export const outputFileFromText = (text: string | undefined): string | null =>
  text?.match(/Output is being written to: (\S+?\.output)\b/)?.[1] ?? null

const LAUNCH_NOISE = new Set(['nohup', 'nice', 'caffeinate', 'env', 'exec', 'time', 'setsid'])
const GENERIC = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node', 'uv', 'poetry', 'ruby'])
const POLLERS = /^(sleep|tail|until|while|watch|wait|gh|git|ls|cat|echo|ps|pgrep)$/

const splitWords = (segment: string): string[] =>
  segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map(word => word.replace(/^["']|["']$/g, '')) ?? []

/**
 * A substring that `ps -axo command=` shows while the job runs: a `-m` module, a
 * script path, or the executable, after launch wrappers and env assignments.
 */
export const matchToken = (segment: string): string | null => {
  const words = splitWords(segment.split(/\s(?:>>?|2>|&>|<)\s?/)[0] ?? '')
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || LAUNCH_NOISE.has(word)) {
      index += word === 'nice' && words[index + 1] === '-n' ? 3 : 1
      continue
    }
    if (word.startsWith('-') && index > 0 && LAUNCH_NOISE.has(words[index - 1] ?? '')) {
      index += 1
      continue
    }
    break
  }
  const rest = words.slice(index)
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
    .filter(line => line.length > 0)
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

/** Whether `ps -axo command=` output shows the job, ignoring our own probes. */
export const isAlive = (psOutput: string, match: string): boolean =>
  psOutput
    .split('\n')
    .some(line => line.includes(match) && !/^\s*(ps|pgrep|tail -c)\b/.test(line))

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
