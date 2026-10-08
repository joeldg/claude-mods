import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On, ProcessSpawnChunk, RenderSurface, ToolSpec } from 'claude-code'

export const HOME = '/Users/me'
export const ROOT = '/Users/me/widgets'
export const CWD = '/Users/me/widgets/src'
export const OTHER = '/Users/me/gadgets'
export const SESSION = 'sess-now'
export const PYTHON = '/usr/bin/python3'
export const DB = '/Users/me/.claude/recall/index.db'
export const NOW = Date.UTC(2026, 9, 7, 14, 0)
export const DAY = 86_400_000
export const SOURCES = ['--sources', 'claude,codex,memory,orders,reviews', '--subagents']

/** One engine command as the plugin ran it: `search`, `note add`, ...; and what followed the command. */
export type Call = { command: string; args: string[] }
/** What the fake engine answers: JSON on stdout (an `error` one exits 1), or raw output. */
export type Answer = { json?: unknown; stdout?: string; stderr?: string; exit?: number }

export type World = {
  clock: MockClock
  /** Every engine command run through `process.run`, in order. */
  calls: Call[]
  /** Every full command line run, as given. */
  argvs: string[][]
  /** The engine's answers by command; a command with none answers an error. */
  engine: Record<string, (call: Call) => Answer>
  /** Updates run through `process.spawn`. */
  spawned: Call[]
  /** What a spawned update streams: each piece after `afterMs` on the clock; then it exits with `code`. */
  stream: { steps: { afterMs: number; chunk: ProcessSpawnChunk }[]; code: number; fails?: string }
  /** `/bin/sh` command lines (the update a session's end leaves running). */
  shells: string[][]
  /** True: python cannot start. */
  isBroken: boolean
  toasts: string[]
  statuses: (string | undefined)[]
  logs: string[]
  opened: { id: string; focus?: true }[]
  closed: string[]
  fills: string[]
  /** What the prompt box holds before a fill. */
  draft: string
  copies: { text: string; surface?: RenderSurface }[]
  canCopy: boolean
  completes: ModelCompleteRequest[]
  reply: ModelCompleteResult | 'refuse'
  tools: Required<ToolSpec>[]
  commands: string[]
  entered: { text: string; context: readonly string[] | undefined }[]
  /** Tools a settings rule denies, beneath the plugin. */
  denied: string[]
  /** The band beneath the plugin's: the engine's empty one, or another plugin's. */
  below: 'empty' | 'other'
  turns: number
}

const ok = (stdout: string, stderr = '', exitCode = 0) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** The value after `flag` in a call's arguments. */
export const argOf = (call: Call | undefined, flag: string): string | undefined => {
  const at = call ? call.args.indexOf(flag) : -1
  return at >= 0 ? call?.args[at + 1] : undefined
}

export const callsOf = (w: World, command: string): Call[] => w.calls.filter(call => call.command === command)

// ---------------------------------------------------------------------------
// What the engine knows: generic projects, sessions and extracts.

export const HIT_DEPLOY = {
  ref: 'd123',
  session: 's-deploy',
  project: ROOT,
  projectName: 'widgets',
  title: 'Deploy worker to Modal',
  ts: Date.UTC(2026, 8, 19, 14, 7),
  kind: 'command',
  role: 'assistant',
  source: 'claude',
  snippet: '[[modal]] [[deploy]] workers/gpu.py --env prod',
  score: 9.5,
  extra: { command: 'modal deploy workers/gpu.py --env prod' },
}

export const HIT_ANSWER = {
  ...HIT_DEPLOY,
  ref: 'd122',
  ts: Date.UTC(2026, 8, 19, 14, 6),
  kind: 'answer',
  snippet: 'I will run [[modal]] [[deploy]] from the repo root.',
  score: 6.1,
  extra: {},
}

export const HIT_DECISION = {
  ref: 'd140',
  session: 's-gpu',
  project: ROOT,
  projectName: 'widgets',
  title: 'Tune the GPU worker',
  ts: Date.UTC(2026, 8, 28, 9, 30),
  kind: 'decision',
  role: 'assistant',
  source: 'claude',
  snippet: 'Keep the worker on the A10G; [[deploy]] with [[modal]] only from main',
  score: 5,
  extra: {},
}

