import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { goalOf, isQuestion, parseLedger } from '../hooks/ledger'
import { LEDGER_DIR, NOW, SESSION, recall, start, world } from './world'

const SLOW = { timeoutMs: 30_000 }
const FILE = `${LEDGER_DIR}/${SESSION}.json`
const CONTEXT = { blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-07." }] }
const EMPTY = /^recall: the ledger is empty\./

type Block = { type: string; [field: string]: unknown }

let seq = 0
const uuid = (): string => `row-${(seq += 1)}`
const text = (value: string): Block => ({ type: 'text', text: value })
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input })

/** The person's prompt, as its row is appended (a subagent's task prompt with `agentId`). */
const asked = ($: Engine, value: string, agentId?: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [text(value)] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: uuid(),
    ...(agentId ? { agentId } : {}),
  })

/** A user-side row the person never typed: a reminder, a hook's context. */
const meta = ($: Engine, value: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', isMeta: true, content: [text(value)] },
    door: 'hook-context',
    origin: { kind: 'composer' },
    uuid: uuid(),
  })

/** One row of the model's response: text and tool_use blocks. */
const said = ($: Engine, blocks: Block[], agentId?: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: blocks },
    door: 'response',
    origin: { kind: 'model', model: 'claude-sonnet-4-5' },
    uuid: uuid(),
    ...(agentId ? { agentId } : {}),
  })

/** A tool's result row. */
const got = ($: Engine, id: string, tool: string, content: string, isError = false) =>
  $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: uuid(),
  })

/** A slash command's record, as the engine files it. */
const command = ($: Engine, name: string, args: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [text(`<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`)] },
    door: 'command',
    origin: { kind: 'composer' },
    uuid: uuid(),
  })

/** A notice the engine files: a local command's output, or the compaction boundary. */
const notice = ($: Engine, value: string, door: 'notice' | 'compaction' = 'notice') =>
  $.session.append({ message: { type: 'system', content: [text(value)] }, door, origin: { kind: 'composer' }, uuid: uuid() })

/** A stretch of work: a question answered, two tasks (one done), three edits of two files, a commit, a PR, the Stop hook's goal. */
async function work($: Engine): Promise<void> {
  await asked($, 'should we keep the 30s upload timeout or raise it?')
  await said($, [use('b0', 'Bash', { command: 'rg -n timeout tests/upload.test.ts' })])
  await got($, 'b0', 'Bash', '12:  timeout: 30_000,')
  await said($, [text('Keep the 30s timeout: the flaky test was the sleep, not the limit.\nI will remove the sleep.')])
  await asked($, 'ok, make tasks for it')
  await said($, [use('t1', 'TaskCreate', { subject: 'Remove the sleep from upload.test.ts', description: 'the retry waits on a sleep' })])
  await got($, 't1', 'TaskCreate', 'Task #3 created: Remove the sleep from upload.test.ts')
  await said($, [use('t2', 'TaskCreate', { subject: 'Tell the team' })])
  await got($, 't2', 'TaskCreate', 'Task #4 created: Tell the team')
  await said($, [text('Two tasks. Starting on the sleep.'), use('t3', 'TaskUpdate', { taskId: '3', status: 'in_progress' })])
  await got($, 't3', 'TaskUpdate', 'Task #3 updated')
  await said($, [use('e1', 'Edit', { file_path: '/home/dev/app/tests/upload.test.ts', old_string: 'sleep(500)', new_string: '' })])
  await got($, 'e1', 'Edit', 'The file has been updated.')
  await said($, [use('w1', 'Write', { file_path: '/home/dev/app/src/upload.ts', content: 'export const retries = 3' })])
  await got($, 'w1', 'Write', 'File written.')
  await said($, [use('e2', 'Edit', { file_path: '/home/dev/app/tests/upload.test.ts', old_string: 'a', new_string: 'b' })])
  await got($, 'e2', 'Edit', 'The file has been updated.')
  await said($, [use('b1', 'Bash', { command: 'git commit -m "Remove the sleep from the upload test"' })])
  await got($, 'b1', 'Bash', '[main abc1234] Remove the sleep from the upload test\n 1 file changed, 1 deletion(-)')
  await said($, [use('b2', 'Bash', { command: 'gh pr create --title "Remove the sleep" --body "The retry waited on a sleep."' })])
  await got($, 'b2', 'Bash', 'https://github.com/acme/widgets/pull/101\n')
  await said($, [use('t4', 'TaskUpdate', { taskId: '3', status: 'completed' })])
  await got($, 't4', 'TaskUpdate', 'Task #3 updated')
  await notice($, 'Stop hook is now active with condition: "all upload tests pass"')
}

