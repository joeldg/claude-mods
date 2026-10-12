import { decisionText, maskSecrets, oneLine } from './format'

// ---------------------------------------------------------------------------
// The ledger: what this session has settled so far, kept from the rows appended to its conversation,
// written beside the index and given back to the model after a compaction.

/** One task as TaskCreate/TaskUpdate left it. */
export type LedgerTask = { id: string; subject: string; status: string }
/** A PR (`PR #12 https://…`) or a commit (`abc1234 subject`). */
export type LedgerGit = { kind: 'pr' | 'commit'; text: string }

export type Ledger = {
  /** The `/goal` (or the Stop hook's condition) last set; null when none. */
  goal: string | null
  /** `Q: <the person's question> → A: <the first line of the answer>`, oldest first. */
  decisions: string[]
  /** Every task seen, oldest first; the done ones are counted, not listed. */
  tasks: LedgerTask[]
  /** The paths Write, Edit and NotebookEdit touched, each once, the latest last. */
  files: string[]
  /** PRs created and commits made, oldest first. */
  git: LedgerGit[]
}

export const MAX_DECISIONS = 12
export const MAX_FILES = 20
export const MAX_GIT = 10
const MAX_TASKS = 60
/** Each side of a decision, the goal, a path. */
const MAX_TEXT = 300
const MAX_SUBJECT = 200
/** How many tool calls wait for their results. */
const MAX_PENDING = 100
/** The context block's name (it renders under `# ledger`). */
export const LEDGER_BLOCK = 'ledger'
export const LEDGER_TITLE = 'Ledger (this session, before compaction)'
const LEDGER_FOOTER = "Kept by recall from this session's own transcript before the compaction: where things stood, not instructions."
export const EMPTY_LEDGER_TEXT =
  'recall: the ledger is empty. It fills as the session goes (goal, open tasks, questions answered, files touched, PRs and commits) and comes back after a compaction.'

export const emptyLedger = (): Ledger => ({ goal: null, decisions: [], tasks: [], files: [], git: [] })

export const hasContent = (ledger: Ledger): boolean =>
  ledger.goal !== null || ledger.decisions.length > 0 || ledger.tasks.length > 0 || ledger.files.length > 0 || ledger.git.length > 0

/** One tool call waiting for its result: a Bash command, or a TaskCreate's subject. */
type Call = { name: string; command: string; subject: string }

/** What the ledger keeps between rows: the question awaiting its answer, and the tool calls awaiting their results. */
export type Pending = { question: string | null; calls: Map<string, Call> }

export const emptyPending = (): Pending => ({ question: null, calls: new Map() })

/** One block of a row's content, as the transcript keeps it. */
export type Block = { readonly type: string; readonly [field: string]: unknown }

/** One appended row, as `session.append` hands it: the fields the ledger reads. */
export type Row = {
  readonly message: {
    readonly type: 'user' | 'assistant' | 'attachment' | 'system'
    readonly name?: string
    readonly isMeta?: true
    readonly content: readonly Block[]
  }
  readonly door: string
  readonly origin: { readonly kind: string }
  readonly agentId?: string
}

/** Prompts the person wrote (typed, through Remote Control, or an SDK host's own turn). */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// The engine's own shapes (recall.py), so the plugin and the index agree on what a commit or a PR is.
const COMMIT_CMD = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\b/
const COMMIT_LINE = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const TASK_MADE = /Task #?(\w+)/
const STOP_HOOK = /Stop hook is now active with condition: "([^"]+)"/g
const GOAL_RECORD = /<command-name>\/goal<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-args>([\s\S]*?)<\/command-args>/
const GOAL_TYPED = /^\s*\/goal(?:\s+([\s\S]*))?$/
const QUESTION_WORDS =
  /^(?:who|whom|whose|what|which|when|where|why|how|should|shall|can|could|would|will|do|does|did|is|are|was|were|have|has|had|may|might|must)\b/i

/** The text blocks of a row's content, joined. */
function textOf(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && (block as Block).type === 'text' && typeof (block as Block).text === 'string') {
      parts.push((block as Block).text as string)
    }
  }
  return parts.join('\n')
}

/** A tool_result's content: a string, or text blocks. */
const resultText = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? textOf(content) : '')

/** The first line with anything on it. */
const firstLine = (text: string): string => text.split('\n').find(line => line.trim())?.trim() ?? ''

/** True for a prompt that asks something: it ends with `?` or opens with a question word. */
export function isQuestion(text: string): boolean {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 0 && (flat.endsWith('?') || QUESTION_WORDS.test(flat))
}