export const HIT_OTHER = {
  ref: 'd901',
  session: 's-other',
  project: OTHER,
  projectName: 'gadgets',
  title: 'Gadgets deploy',
  ts: Date.UTC(2026, 7, 2, 11, 0),
  kind: 'command',
  role: 'assistant',
  source: 'codex',
  snippet: '[[modal]] [[deploy]] app.py',
  score: 3,
  extra: {},
}

export const SESSIONS = [
  {
    session: 's-deploy',
    title: 'Deploy worker to Modal',
    projectName: 'widgets',
    hits: 2,
    lastTs: Date.UTC(2026, 8, 19, 15, 40),
    transcriptExists: true,
  },
  { session: 's-gpu', title: 'Tune the GPU worker', projectName: 'widgets', hits: 1, lastTs: Date.UTC(2026, 8, 28, 10), transcriptExists: false },
  { session: 's-other', title: 'Gadgets deploy', projectName: 'gadgets', hits: 1, lastTs: Date.UTC(2026, 7, 2, 12), transcriptExists: true },
]

/** This project's search: three hits. */
export const SEARCH_HERE = { query: 'modal deploy', total: 3, hits: [HIT_DEPLOY, HIT_ANSWER, HIT_DECISION], sessions: SESSIONS.slice(0, 2) }
/** Every project's: two more, one of them shown. */
export const SEARCH_ALL = { query: 'modal deploy', total: 5, hits: [HIT_DEPLOY, HIT_ANSWER, HIT_DECISION, HIT_OTHER], sessions: SESSIONS }

const session = (id: string, title: string, project: string, start: number, end: number, exists = true) => ({
  session: id,
  title,
  project,
  projectName: project.split('/').pop(),
  start,
  end,
  source: 'claude',
  resume: `claude --resume ${id}`,
  transcriptExists: exists,
  transcriptPath: `${HOME}/.claude/projects/-Users-me-widgets/${id}.jsonl`,
})

export const EXPANDS: Record<string, unknown> = {
  d123: {
    session: session('s-deploy', 'Deploy worker to Modal', ROOT, Date.UTC(2026, 8, 19, 14, 2), Date.UTC(2026, 8, 19, 15, 40)),
    focus: 'd123',
    items: [
      { ref: 'd121', ts: Date.UTC(2026, 8, 19, 14, 5), kind: 'prompt', role: 'user', text: 'Can you deploy the GPU worker to Modal?' },
      { ref: 'd122', ts: Date.UTC(2026, 8, 19, 14, 6), kind: 'answer', role: 'assistant', text: 'I will run modal deploy from the repo root.' },
      { ref: 'd123', ts: Date.UTC(2026, 8, 19, 14, 7), kind: 'command', role: 'assistant', text: 'modal deploy workers/gpu.py --env prod' },
    ],
  },
  d140: {
    session: session('s-gpu', 'Tune the GPU worker', ROOT, Date.UTC(2026, 8, 28, 9), Date.UTC(2026, 8, 28, 10), false),
    focus: 'd140',
    items: [
      { ref: 'd139', ts: Date.UTC(2026, 8, 28, 9, 29), kind: 'prompt', role: 'user', text: 'Which GPU should the worker use?' },
      { ref: 'd140', ts: Date.UTC(2026, 8, 28, 9, 30), kind: 'decision', role: 'assistant', text: 'Keep the worker on the A10G; deploy with modal only from main' },
    ],
  },
  d901: {
    session: session('s-other', 'Gadgets deploy', OTHER, Date.UTC(2026, 7, 2, 11), Date.UTC(2026, 7, 2, 12)),
    focus: 'd901',
    items: [{ ref: 'd901', ts: Date.UTC(2026, 7, 2, 11, 0), kind: 'command', role: 'assistant', text: 'modal deploy app.py' }],
  },
}

/** This project's last session: two days ago, a PR and three open tasks. */
export const RECAP_UPLOAD = {
  session: 's-upload',
  title: 'Fix the upload test',
  projectName: 'widgets',
  start: NOW - 2 * DAY - 3_600_000,
  end: NOW - 2 * DAY,
  prompts: 14,
  routine: false,
  firstPrompt: 'Fix the flaky upload test in CI',
  lastPrompts: ['push it and open a PR', 'also bump the timeout'],
  lastAnswer: 'Opened PR #99 and bumped the timeout to 30s.',
  commits: [{ sha: 'abc1234def', message: 'Fix flaky upload test' }],
  prs: [{ number: 99, url: 'https://github.com/acme/widgets/pull/99', title: 'Fix flaky upload test' }],
  issues: [],
  files: ['tests/upload.test.ts', 'src/upload.ts'],
  openTasks: ['Re-enable the retry test', 'Remove the sleep', 'Tell the team'],
  decisions: ['Keep the 30s timeout for uploads'],
  resume: 'claude --resume s-upload',
  transcriptExists: true,
}