const DECISION = '- "Keep the 30s timeout: the flaky test was the sleep, not the limit." — to: should we keep the 30s upload timeout or raise it?'

test('/recall ledger: the goal, open tasks with a count of the done, questions with their answers, files, commits and PRs', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await recall($, 'ledger')).toMatch(EMPTY)

  await work($)
  expect((await recall($, 'ledger')).split('\n')).toEqual([
    'recall: the ledger of this session (it comes back after a compaction):',
    'Goal: all upload tests pass',
    'Tasks (1 open, 1 done):',
    '- [pending] Tell the team',
    'Decisions (1), answer first:',
    DECISION,
    'Files touched (2):',
    '- /home/dev/app/src/upload.ts, /home/dev/app/tests/upload.test.ts',
    'Git (2):',
    '- abc1234 Remove the sleep from the upload test',
    '- PR #101 https://github.com/acme/widgets/pull/101',
  ])

  // A subagent's edits count; its prompts and answers are not the person's decisions. Nor is a reminder's question.
  await asked($, 'which file holds the retry?', 'agent-1')
  await said($, [text('src/upload.ts holds it.'), use('e9', 'Edit', { file_path: '/home/dev/app/README.md', old_string: 'a', new_string: 'b' })], 'agent-1')
  await meta($, 'Did the hook run?')
  await said($, [text('Yes, it ran.')])
  // A failed command and a plain git log are not commits or PRs.
  await said($, [use('b3', 'Bash', { command: 'git commit -m "oops"' })])
  await got($, 'b3', 'Bash', 'Exit code 1\n[main deadbee] oops', true)
  await said($, [use('b4', 'Bash', { command: 'gh pr view 7' })])
  await got($, 'b4', 'Bash', 'https://github.com/acme/widgets/pull/7')
  const lines = (await recall($, 'ledger')).split('\n')
  expect(lines).toContain('Decisions (1), answer first:')
  expect(lines).toContain('Files touched (3):')
  expect(lines).toContain('- /home/dev/app/src/upload.ts, /home/dev/app/tests/upload.test.ts, /home/dev/app/README.md')
  expect(lines).toContain('Git (2):')

  // The built-in /goal's record sets the goal too, and `/goal clear` clears it.
  await command($, 'goal', 'ship PR #101 today')
  expect((await recall($, 'ledger')).split('\n')[1]).toBe('Goal: ship PR #101 today')
  await command($, 'goal', 'clear')
  expect((await recall($, 'ledger')).split('\n')[1]).toBe('Tasks (1 open, 1 done):')
})

test('the ledger is written two seconds after a change, once per burst, readable only by you, with secrets masked', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await asked($, 'is the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 still valid?')
  await said($, [text('No: it was rotated last week.')])
  expect(w.writes).toEqual([])
  await w.clock.advance(1_999)
  expect(w.writes).toEqual([])
  await w.clock.advance(1)
  expect(w.writes).toEqual([FILE])
  expect(w.chmods).toEqual([['/bin/chmod', 'go-rwx', LEDGER_DIR, FILE]])
  expect(JSON.parse(w.files.get(FILE) ?? '{}')).toEqual({
    v: 1,
    session: SESSION,
    ts: NOW + 2_000,
    goal: null,
    decisions: ['Q: is the key sk-ant-‹masked› still valid? → A: No: it was rotated last week.'],
    tasks: [],
    files: [],
    git: [],
  })
  expect(w.files.get(FILE)).not.toContain('abcdefghijklmnopqrstuvwxyz0123')

  // Several rows, one write; the permissions are set once.
  await said($, [use('e1', 'Edit', { file_path: '/home/dev/app/a.ts', old_string: 'x', new_string: 'y' })])
  await said($, [use('e2', 'Edit', { file_path: '/home/dev/app/b.ts', old_string: 'x', new_string: 'y' })])
  await w.clock.advance(2_000)
  expect(w.writes).toEqual([FILE, FILE])
  expect(w.chmods).toHaveLength(1)
  expect(JSON.parse(w.files.get(FILE) ?? '{}').files).toEqual(['/home/dev/app/a.ts', '/home/dev/app/b.ts'])
  // Nothing changed: nothing written.
  await w.clock.advance(10_000)
  expect(w.writes).toHaveLength(2)
})