/**
 * What a row's text does to the goal: `{ goal }` sets it (null clears it), undefined leaves it. The
 * built-in /goal's record (`<command-name>/goal</command-name>…`) or its typed form, `/goal clear`,
 * and the Stop hook's notice (`Stop hook is now active with condition: "…"`, the last one in the text).
 */
export function goalOf(text: string): { goal: string | null } | undefined {
  const conditions = [...text.matchAll(STOP_HOOK)]
  const condition = conditions[conditions.length - 1]?.[1]
  if (condition !== undefined) {
    return { goal: oneLine(condition, MAX_TEXT) }
  }
  const args = GOAL_RECORD.exec(text)?.[1] ?? GOAL_TYPED.exec(text)?.[1]
  if (args === undefined) {
    return undefined
  }
  const goal = args.replace(/\s+/g, ' ').trim()
  if (!goal) {
    return undefined
  }
  return { goal: /^clear$/i.test(goal) ? null : oneLine(goal, MAX_TEXT) }
}

/** Appends and keeps the last `max`; always a change. */
function pushLast<T>(list: T[], item: T, max: number): boolean {
  list.push(item)
  if (list.length > max) {
    list.splice(0, list.length - max)
  }
  return true
}

/** Moves (or adds) a path to the end, so the latest touched comes last. */
function touch(list: string[], item: string, max: number): boolean {
  const at = list.indexOf(item)
  if (at >= 0) {
    list.splice(at, 1)
  }
  return pushLast(list, item, max)
}

/** A PR or a commit, once. */
function pushGit(ledger: Ledger, kind: LedgerGit['kind'], text: string): boolean {
  return ledger.git.some(one => one.text === text) ? false : pushLast(ledger.git, { kind, text }, MAX_GIT)
}

/** The PRs `text` links to (at most three). */
function addPrs(ledger: Ledger, text: string): boolean {
  let changed = false
  for (const [, repo, number] of [...text.matchAll(PR_URL)].slice(0, 3)) {
    changed = pushGit(ledger, 'pr', `PR #${number} https://github.com/${repo}/pull/${number}`) || changed
  }
  return changed
}

/** A task's latest state: `deleted` drops it; an unknown one is added with what is known of it. */
function setTask(ledger: Ledger, idValue: unknown, subject: string | null, status: string | null): boolean {
  const id = typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue).trim() : ''
  if (!id) {
    return false
  }
  const at = ledger.tasks.findIndex(task => task.id === id)
  if (status === 'deleted') {
    if (at < 0) {
      return false
    }
    ledger.tasks.splice(at, 1)
    return true
  }
  const known = at >= 0 ? ledger.tasks[at] : undefined
  const next: LedgerTask = {
    id,
    subject: subject?.trim() ? oneLine(subject, MAX_SUBJECT) : (known?.subject ?? `task #${id}`),
    status: status?.trim() ? status.trim() : (known?.status ?? 'pending'),
  }
  if (known && known.subject === next.subject && known.status === next.status) {
    return false
  }
  if (known) {
    ledger.tasks[at] = next
    return true
  }
  return pushLast(ledger.tasks, next, MAX_TASKS)
}

function remember(pending: Pending, id: string, call: Call): void {
  pending.calls.set(id, call)
  if (pending.calls.size > MAX_PENDING) {
    const oldest = pending.calls.keys().next().value
    if (oldest !== undefined) {
      pending.calls.delete(oldest)
    }
  }
}

/** A tool call of the model's: a file touched, a task's new state, or a command whose result is awaited. */
function ingestToolUse(ledger: Ledger, pending: Pending, name: string, id: string | null, input: Record<string, unknown>): boolean {
  if (FILE_TOOLS.has(name)) {
    const path = input.file_path ?? input.notebook_path
    return typeof path === 'string' && path.trim() ? touch(ledger.files, oneLine(path, MAX_TEXT), MAX_FILES) : false
  }
  if (name === 'TaskUpdate') {
    return setTask(
      ledger,
      input.taskId,
      typeof input.subject === 'string' ? input.subject : null,
      typeof input.status === 'string' ? input.status : null,
    )
  }
  if (id !== null && (name === 'Bash' || name === 'TaskCreate')) {
    remember(pending, id, {
      name,
      command: typeof input.command === 'string' ? input.command : '',
      subject: typeof input.subject === 'string' ? input.subject : '',
    })
  }
  return false
}