export const DECISION_ITEM = {
  ref: 'd140',
  ts: Date.UTC(2026, 8, 28, 9, 30),
  session: 's-gpu',
  projectName: 'widgets',
  title: 'Tune the GPU worker',
  kind: 'decision',
  text: 'Keep the worker on the A10G; deploy with modal only from main',
  extra: {},
}

export const STATS = {
  db: DB,
  bytes: 2_400_000,
  sessions: 120,
  docs: 9_000,
  byKind: { prompt: 3_000, answer: 4_000, command: 2_000 },
  bySource: { claude: 8_000, codex: 1_000 },
  oldest: Date.UTC(2026, 0, 2),
  newest: NOW - 60_000,
  lastUpdate: NOW - 5 * 60_000,
  transcriptsDeleted: 30,
  routineSessions: 4,
}

export const UPDATED = {
  updated: { files: 3, docs_added: 40, docs_removed: 0, sessions: 2, seconds: 0.8, partial: false },
  stats: { ...STATS },
}

/** The engine's answers, by command, for a project with an index in place. */
function answers(): World['engine'] {
  return {
    stats: () => ({ json: STATS }),
    update: () => ({ json: UPDATED }),
    search: call => ({ json: argOf(call, '--project') === ROOT ? SEARCH_HERE : SEARCH_ALL }),
    expand: call => {
      const ref = argOf(call, '--ref') ?? ''
      return { json: EXPANDS[ref] ?? { error: `no doc ${ref}` } }
    },
    recap: call =>
      argOf(call, '--session') === 's-unknown'
        ? { json: { error: 'no session s-unknown' } }
        : { json: { sessions: [RECAP_UPLOAD] } },
    list: () => ({ json: { items: [DECISION_ITEM] } }),
    timeline: () => ({
      json: {
        days: [
          {
            date: '2026-10-07',
            sessions: [
              { session: 's-a', title: 'Fix the upload test', projectName: 'widgets', start: Date.UTC(2026, 9, 7, 9, 2), end: null, prompts: 14, commits: 2, prs: 1, routine: false, source: 'claude' },
              { session: 's-b', title: 'Gadgets deploy', projectName: 'gadgets', start: Date.UTC(2026, 9, 7, 8, 0), end: null, prompts: 3, commits: 0, prs: 0, routine: false, source: 'codex' },
            ],
          },
        ],
      },
    }),
    projects: () => ({
      json: {
        projects: [
          { key: ROOT, name: 'widgets', paths: [ROOT], sessions: 100, lastTs: NOW },
          { key: OTHER, name: 'gadgets', paths: [OTHER], sessions: 20, lastTs: NOW - DAY },
        ],
      },
    }),
    forget: () => ({ json: { forgotten: { docs: 40, sessions: 1 } } }),
    'note add': call => ({
      json: { note: { ref: 'd900', ts: NOW, projectName: 'widgets', text: argOf(call, '--text') } },
    }),
    'note list': () => ({
      json: {
        items: [
          { ref: 'd900', ts: NOW - DAY, session: null, projectName: 'widgets', title: 'Note', kind: 'note', text: 'the NAS backups live in /Volumes/nas/backups', extra: {} },
        ],
      },
    }),
    'note forget': call => ({ json: { forgotten: argOf(call, '--ref') === 'd900' ? 1 : 0 } }),
  }
}

export const progress = (done: number, total: number): string =>
  `${JSON.stringify({ progress: { files_done: done, files_total: 40, bytes_done: done, bytes_total: total } })}\n`

