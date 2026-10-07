import type { Holder, KnownEntry, Listener, Manager, Server } from '../types'

// ---------------------------------------------------------------------------
// lsof and ps output
// ---------------------------------------------------------------------------

/** The port of an lsof address: `*:4000`, `127.0.0.1:5173`, `[::1]:3000`; null for anything else. */
export function portOfAddress(address: string): number | null {
  const local = (address.split('->')[0] ?? '').trim()
  const match = /:(\d{1,5})(?:\s*\(LISTEN\))?$/.exec(local)
  const port = match ? Number(match[1]) : NaN
  return port > 0 && port < 65536 ? port : null
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: one Listener per pid, its ports sorted and deduplicated. */
export function parseListeners(text: string): Listener[] {
  const byPid = new Map<number, Listener>()
  let current: Listener | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      current = Number.isInteger(pid) && pid > 0 ? (byPid.get(pid) ?? { pid, command: '', ports: [] }) : null
      if (current) {
        byPid.set(pid, current)
      }
    } else if (tag === 'c' && current) {
      current.command = value
    } else if (tag === 'n' && current) {
      const port = portOfAddress(value)
      if (port !== null && !current.ports.includes(port)) {
        current.ports.push(port)
      }
    }
  }
  return [...byPid.values()]
    .filter(listener => listener.ports.length > 0)
    .map(listener => ({ ...listener, ports: [...listener.ports].sort((a, b) => a - b) }))
}

/** `lsof -a -p <pids> -d cwd -Fn`: each pid's working directory. */
export function parseCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when it does not read as one. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!match) {
    return null
  }
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return Number(days) * 86_400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** `ps -o pid=,etime=,command= -p <pids>`: each pid's uptime and command line. */
export function parseProcesses(text: string): Map<number, { upSeconds: number | null; commandLine: string }> {
  const rows = new Map<number, { upSeconds: number | null; commandLine: string }>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line)
    if (match) {
      rows.set(Number(match[1]), { upSeconds: parseEtime(match[2] ?? ''), commandLine: match[3] ?? '' })
    }
  }
  return rows
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN` (the table form): the processes listed, header skipped, one per pid. */
export function parsePortTable(text: string): { command: string; pid: number }[] {
  const seen = new Set<number>()
  const holders: { command: string; pid: number }[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(\d+)\s/.exec(line)
    if (match && !line.startsWith('COMMAND')) {
      const pid = Number(match[2])
      if (!seen.has(pid)) {
        seen.add(pid)
        holders.push({ command: match[1] ?? '', pid })
      }
    }
  }
  return holders
}

/** `2h`, `5m`, `3d`, `40s`: the largest whole unit. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) {
    return `${s}s`
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)}h`
  }
  return `${Math.floor(s / 86_400)}d`
}