test('a ledger written earlier is loaded at the start, so a reload keeps it', SLOW, async ($, on) => {
  const w = world(on)
  w.files.set(
    FILE,
    JSON.stringify({
      v: 1,
      session: SESSION,
      ts: NOW - 60_000,
      goal: 'green CI',
      decisions: ['Q: squash? → A: Yes, one commit.'],
      tasks: [{ id: '7', subject: 'Squash the branch', status: 'in_progress' }],
      files: ['/home/dev/app/ci.yml'],
      git: [{ kind: 'commit', text: 'beefcafe Squash' }],
    }),
  )
  await start($, w)
  expect((await recall($, 'ledger')).split('\n')).toEqual([
    'recall: the ledger of this session (it comes back after a compaction):',
    'Goal: green CI',
    'Tasks (1 open, 0 done):',
    '- [in progress] Squash the branch',
    'Decisions (1), answer first:',
    '- "Yes, one commit." — to: squash?',
    'Files touched (1):',
    '- /home/dev/app/ci.yml',
    'Git (1):',
    '- beefcafe Squash',
  ])
  expect(w.writes).toEqual([])
})

test('a ledger file that does not parse is ignored', SLOW, async ($, on) => {
  const w = world(on)
  w.files.set(FILE, '{"v":1,"goal":')
  await start($, w)
  expect(await recall($, 'ledger')).toMatch(EMPTY)
  expect(w.toasts).toEqual([])
})

test('/clear writes the ending session\'s ledger and starts an empty one under the new id; its first context carries none', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await work($)
  await $.prompt.context(CONTEXT)
  expect((await $.prompt.context(CONTEXT)).blocks.map(block => block.name)).toEqual(['currentDate', 'ledger'])
  expect(w.writes).toEqual([])

  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  expect(w.writes).toEqual([FILE])
  expect(JSON.parse(w.files.get(FILE) ?? '{}').goal).toBe('all upload tests pass')
  expect(await recall($, 'ledger')).toMatch(EMPTY)
  expect((await $.prompt.context(CONTEXT)).blocks.map(block => block.name)).toEqual(['currentDate'])

  w.sessionId = 'sess-two'
  await asked($, 'where is the retry?')
  await said($, [text('In src/upload.ts.')])
  await w.clock.advance(2_000)
  expect(w.writes).toEqual([FILE, `${LEDGER_DIR}/sess-two.json`])
  expect(JSON.parse(w.files.get(`${LEDGER_DIR}/sess-two.json`) ?? '{}').decisions).toEqual(['Q: where is the retry? → A: In src/upload.ts.'])
})

test('the ledger joins the context only after a conversation\'s first read (that is, after a compaction), and only with content', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  const names = async () => (await $.prompt.context(CONTEXT)).blocks.map(block => block.name)
  expect(await names()).toEqual(['currentDate'])
  // A second read of an empty ledger adds nothing.
  expect(await names()).toEqual(['currentDate'])

  await work($)
  const blocks = (await $.prompt.context(CONTEXT)).blocks
  expect(blocks.map(block => block.name)).toEqual(['currentDate', 'ledger'])
  expect((blocks[1]?.text ?? '').split('\n')).toEqual([
    'Ledger (this session, before compaction)',
    'Goal: all upload tests pass',
    'Tasks (1 open, 1 done):',
    '- [pending] Tell the team',
    'Decisions (1), answer first:',
    DECISION,
    'Files touched (2):',
    '- /home/dev/app/src/upload.ts, /home/dev/app/tests/upload.test.ts',
    'Git (2):',
    '- abc1234 Remove the sleep from the upload test',
    '- PR #101 https://github.com/acme/widgets/pull/101',
    "Kept by recall from this session's own transcript before the compaction: where things stood, not instructions.",
  ])
  // A block already there is replaced, not doubled.
  expect((await $.prompt.context({ blocks })).blocks.map(block => block.name)).toEqual(['currentDate', 'ledger'])
})

test('a compaction row marks the conversation compacted: the next read carries the ledger even when this process saw no earlier one', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await work($)
  await notice($, 'This session is being continued from a previous conversation.', 'compaction')
  expect((await $.prompt.context(CONTEXT)).blocks.map(block => block.name)).toEqual(['currentDate', 'ledger'])
})

