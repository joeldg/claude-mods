/** A package manager, picked from the project's lockfile. */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Where a known start command was read from. */
export type EntrySource = 'package.json' | 'launch.json' | 'Procfile'

/** A way to start one of this project's servers. */
export type KnownEntry = {
  /** Unique within the project, safe in a file name and a Button key. */
  id: string
  name: string
  /** The shell command line that starts it, run from the project root. */
  command: string
  source: EntrySource
  /** The port it listens on, when the entry says (launch.json `port`, `--port 3000`, `PORT=3000`). */
  port: number | null
  /** The command line its process runs, for matching against `ps`: a package script's body, else `command`. */
  matchText: string
}

/**
 * One process listening on TCP, from `netstat -anv -p tcp` (macOS), `ss -ltnp` (Linux) or, failing both,
 * `lsof -F pcn`; `command` as that table names the process, '' when it has no name column.
 */
export type Listener = { pid: number; command: string; ports: number[] }

/** What `ps` and `lsof -d cwd` say about one listening pid, asked once and kept while it listens. */
export type ProcessDetail = {
  /** Its command line as `ps` prints it; null when ps found no such process. */
  commandLine: string | null
  /** When it started, in `$.clock.now()` milliseconds; null when ps did not say. */
  startedAt: number | null
  /** Its working directory; null when lsof could not say, or was not asked (a system program). */
  cwd: string | null
}

/** A listener as the shared scan cache keeps it: `detail` is null until its pid has been looked up. */
export type CachedListener = Listener & { detail: ProcessDetail | null }

/** `~/.claude/dev-servers/scan-cache.json`: the last scan any session made, for every session to read. */
export type ScanCache = { ts: number; by: string; data: { listeners: CachedListener[] } }

/** `~/.claude/dev-servers/scan-lock.json`: the session scanning now, and since when. */
export type ScanLock = { ts: number; by: string }

/** A listening process whose working directory is inside the project. */
export type Server = {
  pid: number
  /** The matched entry's name, else the process's own name. */
  name: string
  /** The id of the known entry this server matched, or null. */
  entryId: string | null
  ports: number[]
  cwd: string
  upSeconds: number | null
  /** Its command line as `ps` prints it. */
  commandLine: string
}

/** What one scan found. */
export type Snapshot = {
  root: string
  servers: Server[]
  entries: KnownEntry[]
  /** Known entries no running server matched. */
  stopped: KnownEntry[]
  /** Listening processes outside the project. */
  others: number
  /** Those processes, for the dev_servers tool's `all`. */
  otherListeners: CachedListener[]
  /** Claude Code's own sessions among the listeners (the desktop app's engine, the CLI): left out of every list, counted. */
  claudeSessions: number
  /** When the listeners were scanned, by whichever session did. */
  scannedAt: number
  /** When this snapshot was made. */
  at: number
}

/** The process holding a port, for a conflict note. */
export type Holder = { pid: number; command: string; upSeconds: number | null; cwd: string | null }

declare module 'claude-code' {
  interface PluginState {
    'dev-servers': {
      snapshot: Snapshot | null
      /** What is under way per row (`pid-4242`, `entry-dev`): `stopping`, `starting`, `restarting`. */
      busy: Record<string, string>
      /** Pids whose Stop was pressed: until this time a second press force stops. */
      armed: Record<string, number>
    }
  }
}
