import { expect, test } from 'claude-code/testing'

import { CWD, DB, NICE, NOW, PYTHON, SESSION, SIDECAR, SOURCES, STATS, callsOf, progress, recall, say, sidecar, start, world } from './world'

const SLOW = { timeoutMs: 30_000 }

test('a first run builds the index in the background, its progress on the status line, then says how many', SLOW, async ($, on) => {
  const w = world(on)
  w.engine.stats = () => ({ json: { ...STATS, docs: 0, sessions: 0 } })
  w.engine.recap = () => ({ json: { sessions: [] } })
  const done = { files: 40, docs_added: 9_000, docs_removed: 0, sessions: 12, seconds: 61, partial: false }
  w.stream.steps = [
    { afterMs: 0, chunk: { stream: 'stderr', text: progress(0, 1_000) } },
    // A line may arrive in pieces.
    { afterMs: 1_000, chunk: { stream: 'stderr', text: `${progress(420, 1_000)}{"progress":{"files_done":40,` } },
    {
      afterMs: 1_000,
      chunk: { stream: 'stderr', text: '"files_total":40,"bytes_done":1000,"bytes_total":1000}}\nrecall: skipped /x/y.jsonl: denied\n' },
    },
    { afterMs: 0, chunk: { stream: 'stdout', text: `${JSON.stringify({ updated: done, stats: { ...STATS, sessions: 12 } })}\n` } },
  ]

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  // The session's start did not wait for any of it.
  expect(w.spawned).toEqual([])
  expect(w.calls).toEqual([])

  await w.clock.settle()
  expect(callsOf(w, 'stats')).toHaveLength(1)
  expect(w.spawned).toEqual([{ command: 'update', args: [...SOURCES, '--progress'] }])
  expect(w.statuses).toEqual(['recall: indexing 0%'])

  await w.clock.advance(1_000)
  expect(w.statuses.at(-1)).toBe('recall: indexing 42%')
  expect(w.toasts).toEqual([])

  await w.clock.advance(1_000)
  expect(w.statuses).toEqual(['recall: indexing 0%', 'recall: indexing 42%', 'recall: indexing 99%', undefined])
  expect(w.toasts).toEqual(['recall: indexed 12 sessions'])
  // Then this project's last session is looked for, for the band.
  expect(callsOf(w, 'recap')).toHaveLength(1)
})

test('with an index in place: a quiet update at the start and every updateMinutes; busy is not news', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.spawned).toEqual([])
  expect(callsOf(w, 'update')).toEqual([{ command: 'update', args: [...SOURCES, '--max-seconds', '45'] }])
  expect(w.statuses).toEqual([])
  expect(w.toasts).toEqual([])

  // Every command runs the plugin's own script against the configured index.
  const line = w.argvs.find(argv => argv[0] === PYTHON) ?? []
  expect(line[1]).toMatch(/\/engine\/recall\.py$/)
  expect(line.slice(2, 4)).toEqual(['--db', DB])

  w.engine.update = () => ({ json: { updated: null, busy: true } })
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toHaveLength(2)
  expect(callsOf(w, 'update')[1]).toEqual({ command: 'update', args: [...SOURCES, '--max-seconds', '120'] })
  expect(w.toasts).toEqual([])
  expect(w.logs).toContain('recall: another update holds the index')
})

test(
  'the sources, subagents, index, python and interval come from the options; 0 minutes turns the timer off',
  { ...SLOW, options: { sources: 'codex, claude', includeSubagents: false, dbPath: '~/data/recall.db', python: '/opt/py/bin/python3', updateMinutes: 2 } },
  async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(callsOf(w, 'update')).toEqual([{ command: 'update', args: ['--sources', 'claude,codex', '--max-seconds', '45'] }])
    const line = w.argvs.find(argv => argv[0] === '/opt/py/bin/python3') ?? []
    expect(line.slice(2, 4)).toEqual(['--db', '/Users/me/data/recall.db'])
    await w.clock.advance(2 * 60_000)
    expect(callsOf(w, 'update')).toHaveLength(2)
  },
)

test('updateMinutes 0: no timer', { ...SLOW, options: { updateMinutes: 0 } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(60 * 60_000)
  expect(callsOf(w, 'update')).toHaveLength(1)
})

test('one update at a time: a slow first build holds off the timer and the session end', SLOW, async ($, on) => {
  const w = world(on)
  w.engine.stats = () => ({ json: { ...STATS, docs: 0 } })
  w.stream.steps = [
    { afterMs: 0, chunk: { stream: 'stderr', text: progress(10, 1_000) } },
    { afterMs: 15 * 60_000, chunk: { stream: 'stdout', text: '{"updated":{"sessions":3},"stats":{"sessions":3}}\n' } },
  ]
  await start($, w)
  expect(w.statuses).toEqual(['recall: indexing 0%', 'recall: indexing 1%'])
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  expect(w.shells).toEqual([])
  await w.clock.advance(5 * 60_000)
  expect(w.toasts).toEqual(['recall: indexed 3 sessions'])
  expect(w.statuses.at(-1)).toBeUndefined()
  // The next tick updates again.
  await w.clock.advance(5 * 60_000)
  expect(callsOf(w, 'update')).toHaveLength(1)
})

