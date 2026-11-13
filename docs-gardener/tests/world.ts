import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On, ToolSpec } from 'claude-code'

export const HOME = '/home/dev'
export const ROOT = '/home/dev/widgets'
/** Monday 2026-10-12 09:00 UTC: ISO week 2026-42. */
export const NOW = Date.UTC(2026, 9, 12, 9, 0)
export const DAY = 86_400_000
export const WEEK = '2026-42'
export const MODEL = 'claude-haiku-5-5'
export const USAGE = { input_tokens: 2_000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** A paragraph of more than 200 characters, written in two docs. */
export const PARAGRAPH =
  'The importer skips rows whose widget id is missing and logs them to the import report; a second run with the same file is safe because every row is keyed by its id, so re-importing never duplicates widgets, and the report lists the rows that were skipped and why.'

export const README = [
  '# Widgets',
  '',
  'Build the data with `scripts/build_data.sh`, then run `scripts/run_tests.sh`.',
  'Deploy with `make deploy`; lint with `make lint`.',
  'The loader calls `parse_config` and then `load_widgets` for each entry.',
  '',
  '## Known issues',
  '',
  PARAGRAPH,
  '',
  '## Tasks',
  '',
  '- [ ] Move the fixtures next to the tests',
  '- TODO: document the retry policy',
  '',
].join('\n')

export const RUNBOOK = ['# Runbook', '', 'See the [guide](guide.md) for the setup.', '', '## Known issues', '', PARAGRAPH, ''].join('\n')
export const GUIDE = ['# Guide', '', 'Back to the [README](../README.md). Tests: `../scripts/run_tests.sh`.', ''].join('\n')
export const OLD_DESIGN = ['# Old design', '', 'The loader in `src/config.py` reads the widgets table once at start.', ''].join('\n')
export const PLAN = ['---', 'status: done', '---', '# Plan: import v2', '', 'Shipped in September.', ''].join('\n')
export const CLAUDE_MD = ['# Project rules', '', 'Run the tests before committing.', ''].join('\n')
export const BIG = ['# Big', ...Array.from({ length: 449 }, (_, i) => `line ${i + 2}`), ''].join('\n')

export const DIGEST_DAYS = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
export const ROLLUP = `docs/digests/ROLLUP-${WEEK}.md`

/** The docs in scope, by path relative to the root. */
export const DOCS: Record<string, string> = {
  'README.md': README,
  'CLAUDE.md': CLAUDE_MD,
  'docs/runbook.md': RUNBOOK,
  'docs/guide.md': GUIDE,
  'docs/old-design.md': OLD_DESIGN,
  'docs/plans/2026-09-plan.md': PLAN,
  'docs/big.md': BIG,
  ...Object.fromEntries(DIGEST_DAYS.map(day => [`docs/digests/${day}.md`, `# Digest ${day}\n\nNothing notable.\n`])),
}

/** Vendored and built docs, never in scope; each would be flagged if it leaked in. */
export const EXCLUDED_DOCS: Record<string, string> = {
  'node_modules/pkg/README.md': 'See `scripts/missing.sh`.\n',
  'third_party/lib/README.md': 'TODO: never ours\n',
  'vendor/x/NOTES.md': `${PARAGRAPH}\n`,
  'build/out.md': 'Run `make nothing`.\n',
  'dist/README.md': 'Built.\n',
  '.venv/lib/site-packages/y/README.md': 'A package.\n',
}

export const CODE: Record<string, string> = {
  'src/config.py': 'def parse_config(path):\n    return path\n',
  'scripts/run_tests.sh': '#!/bin/sh\n',
  Makefile: 'deploy:\n\techo deploy\n\ntest:\n\techo test\n',
}

export const COMMITS = ['Add import v2', 'Fix the loader', 'Write the runbook']

export type World = {
  clock: MockClock
  /** The files of the repo by path relative to the root. */
  files: Map<string, string>
  /** Every path written, relative to the root, in order. */
  writes: string[]
  /** Every path read through `$.fs.read`, relative to the root, in order. */
  reads: string[]
  /** Each file's modification time; NOW when unlisted. A write (the plugin's or the engine's) moves it on. */
  mtimes: Record<string, number>
  /** Every process run, as `argv.join(' ')`. */
  ran: string[]
  /** `git blame` ages in days by file and 1-based line; 1 day when unlisted; null for a line not committed yet. */
  blame: Record<string, Record<number, number | null>>
  /** When each file was last committed (ms); a day ago when unlisted. */
  touched: Record<string, number>
  /** When each path last changed (ms), for `git log --since`. */
  changedAt: Record<string, number>
  branch: string
  branchFiles: string[]
  dirtyFiles: string[]
  untracked: string[]
  recentFiles: string[]
  /** The model's reply by the file or folder the prompt names; `[]` when unlisted. */
  plans: Record<string, string>
  completes: ModelCompleteRequest[]
  reply: 'answer' | 'fail' | 'refuse'
  tools: ToolSpec[]
  commands: string[]
  denied: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  /** Lines logged to the transcript. */
  logs: string[]
  /** Lines logged to the debug log alone. */
  debug: string[]
  opened: { id: string; title?: string; focus?: true }[]
  closed: string[]
}

const ok = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const relOf = (path: string): string => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path === ROOT ? '' : path)