/** Answers the host beneath the plugin: the engine and git, the session, the screen, the prompt box and the model. */
export function world(on: On): World {
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    clock,
    calls: [],
    argvs: [],
    engine: answers(),
    spawned: [],
    stream: { steps: [{ afterMs: 0, chunk: { stream: 'stdout', text: `${JSON.stringify(UPDATED)}\n` } }], code: 0 },
    shells: [],
    isBroken: false,
    toasts: [],
    statuses: [],
    logs: [],
    opened: [],
    closed: [],
    fills: [],
    draft: '',
    copies: [],
    canCopy: true,
    completes: [],
    reply: { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    tools: [],
    commands: [],
    entered: [],
    denied: [],
    below: 'empty',
    turns: 0,
  }
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: SESSION }))
  on('session.turns', () => ({ value: w.turns }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.argvs.push(argv)
    const [exe = '', script = '', , , command = '', ...rest] = argv
    if (exe === 'git') {
      return ok(`${ROOT}\n`)
    }
    if (exe === '/bin/sh') {
      w.shells.push(argv)
      return ok('')
    }
    if (!script.endsWith('/engine/recall.py')) {
      return ok('', `unexpected: ${argv.join(' ')}`, 127)
    }
    if (w.isBroken) {
      return { deny: `spawn ${PYTHON} ENOENT` }
    }
    const isNote = command === 'note'
    const call: Call = { command: isNote ? `note ${rest[0] ?? ''}` : command, args: isNote ? rest.slice(1) : rest }
    w.calls.push(call)
    const answer = w.engine[call.command]?.(call) ?? { json: { error: `no answer for ${call.command}` } }
    const json = answer.json as { error?: unknown } | undefined
    const stdout = answer.stdout ?? (json === undefined ? '' : `${JSON.stringify(json)}\n`)
    return ok(stdout, answer.stderr ?? '', answer.exit ?? (json?.error ? 1 : 0))
  })
  on('process.spawn', async function* (_$, e) {
    const [, , , , command = '', ...args] = e.argv
    w.spawned.push({ command, args })
    if (w.stream.fails) {
      return { deny: w.stream.fails }
    }
    for (const step of w.stream.steps) {
      if (step.afterMs > 0) {
        await clock.sleep(step.afterMs)
      }
      yield step.chunk
    }
    return { value: { code: w.stream.code, signal: null } }
  })
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__recall__${e.name}` } }
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.check', (_$, e) =>
    w.denied.includes(e.tool) ? { decision: 'deny' as const, reason: 'denied in settings' } : { decision: 'ask' as const },
  )
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push({ id: e.id, ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    w.copies.push({ text: e.text, ...(e.surface ? { surface: e.surface } : {}) })
    return { value: w.canCopy ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    w.entered.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('model.complete', (_$, e) => {
    w.completes.push(e)
    return w.reply === 'refuse' ? { deny: 'the model claude-haiku-4-5-20251001 is not allowed here' } : { value: w.reply }
  })
  // The band beneath the plugin's: empty, or another plugin's.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return w.below === 'other' ? (
      <Box>
        <Text>main ↑1 · 3 changed</Text>
      </Box>
    ) : (
      <Box />
    )
  })
  return w
}

// ---------------------------------------------------------------------------
// Acting as the person.

export const SURFACES = ['terminal', 'desktop'] as const

/** A slash command as the person types it. */
export const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

export const recall = async ($: Engine, args: string): Promise<string> => (await $.command.run(typed('recall', args))).text ?? ''

export const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** An interactive session's start; its timer work (indexing, the last-session band) has run once settled. */
export async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

export const PANE_PROPS = {
  title: 'Recall',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

export const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 9 },
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

export const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'recall', surface, component: 'Pane', requestId: 'recall', props: PANE_PROPS })

/** The pane's lines and its Buttons' keys and labels, as drawn on `surface`. */
export async function pane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await mountPane($, surface)
  const tree = (await ui.drawn()) as Node
  const buttons = (await ui.findAll({ type: 'Button' })).map(found => ({ key: found.key, label: found.props.label }))
  const markdown = (await ui.findAll({ type: 'Markdown' })).map(found => String(found.props.text))
  await ui.unmount()
  return { lines: lines(tree), buttons, markdown }
}

/** The band's text and its Buttons' keys, as drawn on `surface`. */
export async function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'recall', surface, component: 'AbovePrompt', props: BAND })
  const text = shown((await ui.drawn()) as Node)
  const buttons = (await ui.findAll({ type: 'Button' })).map(found => found.key)
  await ui.unmount()
  return { text, buttons }
}