/** Whether `path` is `root` or lies beneath it. */
export function isInside(path: string, root: string): boolean {
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`)
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

// ---------------------------------------------------------------------------
// Known start commands
// ---------------------------------------------------------------------------

/** Lockfiles in the order they decide the manager. */
export const LOCKFILES: readonly (readonly [string, Manager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

/** The package manager: the first lockfile present, else package.json's `packageManager`, else npm. */
export function detectManager(present: readonly string[], packageManager?: unknown): Manager {
  for (const [file, manager] of LOCKFILES) {
    if (present.includes(file)) {
      return manager
    }
  }
  const named = typeof packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(packageManager) : null
  return (named?.[1] as Manager | undefined) ?? 'npm'
}

/** Script names that start a server: dev, start, serve, preview, dev:*, start:*. */
export function isServerScript(name: string): boolean {
  return /^(dev|start|serve|preview)$/.test(name) || /^(dev|start):./.test(name)
}

/** The `scripts` of a package.json, or null when it does not parse. */
export function packageScripts(text: string): { scripts: Record<string, string>; packageManager?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const record = parsed as { scripts?: unknown; packageManager?: unknown }
    const scripts: Record<string, string> = {}
    if (record.scripts && typeof record.scripts === 'object') {
      for (const [name, body] of Object.entries(record.scripts as Record<string, unknown>)) {
        if (typeof body === 'string') {
          scripts[name] = body
        }
      }
    }
    return { scripts, packageManager: record.packageManager }
  } catch {
    return null
  }
}

type Draft = Omit<KnownEntry, 'id'>

/** The server scripts of a package.json, run with `manager`. */
export function parsePackageJson(text: string, manager: Manager): Draft[] {
  const scripts = packageScripts(text)?.scripts ?? {}
  return Object.entries(scripts)
    .filter(([name]) => isServerScript(name))
    .map(([name, body]) => ({
      name,
      command: `${manager} run ${name}`,
      source: 'package.json' as const,
      port: portFromCommand(body),
      matchText: resolveScript(body, scripts),
    }))
}

/** JSON with `//` and block comments and trailing commas, as VS Code writes launch.json. */
export function parseLooseJson(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[++i] ?? ''
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += char
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** `.claude/launch.json` configurations that run a command: name, runtimeExecutable + runtimeArgs, port. */
export function parseLaunchJson(text: string): Draft[] {
  let parsed: unknown
  try {
    parsed = parseLooseJson(text)
  } catch {
    return []
  }
  const configurations = (parsed as { configurations?: unknown } | null)?.configurations
  if (!Array.isArray(configurations)) {
    return []
  }
  const drafts: Draft[] = []
  for (const item of configurations as unknown[]) {
    const config = (item ?? {}) as { name?: unknown; runtimeExecutable?: unknown; runtimeArgs?: unknown; port?: unknown }
    if (typeof config.name !== 'string' || typeof config.runtimeExecutable !== 'string' || !config.runtimeExecutable) {
      continue
    }
    const args = Array.isArray(config.runtimeArgs) ? config.runtimeArgs.map(String) : []
    const command = [config.runtimeExecutable, ...args].map(shellQuote).join(' ')
    const port = Number(config.port)
    drafts.push({
      name: config.name,
      command,
      source: 'launch.json',
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : portFromCommand(command),
      matchText: command,
    })
  }
  return drafts
}

/** Procfile lines, `name: command`. */
export function parseProcfile(text: string): Draft[] {
  const drafts: Draft[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(\S.*?)\s*$/.exec(line)
    if (match && !line.trimStart().startsWith('#')) {
      const command = match[2] ?? ''
      drafts.push({ name: match[1] ?? '', command, source: 'Procfile', port: portFromCommand(command), matchText: command })
    }
  }
  return drafts
}

/** The package script a command runs (`npm run dev`, `pnpm dev`, `yarn start`, `bun run dev`), or null. */
export function scriptCalled(command: string): string | null {
  const match = /^\s*(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.@/-]+)\s*$/.exec(command)
  if (!match) {
    return null
  }
  const [, manager, name = ''] = match
  // `npm dev` is not a script call; npm runs only start, stop, test and restart bare.
  if (manager === 'npm' && !/^\s*npm\s+run/.test(command) && name !== 'start') {
    return null
  }
  return name
}

/** A script's body, followed one level when it only calls another script. */
export function resolveScript(body: string, scripts: Record<string, string>): string {
  const called = scriptCalled(body)
  return called !== null && scripts[called] !== undefined ? scripts[called] : body
}

/** The port a command line names: `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000`, `--bind :8000`, `runserver 8000`. */
export function portFromCommand(command: string): number | null {
  const patterns = [
    /--port[=\s]+(\d{2,5})\b/,
    /(?:^|\s)-p\s*(\d{2,5})(?=\s|$)/,
    /\bPORT=(\d{2,5})\b/,
    /--(?:bind|listen)[=\s]+[\w.[\]]*:(\d{2,5})\b/,
    /\brunserver\s+(?:[\w.[\]]+:)?(\d{2,5})\b/,
    /\bhttp\.server\s+(\d{2,5})\b/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(command)
    const port = match ? Number(match[1]) : NaN
    if (port > 0 && port < 65536) {
      return port
    }
  }
  return null
}

/** A lowercase, file-name-safe id: `dev:api` → `dev-api`. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  )
}

/**
 * Every known way to start this project's servers: launch.json first (it names ports), then the
 * Procfile, then package.json scripts those two do not already run. Names and ids made unique.
 */
export function knownEntries(sources: {
  packageJson: string | null
  launchJson: string | null
  procfile: string | null
  manager: Manager
}): KnownEntry[] {
  const scripts = sources.packageJson === null ? {} : (packageScripts(sources.packageJson)?.scripts ?? {})
  const withScripts = (draft: Draft): Draft => {
    const called = scriptCalled(draft.command)
    const body = called === null ? undefined : scripts[called]
    if (body === undefined) {
      return draft
    }
    const matchText = resolveScript(body, scripts)
    return { ...draft, matchText, port: draft.port ?? portFromCommand(body) }
  }
  const front = [
    ...(sources.launchJson === null ? [] : parseLaunchJson(sources.launchJson)),
    ...(sources.procfile === null ? [] : parseProcfile(sources.procfile)),
  ].map(withScripts)
  const covered = new Set(front.map(draft => scriptCalled(draft.command)).filter(name => name !== null))
  const fromPackage =
    sources.packageJson === null
      ? []
      : parsePackageJson(sources.packageJson, sources.manager).filter(draft => !covered.has(draft.name))

  const names = new Set<string>()
  const ids = new Set<string>()
  const entries: KnownEntry[] = []
  for (const draft of [...front, ...fromPackage]) {
    const name = names.has(draft.name) ? `${draft.name} (${draft.source})` : draft.name
    names.add(name)
    let id = slug(name)
    for (let n = 2; ids.has(id); n++) {
      id = `${slug(name)}-${n}`
    }
    ids.add(id)
    entries.push({ ...draft, name, id })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Matching running servers to known entries
// ---------------------------------------------------------------------------

/** Words a command is launched through, skipped to reach the program itself. */
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'exec', 'nohup', 'cross-env', 'env', 'nice', 'time'])

/** Interpreters whose name alone says nothing: their arguments must match as well. */
const GENERIC = new Set(['node', 'python', 'ruby', 'bun', 'deno', 'php', 'java', 'sh', 'bash', 'zsh', 'perl', 'tsx', 'ts-node', 'go', 'dotnet', 'uv', 'poetry'])

/** Splits a command line into words, honouring single and double quotes. */
export function tokenize(command: string): string[] {
  const words: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(command); match !== null; match = pattern.exec(command)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return words
}

/** A program's name without its folder, version or script suffix: `/usr/bin/python3.12` → `python`. */
export function programName(word: string): string {
  return basename(word)
    .toLowerCase()
    .replace(/\.(c|m)?js$|\.exe$/, '')
    .replace(/([a-z])[\d.]+$/, '$1')
}

/** The program and its plain arguments (no flags, no variables) of a command's last segment. */
export function programWords(command: string): { program: string; args: string[] } | null {
  const segment = command.split(/&&|\|\||;/).map(part => part.trim()).filter(Boolean).pop() ?? ''
  const words = tokenize(segment.split(/[|<>]/)[0] ?? '')
  while (words.length > 0 && (/^\w+=/.test(words[0] ?? '') || WRAPPERS.has(words[0] ?? ''))) {
    words.shift()
  }
  const [first, ...rest] = words
  if (first === undefined) {
    return null
  }
  return { program: programName(first), args: rest.filter(word => !word.startsWith('-') && !word.includes('$')) }
}

/**
 * How well a process's command line fits a start command: 2 for its program and every argument,
 * 1 for the program alone (never for a bare interpreter such as node), 0 for no fit.
 */
export function commandScore(command: string, commandLine: string): number {
  const words = programWords(command)
  if (words === null) {
    return 0
  }
  const tokens = tokenize(commandLine)
  const hasProgram = tokens.some(token => {
    const name = programName(token)
    return name === words.program || name.startsWith(`${words.program}-`)
  })
  if (!hasProgram) {
    return 0
  }
  const hasArgs = words.args.every(arg => {
    const bare = arg.replace(/^\.\//, '')
    return tokens.some(token => token === arg || token === bare || token.endsWith(`/${bare}`))
  })
  return hasArgs ? 2 : GENERIC.has(words.program) ? 0 : 1
}

/** How well a running server fits an entry: 3 by port, else commandScore. */
export function matchScore(entry: KnownEntry, server: Pick<Server, 'ports' | 'commandLine'>): number {
  if (entry.port !== null && server.ports.includes(entry.port)) {
    return 3
  }
  return commandScore(entry.matchText, server.commandLine)
}

/** Names each server by its best-fitting entry (earliest on a tie) and lists the entries none fits. */
export function matchServers(
  servers: readonly Server[],
  entries: readonly KnownEntry[],
): { servers: Server[]; stopped: KnownEntry[] } {
  const used = new Set<string>()
  const named = servers.map(server => {
    let best: KnownEntry | null = null
    let bestScore = 0
    for (const entry of entries) {
      const score = matchScore(entry, server)
      if (score > bestScore) {
        best = entry
        bestScore = score
      }
    }
    if (best === null) {
      return { ...server, entryId: null }
    }
    used.add(best.id)
    return { ...server, entryId: best.id, name: best.name }
  })
  return { servers: named, stopped: entries.filter(entry => !used.has(entry.id)) }
}

/** Ports as the status line and the pane draw them: `:4000 :5173`. */
export function portList(ports: readonly number[]): string {
  return ports.map(port => `:${port}`).join(' ')
}

/** The status line: `servers: :4000 :5173`, or undefined when no project server is up. */
export function statusLine(servers: readonly Server[]): string | undefined {
  const ports = [...new Set(servers.flatMap(server => server.ports))].sort((a, b) => a - b)
  return ports.length > 0 ? `servers: ${portList(ports)}` : undefined
}

// ---------------------------------------------------------------------------
// Starting, logs and port conflicts
// ---------------------------------------------------------------------------

/** A word the shell reads back as itself. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** A short stable hash, base 36. */
export function hashOf(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** The project's folder name under the log folder: `myapp-1x2y3z`. */
export function projectKey(root: string): string {
  return `${slug(basename(root) || 'root')}-${hashOf(root)}`
}

/** Where an entry started from the pane writes its output. */
export function logPath(logDir: string, root: string, entry: Pick<KnownEntry, 'id'>): string {
  return `${logDir.replace(/\/+$/, '')}/${projectKey(root)}/${entry.id}.log`
}

/** `~` and `$HOME` at the start of a path, expanded. */
export function expandHome(path: string, home: string | undefined): string {
  if (!home) {
    return path
  }
  return path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)
}

/**
 * The `sh -c` script that starts a command detached from the session: in the project root, its
 * output to the log, its input from /dev/null. A command with shell operators runs under its own sh.
 */
export function startScript(root: string, command: string, log: string): string {
  const program = /&&|\|\||;|\|/.test(command) ? `sh -c ${shellQuote(command)}` : command
  return `mkdir -p ${shellQuote(dirname(log))} && cd ${shellQuote(root)} && nohup ${program} > ${shellQuote(log)} 2>&1 < /dev/null &`
}

/** The last `count` non-empty lines of a log's tail. */
export function lastLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n|\r/)
    .map(line => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-count)
}