const isDirOf = (files: Map<string, string>, rel: string): boolean => {
  const prefix = rel === '' ? '' : `${rel}/`
  return [...files.keys()].some(path => path.startsWith(prefix))
}

/** The line-porcelain blame of one file, from the world's ages. */
function blameOf(w: World, rel: string): string {
  const text = w.files.get(rel) ?? ''
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
    .map((line, i) => {
      const age = w.blame[rel]?.[i + 1]
      const sha = age === null ? '0'.repeat(40) : 'a'.repeat(40)
      const at = Math.floor((NOW - (age ?? 1) * DAY) / 1000)
      return `${sha} ${i + 1} ${i + 1} 1\nauthor Dev\nauthor-time ${at}\nsummary a change\n\t${line}`
    })
    .join('\n')
}

/** Whole-word matches of the identifiers in the code (anything but markdown). */
function identifiersInCode(w: World, idents: string[]): string[] {
  const code = [...w.files.entries()].filter(([path]) => !path.endsWith('.md')).map(([, text]) => text)
  return idents.filter(ident => code.some(text => new RegExp(`\\b${ident}\\b`).test(text)))
}

/** Answers the host beneath the plugin: the repo's files, git and rg, the model, the tools and the screen. */
export function world(on: On, options: { clean?: boolean } = {}): World {
  const clock = mock.clock(on, { now: NOW })
  const docs = options.clean ? { 'README.md': '# Widgets\n\nA small project.\n', 'CLAUDE.md': CLAUDE_MD } : { ...DOCS, ...EXCLUDED_DOCS }
  const w: World = {
    clock,
    files: new Map(Object.entries({ ...docs, ...CODE })),
    writes: [],
    reads: [],
    mtimes: {},
    ran: [],
    blame: { 'README.md': { 13: 3, 14: 45 } },
    touched: { 'docs/old-design.md': NOW - 95 * DAY },
    changedAt: { 'src/config.py': NOW - 10 * DAY },
    branch: 'feature/docs',
    branchFiles: [],
    dirtyFiles: [],
    untracked: [],
    recentFiles: [],
    plans: {},
    completes: [],
    reply: 'answer',
    tools: [],
    commands: [],
    denied: [],
    toasts: [],
    statuses: [],
    logs: [],
    debug: [],
    opened: [],
    closed: [],
  }
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const touched = (rel: string): void => {
    w.mtimes[rel] = (w.mtimes[rel] ?? NOW) + 1_000
  }
  on('fs.read', (_$, e) => {
    const text = w.files.get(relOf(e.path))
    w.reads.push(relOf(e.path))
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.exists', (_$, e) => {
    const rel = relOf(e.path).replace(/\/$/, '')
    return { value: w.files.has(rel) || isDirOf(w.files, rel) }
  })
  on('fs.stat', (_$, e) => {
    const rel = relOf(e.path).replace(/\/$/, '')
    if (w.files.has(rel)) {
      return { value: { kind: 'file' as const, size: (w.files.get(rel) ?? '').length, mtimeMs: w.mtimes[rel] ?? NOW, isLink: false } }
    }
    return isDirOf(w.files, rel) ? { value: { kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_$, e) => {
    const rel = relOf(e.path ?? ROOT).replace(/\/$/, '')
    const prefix = rel === '' ? '' : `${rel}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of w.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue
      }
      const rest = path.slice(prefix.length)
      const cut = rest.indexOf('/')
      names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }
    if (names.size === 0) {
      return { deny: `ENOENT: no such directory '${e.path}'` }
    }
    return { value: [...names.entries()].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.write', (_$, e) => {
    w.files.set(relOf(e.path), e.text)
    w.writes.push(relOf(e.path))
    touched(relOf(e.path))
    return { value: undefined }
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.ran.push(argv.join(' '))
    const [exe = '', ...args] = argv
    if (exe === 'rg' && args[0] === '--files') {
      // rg's own globs are not honoured here: the plugin's scope filter has to hold on its own.
      const md = [...w.files.keys()].filter(path => path.endsWith('.md')).sort()
      return ok(md.map(path => `${ROOT}/${path}`).join('\n') + (md.length ? '\n' : ''), md.length ? 0 : 1)
    }
    if (exe === 'rg') {
      const idents = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1] ?? ''] : []))
      const found = identifiersInCode(w, idents)
      return ok(found.map(ident => `${ident}\n`).join(''), found.length ? 0 : 1)
    }
    if (exe !== 'git') {
      return ok('', 127, `unexpected: ${argv.join(' ')}`)
    }
    const key = args.join(' ')
    if (key === 'rev-parse --show-toplevel') {
      return ok(`${ROOT}\n`)
    }
    if (args[0] === 'blame') {
      return ok(blameOf(w, relOf(args[args.length - 1] ?? '')))
    }
    if (key.startsWith('log -1 --format=%ct -- ')) {
      const rel = relOf(args[4] ?? '')
      return ok(`${Math.floor((w.touched[rel] ?? NOW - DAY) / 1000)}\n`)
    }
    if (args[0] === 'log' && args[1]?.startsWith('--since=@')) {
      const since = Number(args[1].slice('--since=@'.length)) * 1000
      const paths = args.slice(args.indexOf('--') + 1)
      const changed = paths.filter(path => (w.changedAt[path] ?? 0) >= since)
      return ok(changed.map(path => `${path}\n`).join(''))
    }
    if (key === 'log --since=7.days --format= --name-only') {
      return ok(w.recentFiles.map(path => `${path}\n`).join(''))
    }
    if (key === 'log -20 --format=%s') {
      return ok(COMMITS.map(line => `${line}\n`).join(''))
    }
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') {
      return ok('origin/main\n')
    }
    if (key === 'branch --show-current') {
      return ok(`${w.branch}\n`)
    }
    if (key === 'diff --name-only origin/main...HEAD') {
      return ok(w.branchFiles.map(path => `${path}\n`).join(''))
    }
    if (key === 'diff --name-only HEAD') {
      return ok(w.dirtyFiles.map(path => `${path}\n`).join(''))
    }
    if (key === 'ls-files --others --exclude-standard') {
      return ok(w.untracked.map(path => `${path}\n`).join(''))
    }
    return ok('', 1, `unexpected: git ${key}`)
  })

  on('model.complete', (_$, e) => {
    w.completes.push(e)
    if (w.reply === 'refuse') {
      return { deny: `the model ${MODEL} is not allowed here` }
    }
    if (w.reply === 'fail') {
      const failed: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } }
      return { value: failed }
    }
    const prompt = String(e.prompt)
    const subject = /^(?:File|Folder): (.+)$/m.exec(prompt)?.[1] ?? ''
    const answered: ModelCompleteResult = { isAnswered: true, text: w.plans[subject] ?? '[]', usage: USAGE }
    return { value: answered }
  })

  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__docs-gardener__${e.name}` } }
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  // A Write or Edit is one the person allowed; the mod's own tool is left to its hook; anything else asks.
  on('tool.check', (_$, e) =>
    w.denied.includes(e.tool)
      ? { decision: 'deny' as const, reason: 'denied in settings' }
      : e.tool === 'Write' || e.tool === 'Edit'
        ? { decision: 'allow' as const, reason: 'the person allowed it' }
        : { decision: 'ask' as const },
  )
  // The engine's own Write and Edit, beneath the plugin: they change the repo's files.
  on('tool.call', { tool: ['Write', 'Edit'] }, (_$, e) => {
    const rel = relOf(e.file_path)
    if (e.tool === 'Write') {
      w.files.set(rel, e.content)
    } else {
      const text = w.files.get(rel) ?? ''
      w.files.set(rel, e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, e.new_string))
    }
    touched(rel)
    return { result: {}, text: `wrote ${e.file_path}` }
  })

  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    ;(e.to === 'debug' ? w.debug : w.logs).push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push({ id: e.id, ...(e.title ? { title: e.title } : {}), ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  return w
}

// ---------------------------------------------------------------------------
// Acting as the person and as Claude.

export const SURFACES = ['terminal', 'desktop'] as const

/** A slash command as the person types it. */
export const typed = (args: string) => ({
  command: 'garden',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

export const docs = async ($: Engine, args: string): Promise<string> => (await $.command.run(typed(args))).text ?? ''

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

export const PANE_PROPS = {
  title: 'Docs audit',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

type Node = string | number | boolean | null | undefined | { type?: string; children?: Node[] }

/** The text a tree draws, nested spans joined, Buttons left out. */
export const shown = (node: Node): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (node === null || typeof node !== 'object' || node.type === 'Button') {
    return ''
  }
  return (node.children ?? []).map(shown).join('')
}

/** Each line-like element's text: every Text not inside another Text. */
export function lines(node: Node): string[] {
  if (node === null || typeof node !== 'object') {
    return []
  }
  if (node.type === 'Text') {
    return [shown(node)]
  }
  return (node.children ?? []).flatMap(lines)
}

export const mountPane = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: 'docs-gardener', surface, component: 'Pane', requestId: 'docs-gardener', props: PANE_PROPS })

/** The pane's lines and its Buttons' keys and labels, as drawn on `surface`. */
export async function pane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await mountPane($, surface)
  const tree = (await ui.drawn()) as Node
  const buttons = (await ui.findAll({ type: 'Button' })).map(found => ({ key: found.key, label: found.props.label }))
  await ui.unmount()
  return { lines: lines(tree), buttons }
}
