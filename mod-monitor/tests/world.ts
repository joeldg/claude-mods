import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

import { dayOf, monitorRoot, parseLines } from '../hooks/log'
import type { Line } from '../types'
import { NOW } from './fixtures'

export const HOME = '/Users/me'
export const ROOT = monitorRoot(HOME)
export const SESSION = 'feedface-0000-4000-8000-000000000001'
export const TODAY = dayOf(NOW)
/** This session's file today. */
export const OWN = `${ROOT}/${TODAY}/feedface.jsonl`

type ProcAnswer = { exitCode: number; stdout?: string; stderr?: string } | { deny: string }

export type World = {
  clock: MockClock
  /** The fake disk: path to text. */
  files: Map<string, string>
  /** Every write, with the plugin that made it. */
  writes: { path: string; text: string; by: string }[]
  toasts: { text: string; by: string }[]
  statuses: (string | undefined)[]
  argvs: { argv: string[]; by: string }[]
  opened: string[]
  /** What a process answers, by argv[0]; exit 0 and no output when unlisted. */
  procs: Record<string, ProcAnswer>
  /** What `$.session.id()` answers. */
  sessionId: string
}

/** The entries directly inside `dir`, from the files beneath it. */
function listing(files: Map<string, string>, dir: string): FsEntry[] {
  const prefix = `${dir.replace(/\/+$/, '')}/`
  const seen = new Map<string, FsEntry>()
  for (const [path, text] of files) {
    if (!path.startsWith(prefix)) {
      continue
    }
    const rest = path.slice(prefix.length)
    const cut = rest.indexOf('/')
    const name = cut < 0 ? rest : rest.slice(0, cut)
    if (!seen.has(name)) {
      seen.set(name, { name, kind: cut < 0 ? 'file' : 'dir', size: cut < 0 ? text.length : 0, mtimeMs: 0, isLink: false })
    }
  }
  return [...seen.values()]
}

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** Answers the host beneath every plugin: clock, environment, disk, processes, the model and the screen. */
export function world(on: On, env: Record<string, string> = {}): World {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, ...env })
  const w: World = {
    clock,
    files: new Map(),
    writes: [],
    toasts: [],
    statuses: [],
    argvs: [],
    opened: [],
    procs: {},
    sessionId: SESSION,
  }
  on('session.id', () => ({ value: w.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$, e, next) => {
    w.toasts.push({ text: e.text, by: next.origin.plugin })
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e, next) => ({ value: { tool: `mcp__${next.origin.plugin}__${e.name}` } }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.write', (_$, e, next) => {
    w.files.set(e.path, e.text)
    w.writes.push({ path: e.path, text: e.text, by: next.origin.plugin })
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({ value: listing(w.files, e.path) }))
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) || listing(w.files, e.path).length > 0 }))
  on('process.run', (_$, e, next) => {
    const argv = [...e.argv]
    w.argvs.push({ argv, by: next.origin.plugin })
    if (argv[0] === '/bin/rm') {
      const target = `${argv[argv.length - 1] ?? ''}/`
      for (const path of [...w.files.keys()]) {
        if (path.startsWith(target)) {
          w.files.delete(path)
        }
      }
      return ran(0)
    }
    const answer = w.procs[argv[0] ?? '']
    if (answer && 'deny' in answer) {
      return { deny: answer.deny }
    }
    return ran(answer?.exitCode ?? 0, answer?.stdout ?? '', answer?.stderr ?? '')
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'fine',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
    },
  }))
  return w
}

/** A slash command as the person types it. */
export const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

export const mods = async ($: Engine, args = ''): Promise<string> => (await $.command.run(typed('mods', args))).text ?? ''

/** An interactive session's start, and the monitor's start-up work (it runs behind the start) settled. */
export async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: `${HOME}/project`, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

/** The lines this session's file holds now. */
export const ownLines = (w: World): Line[] => parseLines(w.files.get(OWN) ?? '')

/** The monitor's alerts, as toasted. */
export const alerts = (w: World): string[] => w.toasts.filter(toast => toast.by === 'mod-monitor').map(toast => toast.text)

export const PANE_PROPS = {
  title: 'Mods',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

export const SURFACES = ['terminal', 'desktop'] as const

export const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'mod-monitor', surface, component: 'Pane', requestId: 'mods', props: PANE_PROPS })