/**
 * Whether a command's output says a port was taken, and which: `EADDRINUSE ... :::4000`,
 * `Port 5173 is already in use`, `listen tcp :8080: bind: address already in use`.
 * `{ port: null }` when it says so without naming the port; null when it does not say so.
 */
export function findConflict(text: string): { port: number | null } | null {
  if (!/EADDRINUSE|address already in use|port \d+ is already in use/i.test(text)) {
    return null
  }
  const patterns = [
    /port (\d{1,5}) is already in use/i,
    /EADDRINUSE[^\n]*?:(\d{1,5})\b/,
    /:(\d{1,5}):? bind: address already in use/i,
    /address already in use[^\n]*?\bport (\d{1,5})\b/i,
    /address already in use[^\n]*?:(\d{1,5})\b/i,
    /\bport (\d{1,5})\b[^\n]*address already in use/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const port = match ? Number(match[1]) : NaN
    if (port > 0 && port < 65536) {
      return { port }
    }
  }
  return { port: null }
}

/** `Port 4000 is held by node (pid 123, up 2h, in /Users/me/other)`. */
export function holderNote(port: number, holder: Holder): string {
  const details = [
    `pid ${holder.pid}`,
    holder.upSeconds === null ? null : `up ${formatUptime(holder.upSeconds)}`,
    holder.cwd === null ? null : `in ${holder.cwd}`,
  ].filter(Boolean)
  return `Port ${port} is held by ${holder.command} (${details.join(', ')})`
}

/** One server as a line: `dev · :5173 · pid 4242 · up 2h`. */
export function serverLine(server: Server): string {
  return [
    server.name,
    portList(server.ports),
    `pid ${server.pid}`,
    server.upSeconds === null ? null : `up ${formatUptime(server.upSeconds)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** What /servers prints: the running servers, the stopped entries, the other listeners. */
export function describe(snapshot: {
  root: string
  servers: readonly Server[]
  stopped: readonly KnownEntry[]
  others: number
}): string {
  const lines = [
    snapshot.servers.length === 0
      ? `No dev servers are listening in ${snapshot.root}.`
      : `Running in ${snapshot.root}:\n${snapshot.servers.map(server => `  ${serverLine(server)}`).join('\n')}`,
  ]
  if (snapshot.stopped.length > 0) {
    lines.push(`Not running: ${snapshot.stopped.map(entry => `${entry.name} (${entry.command})`).join(', ')}`)
  }
  lines.push(`${snapshot.others} other listener${snapshot.others === 1 ? '' : 's'} on this Mac.`)
  return lines.join('\n')
}