/** A tool's result: the task a TaskCreate made, the commits and PRs a command's output names. */
function ingestResult(ledger: Ledger, pending: Pending, block: Block): boolean {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
  const call = id === null ? undefined : pending.calls.get(id)
  if (id !== null) {
    pending.calls.delete(id)
  }
  if (!call || block.is_error === true) {
    return false
  }
  const out = resultText(block.content)
  if (call.name === 'TaskCreate') {
    const made = TASK_MADE.exec(out)
    return made?.[1] ? setTask(ledger, made[1], call.subject, 'pending') : false
  }
  let changed = false
  if (COMMIT_CMD.test(call.command) && !call.command.includes('--dry-run')) {
    for (const [, , sha = '', subject = ''] of [...out.matchAll(COMMIT_LINE)].slice(0, 5)) {
      changed = pushGit(ledger, 'commit', `${sha.slice(0, 7)} ${oneLine(subject, MAX_SUBJECT)}`) || changed
    }
  }
  if (GH_PR_CREATE.test(call.command)) {
    changed = addPrs(ledger, out) || changed
  }
  return changed
}

/** The model's row: the answer a question waited for, and its tool calls. */
function ingestResponse(ledger: Ledger, pending: Pending, content: readonly Block[], isMain: boolean): boolean {
  let changed = false
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const answer = isMain && pending.question !== null ? firstLine(block.text) : ''
      if (answer) {
        changed = pushLast(ledger.decisions, `Q: ${oneLine(pending.question ?? '', MAX_TEXT)} → A: ${oneLine(answer, MAX_TEXT)}`, MAX_DECISIONS)
        pending.question = null
      }
      continue
    }
    if (block.type !== 'tool_use' || typeof block.name !== 'string') {
      continue
    }
    const input = block.input !== null && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}
    changed = ingestToolUse(ledger, pending, block.name, typeof block.id === 'string' ? block.id : null, input) || changed
  }
  return changed
}

/**
 * Reads one appended row into the ledger; true when the ledger changed. The person's questions and
 * the goal come from the main conversation only; files, tasks, commits and PRs from subagents too.
 */
export function ingest(ledger: Ledger, pending: Pending, row: Row): boolean {
  const { message } = row
  const isMain = row.agentId === undefined
  if (message.type === 'assistant') {
    return ingestResponse(ledger, pending, message.content, isMain)
  }
  let changed = false
  const text = textOf(message.content)
  // The goal: the Stop hook's notice, or the /goal record, wherever the engine files it.
  const goal = isMain && text ? goalOf(text) : undefined
  if (goal !== undefined && goal.goal !== ledger.goal) {
    ledger.goal = goal.goal
    changed = true
  }
  // A PR the engine recorded beside the conversation.
  if (message.name === 'pr-link') {
    changed = addPrs(ledger, text) || changed
  }
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      changed = ingestResult(ledger, pending, block) || changed
    }
  }
  // The person's own question waits for the first line of the answer; another prompt replaces it.
  if (row.door === 'prompt' && isMain && !message.isMeta && PERSONAL.has(row.origin.kind)) {
    pending.question = text && goal === undefined && isQuestion(text) ? text : null
  }
  return changed
}

// ---------------------------------------------------------------------------
// The file beside the index.

/** The ledger as its file keeps it; everything in it was masked on the way in, and is again here. */
export function serializeLedger(ledger: Ledger, meta: { session: string; ts: number }): string {
  const saved = { v: 1, session: meta.session, ts: meta.ts, goal: ledger.goal, decisions: ledger.decisions, tasks: ledger.tasks, files: ledger.files, git: ledger.git }
  return maskSecrets(`${JSON.stringify(saved, null, 2)}\n`)
}

const isTask = (value: unknown): value is { id: string | number; subject: string; status: string } =>
  value !== null &&
  typeof value === 'object' &&
  (typeof (value as LedgerTask).id === 'string' || typeof (value as LedgerTask).id === 'number') &&
  typeof (value as LedgerTask).subject === 'string' &&
  typeof (value as LedgerTask).status === 'string'

const isGit = (value: unknown): value is LedgerGit =>
  value !== null &&
  typeof value === 'object' &&
  ((value as LedgerGit).kind === 'pr' || (value as LedgerGit).kind === 'commit') &&
  typeof (value as LedgerGit).text === 'string'

