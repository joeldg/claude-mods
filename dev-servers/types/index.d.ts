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

/** One process listening on TCP, from `lsof -F pcn`. */
export type Listener = { pid: number; command: string; ports: number[] }

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