test("the session's end leaves a short update running on its own", SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })
  expect(w.shells).toHaveLength(1)
  const shell = w.shells[0] ?? []
  expect(shell.slice(0, 5)).toEqual(['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'recall-update', PYTHON])
  expect(shell[5]).toMatch(/\/engine\/recall\.py$/)
  expect(shell.slice(6)).toEqual(['--db', DB, 'update', ...SOURCES, '--max-seconds', '20'])
})

test('an engine that cannot start is said once, the status clears, and the tools still answer', SLOW, async ($, on) => {
  const w = world(on)
  w.isBroken = true
  w.stream.fails = `spawn ${PYTHON} ENOENT`
  await start($, w)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^recall: indexing failed: /)
  expect(w.statuses.at(-1)).toBeUndefined()

  const ran = await $.tool.call({ tool: 'mcp__recall__search', query: 'modal deploy' })
  expect(String(ran.result)).toMatch(/^recall: the search failed: the engine did not run \(/)
  expect(w.toasts).toHaveLength(2)
  expect(w.calls).toEqual([])
})

test('after a reload (no session.start) the next prompt restarts the timer and clears a stale status', SLOW, async ($, on) => {
  const w = world(on)
  await say($, 'hello again')
  expect(w.statuses).toEqual([undefined])
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toEqual([{ command: 'update', args: [...SOURCES, '--max-seconds', '120'] }])
  // Once is enough.
  await say($, 'and again')
  expect(w.statuses).toEqual([undefined])
})

test('an index another process updated under freshMinutes ago: no update at the start, on the tick or at the end; /recall reindex still runs', SLOW, async ($, on) => {
  const w = world(on)
  sidecar(w, NOW - 3 * 60_000)
  await start($, w)
  // Neither the stats check nor the update ran; the last-session band was still looked for.
  expect(w.calls.map(call => call.command)).toEqual(['recap'])
  expect(w.logs).toEqual(['recall: another process updated the index 3m ago (pid 4242): this session skips its own updates while it is under 10 min old'])

  // Another session refreshed it before the tick: skipped too, and the skip is said once.
  sidecar(w, NOW + 9 * 60_000)
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toEqual([])
  expect(w.logs).toHaveLength(1)

  // Past freshMinutes, the next tick updates.
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toEqual([{ command: 'update', args: [...SOURCES, '--max-seconds', '120'] }])

  // The explicit reindex always runs.
  sidecar(w, NOW + 20 * 60_000)
  await recall($, 'reindex')
  await w.clock.settle()
  expect(w.spawned).toEqual([{ command: 'update', args: [...SOURCES, '--progress', '--rebuild'] }])

  // A fresh index at the session's end: no update left running.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })
  expect(w.shells).toEqual([])
})

test('a stale or unreadable last-update.json is no reason to skip', SLOW, async ($, on) => {
  const w = world(on)
  sidecar(w, NOW - 11 * 60_000)
  await start($, w)
  expect(callsOf(w, 'update')).toHaveLength(1)
  w.files.set(SIDECAR, 'not json')
  await w.clock.advance(10 * 60_000)
  expect(callsOf(w, 'update')).toHaveLength(2)
  expect(w.logs).toEqual([])
})

test('freshMinutes 0: every automatic update runs', { ...SLOW, options: { freshMinutes: 0 } }, async ($, on) => {
  const w = world(on)
  sidecar(w, NOW)
  await start($, w)
  expect(callsOf(w, 'update')).toHaveLength(1)
})

test('with /usr/bin/nice present the updates run under nice -n 19; the stats check and the searches do not', SLOW, async ($, on) => {
  const w = world(on)
  w.hasNice = true
  await start($, w)
  const update = w.argvs.find(argv => argv.includes('update')) ?? []
  expect(update.slice(0, 4)).toEqual([...NICE, PYTHON])
  expect(update[4]).toMatch(/\/engine\/recall\.py$/)
  expect(update.slice(5, 8)).toEqual(['--db', DB, 'update'])
  expect(w.argvs.find(argv => argv.includes('stats'))?.[0]).toBe(PYTHON)
  await $.tool.call({ tool: 'mcp__recall__search', query: 'modal deploy' })
  expect(w.argvs.at(-1)?.[0]).toBe(PYTHON)

  // A rebuild and the update a session's end leaves running too.
  await recall($, 'reindex')
  await w.clock.settle()
  expect(w.spawnArgvs[0]?.slice(0, 4)).toEqual([...NICE, PYTHON])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })
  expect(w.shells[0]?.slice(0, 8)).toEqual(['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'recall-update', ...NICE, PYTHON])
})