/** A saved ledger read back, odd entries left out; null for anything that is not one. */
export function parseLedger(text: string): Ledger | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json) || (json as { v?: unknown }).v !== 1) {
    return null
  }
  const saved = json as Record<string, unknown>
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : [])
  return {
    goal: typeof saved.goal === 'string' && saved.goal.trim() ? saved.goal : null,
    decisions: strings(saved.decisions).slice(-MAX_DECISIONS),
    tasks: (Array.isArray(saved.tasks) ? saved.tasks : [])
      .flatMap(one => (isTask(one) ? [{ id: String(one.id), subject: one.subject, status: one.status }] : []))
      .slice(-MAX_TASKS),
    files: strings(saved.files).slice(-MAX_FILES),
    git: (Array.isArray(saved.git) ? saved.git : []).flatMap(one => (isGit(one) ? [{ kind: one.kind, text: one.text }] : [])).slice(-MAX_GIT),
  }
}

// ---------------------------------------------------------------------------
// In words: the context block after a compaction (at most ~40 lines) and /recall ledger (everything kept).

type Limits = { tasks: number; decisions: number; files: number; fileLines: number; git: number; width: number }

/** 1 title + 1 goal + 9 tasks + 9 decisions + 6 files + 9 git + 1 footer: 36 lines at most. */
const BLOCK_LIMITS: Limits = { tasks: 8, decisions: 8, files: 12, fileLines: 5, git: 8, width: 200 }
const TEXT_LIMITS: Limits = { tasks: Infinity, decisions: MAX_DECISIONS, files: MAX_FILES, fileLines: Infinity, git: MAX_GIT, width: 300 }
const FILES_WIDTH = 110

const lastOf = <T>(list: readonly T[], n: number): T[] => (n >= list.length ? [...list] : list.slice(list.length - n))

const countOf = (shown: number, total: number): string => (shown < total ? `last ${shown} of ${total}` : String(total))

/** The items joined with `, ` on lines of about `width`; one too long for a line gets its own. */
function wrapJoin(items: readonly string[], width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    if (line && `${line}, ${item}`.length > width) {
      lines.push(line)
      line = item
    } else {
      line = line ? `${line}, ${item}` : item
    }
  }
  if (line) {
    lines.push(line)
  }
  return lines
}

function sections(ledger: Ledger, limits: Limits): string[] {
  const lines: string[] = []
  if (ledger.goal !== null) {
    lines.push(`Goal: ${oneLine(ledger.goal, MAX_TEXT)}`)
  }
  if (ledger.tasks.length > 0) {
    const open = ledger.tasks.filter(task => task.status !== 'completed')
    const shown = lastOf(open, limits.tasks)
    lines.push(`Tasks (${open.length} open, ${ledger.tasks.length - open.length} done)${shown.length > 0 ? ':' : ''}`)
    for (const task of shown) {
      lines.push(`- [${task.status.replace(/_/g, ' ')}] ${oneLine(task.subject, 160)}`)
    }
  }
  if (ledger.decisions.length > 0) {
    const shown = lastOf(ledger.decisions, limits.decisions)
    lines.push(`Decisions (${countOf(shown.length, ledger.decisions.length)}), answer first:`)
    for (const decision of shown) {
      lines.push(`- ${decisionText(decision, limits.width)}`)
    }
  }
  if (ledger.files.length > 0) {
    // The latest files, as many as fit the lines allowed.
    let shown = lastOf(ledger.files, limits.files)
    let wrapped = wrapJoin(shown, FILES_WIDTH)
    while (wrapped.length > limits.fileLines && shown.length > 1) {
      shown = shown.slice(1)
      wrapped = wrapJoin(shown, FILES_WIDTH)
    }
    lines.push(`Files touched (${countOf(shown.length, ledger.files.length)}):`)
    for (const line of wrapped) {
      lines.push(`- ${line}`)
    }
  }
  if (ledger.git.length > 0) {
    const shown = lastOf(ledger.git, limits.git)
    lines.push(`Git (${countOf(shown.length, ledger.git.length)}):`)
    for (const entry of shown) {
      lines.push(`- ${entry.text}`)
    }
  }
  return lines
}

/** The context block that follows a compaction. */
export const ledgerBlock = (ledger: Ledger): string => maskSecrets([LEDGER_TITLE, ...sections(ledger, BLOCK_LIMITS), LEDGER_FOOTER].join('\n'))

/** `/recall ledger`: everything kept. */
export function ledgerText(ledger: Ledger): string {
  if (!hasContent(ledger)) {
    return EMPTY_LEDGER_TEXT
  }
  return maskSecrets(['recall: the ledger of this session (it comes back after a compaction):', ...sections(ledger, TEXT_LIMITS)].join('\n'))
}