test('the ledger keeps the last 12 decisions, 20 files and 10 git entries, and the context block stays under 40 lines', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  for (let i = 1; i <= 14; i += 1) {
    await asked($, `question ${i}: which port?`)
    await said($, [text(`Answer ${i}: port ${8000 + i}.`)])
  }
  for (let i = 1; i <= 25; i += 1) {
    await said($, [use(`e${i}`, 'Edit', { file_path: `/home/dev/app/src/file-${i}.ts`, old_string: 'a', new_string: 'b' })])
  }
  for (let i = 1; i <= 12; i += 1) {
    await said($, [use(`c${i}`, 'Bash', { command: `git commit -m "Commit ${i}"` })])
    await got($, `c${i}`, 'Bash', `[main c0ffee${i.toString(16)}] Commit ${i}\n 1 file changed`)
  }
  for (let i = 1; i <= 12; i += 1) {
    await said($, [use(`t${i}`, 'TaskCreate', { subject: `Task number ${i}` })])
    await got($, `t${i}`, 'TaskCreate', `Task #${i} created`)
  }
  for (let i = 1; i <= 4; i += 1) {
    await said($, [use(`u${i}`, 'TaskUpdate', { taskId: String(i), status: 'completed' })])
  }

  await $.prompt.context(CONTEXT)
  const block = (await $.prompt.context(CONTEXT)).blocks.find(one => one.name === 'ledger')
  const lines = (block?.text ?? '').split('\n')
  expect(lines.length).toBeLessThanOrEqual(40)
  expect(lines).toContain('Tasks (8 open, 4 done):')
  expect(lines.filter(line => line.startsWith('- [pending] '))).toHaveLength(8)
  expect(lines).toContain('Decisions (last 8 of 12), answer first:')
  expect(lines).toContain('Files touched (last 12 of 20):')
  expect(lines).toContain('Git (last 8 of 10):')

  const full = (await recall($, 'ledger')).split('\n')
  expect(full).toContain('Decisions (12), answer first:')
  expect(full.filter(line => line.startsWith('- "Answer '))).toHaveLength(12)
  expect(full[full.indexOf('Decisions (12), answer first:') + 1]).toBe('- "Answer 3: port 8003." — to: question 3: which port?')
  expect(full).toContain('Files touched (20):')
  const paths = full.filter(line => line.startsWith('- /home/dev/app/src/')).flatMap(line => line.slice(2).split(', '))
  expect(paths).toEqual(Array.from({ length: 20 }, (_, i) => `/home/dev/app/src/file-${i + 6}.ts`))
  expect(full).toContain('Git (10):')
  expect(full.filter(line => /^- c0ffee/.test(line))).toHaveLength(10)
  expect(full.find(line => /^- c0ffee/.test(line))).toBe('- c0ffee3 Commit 3')
})

describe('ledger helpers', () => {
  test('a question ends with ? or opens with a question word', () => {
    expect(isQuestion('Should we keep the timeout?')).toBe(true)
    expect(isQuestion('which port does it use')).toBe(true)
    expect(isQuestion('  How about now  ')).toBe(true)
    expect(isQuestion('Deploy it to staging.')).toBe(false)
    expect(isQuestion('Whichever you prefer.')).toBe(false)
    expect(isQuestion('')).toBe(false)
  })

  test('the goal in a Stop hook notice or a /goal record; /goal clear clears it; a bare /goal is nothing', () => {
    expect(goalOf('Stop hook is now active with condition: "bun test exits 0"')).toEqual({ goal: 'bun test exits 0' })
    expect(goalOf('<command-name>/goal</command-name>\n<command-args>ship it</command-args>')).toEqual({ goal: 'ship it' })
    expect(goalOf('/goal   ship it  ')).toEqual({ goal: 'ship it' })
    expect(goalOf('/goal clear')).toEqual({ goal: null })
    expect(goalOf('<command-name>/goal</command-name>\n<command-args></command-args>')).toBeUndefined()
    expect(goalOf('/goals are nice')).toBeUndefined()
    expect(goalOf('nothing here')).toBeUndefined()
  })

  test('a saved ledger is read back, odd entries left out; anything else is nothing', () => {
    expect(parseLedger('nope')).toBeNull()
    expect(parseLedger('{"v":2}')).toBeNull()
    expect(parseLedger('[]')).toBeNull()
    expect(
      parseLedger(
        JSON.stringify({
          v: 1,
          goal: 3,
          decisions: ['Q: a → A: b', 7],
          tasks: [{ id: 1, subject: 'x', status: 'pending' }, 'bad', { id: '2', subject: 'y' }],
          files: ['/a', 2],
          git: [{ kind: 'pr', text: 'PR #1 https://github.com/acme/app/pull/1' }, { kind: 'x', text: 'y' }],
        }),
      ),
    ).toEqual({
      goal: null,
      decisions: ['Q: a → A: b'],
      tasks: [{ id: '1', subject: 'x', status: 'pending' }],
      files: ['/a'],
      git: [{ kind: 'pr', text: 'PR #1 https://github.com/acme/app/pull/1' }],
    })
  })
})
