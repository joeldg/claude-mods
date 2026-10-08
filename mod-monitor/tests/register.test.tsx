import { expect, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { dayOf, parseLines } from '../hooks/log'
import type { CountsLine, Line } from '../types'
import { DAY, NOW, PAST, jsonl } from './fixtures'
import { HOME, OWN, ROOT, SESSION, SURFACES, TODAY, alerts, mods, mountPane, ownLines, start, typed, world } from './world'

// The monitor sits in an outer tier, so the inline plugins below stand for the mods beneath it.
tier('prepend')

const SLOW = { timeoutMs: 30_000 }

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} }

/** A mod whose tool.call hook throws before `next`. */
const FLAKY: Plugin = {
  name: 'flaky',
  register(on) {
    on('tool.call', async () => {
      throw new Error('flaky broke')
    })
  },
}

/** A mod whose tool.call hook takes 60 ms of its own time. */
const SLUGGISH: Plugin = {
  name: 'sluggish',
  register(on) {
    on('tool.call', async ($, e, next) => {
      const started = Date.now()
      while (Date.now() - started < 60) {
        // Busy, as a slow hook is.
      }
      return next(e)
    })
  },
}

/** A mod that registers a command and a tool, and whose command toasts, sets its status, runs gh, asks the model and writes. */
const CHATTY: Plugin = {
  name: 'chatty',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'chat', description: 'Talks' })
      await $.tool.register({ name: 'ask', description: 'Asks', inputSchema: { type: 'object' } })
      return next(e)
    })
    on('command.run', { command: 'chat' }, async $ => {
      $.ui.toast('#219 merged → main')
      $.ui.status('chat: 1 open')
      $.ui.status('chat: 1 open')
      $.ui.status('chat: 2 open')
      await $.process.run(['gh', 'pr', 'view', '219']).catch(() => null)
      await $.model.complete({ model: 'haiku', prompt: 'Summarise the thread' })
      await $.fs.write('/Users/me/.claude/chatty/state.json', '{"note":"never logged"}')
      return { text: 'chatted' }
    })
    on('tool.call', { tool: 'mcp__chatty__ask' }, async () => ({ result: 'asked', text: 'asked' }))
  },
}

/** A mod that only registers a command: loaded, never used. */
const QUIET: Plugin = {
  name: 'quiet',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'hush', description: 'Nothing' })
      return next(e)
    })
  },
}

/** A mod admitted but never in a chain beneath the monitor: it hooks only what the monitor does not watch. */
const HIDDEN: Plugin = {
  name: 'hidden',
  register(on) {
    on('prompt.edit', ($, e, next) => next(e))
  },
}

/** A mod that asks git about a folder that is no repository, as several mods do at session start. */
const GIT_PROBE: Plugin = {
  name: 'git-probe',
  register(on) {
    on('command.run', { command: 'probe' }, async $ => {
      await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => null)
      return { text: 'probed' }
    })
  },
}

/** A mod whose command runs a process that fails. */
const POLLER: Plugin = {
  name: 'poller',
  register(on) {
    on('command.run', { command: 'poll' }, async $ => {
      await $.process.run(['false', '--quiet']).catch(() => null)
      return { text: 'polled' }
    })
  },
}

/** A mod whose band drawing throws. */
const PAINTER: Plugin = {
  name: 'painter',
  register(on) {
    on('ui.render', { component: 'AbovePrompt' }, () => {
      throw new Error('paint failed')
    })
  },
}

/** A mod that rewrites prompts and draws a band with a Button. */
const SHOUTER: Plugin = {
  name: 'shouter',
  register(on) {
    let pressed = 0
    on('prompt.submit', ($, e, next) => next({ ...e, text: e.text.toUpperCase() }))
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box>
          <Text>pressed {pressed}</Text>
          <Button
            key="shout"
            label="Shout"
            onPress={() => {
              pressed += 1
              $.ui.toast(`shouted ${pressed}`)
            }}
          />
        </Box>
      )
    })
  },
}

const events = (lines: readonly Line[], plugin: string, kind: string) =>
  lines.filter(line => line.plugin === plugin && line.t === 'event' && line.kind === kind)

const tally = (lines: readonly Line[], plugin: string): CountsLine | undefined =>
  lines.find((line): line is CountsLine => line.plugin === plugin && line.t === 'counts')

test('a mod whose tool.call hook throws: logged with its event and outcome, toasted once, then only counted', { ...SLOW, plugins: [FLAKY] }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'read', text: 'read' }))
  await start($, w)

  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.txt' })
  await w.clock.settle()
  expect(alerts(w)).toEqual(["mod-monitor: flaky's tool.call hook threw (1×) — /mods for details"])

  await $.tool.call({ tool: 'Read', file_path: '/tmp/b.txt' })
  await w.clock.settle()
  expect(alerts(w)).toHaveLength(1)

  await w.clock.advance(60_000)
  const lines = ownLines(w)
  expect(events(lines, 'flaky', 'failure')).toEqual([
    expect.objectContaining({ event: 'tool.call', outcome: 'skipped', what: 'threw', n: 2 }),
  ])
  expect(tally(lines, 'flaky')).toMatchObject({ runs: { 'tool.call': 2 }, fails: 2 })
})

test('a slow hook: its slow runs, max and p95 for the event', { ...SLOW, options: { slowMs: 10 }, plugins: [SLUGGISH] }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'read', text: 'read' }))
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.txt' })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/b.txt' })
  await w.clock.advance(60_000)

  const lines = ownLines(w)
  const counted = tally(lines, 'sluggish')
  expect(counted?.runs).toEqual({ 'tool.call': 2 })
  expect(counted?.slow['tool.call']?.n).toBe(2)
  // The trace's own clock: about 60 ms, give or take its tick.
  expect(counted?.slow['tool.call']?.max).toBeGreaterThanOrEqual(50)
  expect(counted?.slow['tool.call']?.p95).toBeGreaterThanOrEqual(50)
  expect(events(lines, 'sluggish', 'slow')).toEqual([expect.objectContaining({ event: 'tool.call', n: 2 })])
  // Slow is no failure.
  expect(alerts(w)).toEqual([])
})

test('what a mod does through $ is credited to it by origin', { ...SLOW, plugins: [CHATTY] }, async ($, on) => {
  const w = world(on)
  w.procs.gh = { exitCode: 1, stderr: '\nHTTP 404: Not Found (repos/acme/widgets/pulls/219)\nmore detail' }
  await start($, w)

  expect((await $.command.run(typed('chat'))).text).toBe('chatted')
  expect(await $.tool.call({ tool: 'mcp__chatty__ask', question: 'why' })).toMatchObject({ result: 'asked' })
  await w.clock.settle()
  await w.clock.advance(60_000)

  const lines = ownLines(w)
  expect(events(lines, 'chatty', 'seen')).toHaveLength(1)
  expect(events(lines, 'chatty', 'register')).toEqual([
    expect.objectContaining({ what: 'command', name: 'chat' }),
    expect.objectContaining({ what: 'tool', name: 'ask' }),
  ])
  expect(events(lines, 'chatty', 'toast')).toEqual([expect.objectContaining({ text: '#219 merged → main' })])
  // The repeat is dropped; the change folds into the minute's line.
  expect(events(lines, 'chatty', 'status')).toEqual([expect.objectContaining({ text: 'chat: 2 open', n: 2 })])
  expect(events(lines, 'chatty', 'proc-fail')).toEqual([
    expect.objectContaining({ cmd: 'gh pr', exit: 1, err: 'HTTP 404: Not Found (repos/acme/widgets/pulls/219)' }),
  ])
  expect(events(lines, 'chatty', 'model')).toEqual([
    expect.objectContaining({ model: 'haiku', outcome: 'answered', usage: { in: 10, out: 5, cacheRead: 2, cacheWrite: 0 } }),
  ])
  expect(events(lines, 'chatty', 'write')).toEqual([expect.objectContaining({ dir: '~/.claude/chatty' })])
  expect(events(lines, 'chatty', 'command')).toEqual([expect.objectContaining({ command: 'chat', hasArgs: false, by: 'composer' })])
  expect(tally(lines, 'chatty')).toMatchObject({
    runs: { 'session.start': 1, 'command.run': 1, 'tool.call': 1 },
    toasts: 1,
    procs: 1,
    procFails: 1,
    models: 1,
    writes: 1,
    cmds: 1,
    tools: 1,
  })
  // Never a file's contents.
  expect(w.files.get(OWN)).not.toContain('never logged')
})

test('the log: only this session’s file, written whole at each flush and at the end', { ...SLOW, plugins: [CHATTY] }, async ($, on) => {
  const w = world(on)
  const other = `${ROOT}/${TODAY}/0ther5e5.jsonl`
  const otherText = jsonl(PAST[0]?.lines ?? [])
  w.files.set(other, otherText)
  await start($, w)

  await $.command.run(typed('chat'))
  await w.clock.advance(60_000)
  expect(events(ownLines(w), 'chatty', 'command')).toHaveLength(1)

  await $.command.run(typed('chat'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } })

  const ours = w.writes.filter(write => write.by === 'mod-monitor')
  expect(ours.length).toBeGreaterThanOrEqual(2)
  expect(new Set(ours.map(write => write.path))).toEqual(new Set([OWN]))
  expect(w.files.get(other)).toBe(otherText)
  const text = w.files.get(OWN) ?? ''
  for (const raw of text.trim().split('\n')) {
    expect(JSON.parse(raw)).toMatchObject({ t: expect.any(String), ts: expect.any(Number), plugin: expect.any(String) })
  }
  expect(events(parseLines(text), 'chatty', 'command')).toHaveLength(2)
  const counted = parseLines(text).filter((line): line is CountsLine => line.t === 'counts' && line.plugin === 'chatty')
  expect(counted.reduce((sum, line) => sum + line.cmds, 0)).toBe(2)
  expect(counted.reduce((sum, line) => sum + (line.runs['session.end'] ?? 0), 0)).toBe(0)
})

const DIRS = [
  '/Users/me/mods/mod-monitor',
  '/Users/me/mods/flaky',
  '~/mods/chatty',
  '/Users/me/mods/quiet',
  '/Users/me/mods/ghost-folder/',
  '/Users/me/mods/hidden',
].join(':')

test('/mods: a row per mod and its health, on the terminal and the desktop; Details shows its events', { ...SLOW, plugins: [FLAKY, CHATTY, QUIET, HIDDEN] }, async ($, on) => {
  const w = world(on, { CLAUDE_CODE_PLUGIN_DIRS: DIRS })
  w.files.set('/Users/me/mods/chatty/.claude-plugin/plugin.json', JSON.stringify({ name: 'chatty' }))
  w.files.set('/Users/me/mods/ghost-folder/.claude-plugin/plugin.json', JSON.stringify({ name: 'ghost' }))
  on('tool.call', () => ({ result: 'read', text: 'read' }))
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.txt' })
  await $.command.run(typed('chat'))
  await w.clock.settle()

  const summary = await mods($)
  expect(summary).toContain('3 of 5 mods loaded · 3 covered · 1 failing today')
  expect(summary).toContain('⚠ flaky: just now · ✗ tool.call hook threw')
  expect(summary).toContain('✗ not seen: ghost, hidden (not loaded, or silent so far)')
  expect(summary).toContain('Every loaded mod has run beneath the monitor.')
  expect(w.opened).toEqual(['mods'])

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts[0]).toBe('3 of 5 mods loaded · 3 covered · 1 failing today')
    expect(texts).toContain('⚠ flaky')
    expect(texts).toContain('✓ chatty')
    expect(texts).toContain('· quiet')
    expect(texts).toContain('✗ ghost')
    expect(texts).toContain('✗ hidden')
    // The command is logged once its run is over, after the toast it raised.
    expect(texts).toContain('just now · /chat')
    expect(texts).toContain('hooks 2 · toasts 1 · commands 1 · model calls 1')
    expect(texts).toContain('not seen in this session (not loaded, or silent so far)')
    expect(texts).toContain('loaded, nothing done today')
    expect(texts).toContain(`Logs: ~/.claude/mods/monitor/${TODAY}/`)
    const isDetail = (text: string) => /^\d\d:\d\d {2}/.test(text)
    expect(texts.filter(isDetail)).toEqual([])

    await ui.press({ key: 'details-flaky' })
    const opened = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(opened.filter(isDetail)).toEqual([expect.stringMatching(/^\d\d:\d\d {2}✗ tool\.call hook threw \(.+\)$/)])
    expect((await ui.find({ key: 'details-flaky' }))?.props.label).toBe('Hide')
    await ui.press({ key: 'details-flaky' })
    await ui.unmount()
  }
})

test('/mods report 7d: two sessions on different days, an older one left out; written to report-latest.md', SLOW, async ($, on) => {
  const w = world(on, {
    CLAUDE_CODE_PLUGIN_DIRS: '/Users/me/mods/recall:/Users/me/mods/pr-autopilot:/Users/me/mods/job-watch:/Users/me/mods/slicer-handoff',
  })
  for (const past of PAST) {
    w.files.set(`${ROOT}/${dayOf(past.ts)}/${past.session}.jsonl`, jsonl(past.lines))
  }
  await start($, w)

  const text = await mods($, 'report 7d')
  expect(text).toStartWith('# Mods report: last 7d (')
  expect(text).toContain('2 sessions · 3 mods seen · 1 with failures')
  expect(text).toContain('recall — loaded in 2 sessions')
  expect(text).toContain('  hook runs 48: tool.call 30 · prompt.submit 16 · session.start 2')
  expect(text).toContain('  toasts 6: "Indexed 40 new extracts" ×3 · "Recall is ready" ×2 · "Index is 3 days old" ×1')
  expect(text).toContain('  commands used: /recall ×3 (1 bare)')
  expect(text).toContain('  slowest hooks: session.start max 2.4 s, p95 2.4 s (1 slow)')
  expect(text).toContain('pr-autopilot — loaded in 1 session')
  expect(text).toContain('Never seen: slicer-handoff')
  expect(text).toContain('Written to ~/.claude/mods/monitor/report-latest.md')

  const written = w.files.get(`${ROOT}/report-latest.md`) ?? ''
  expect(written).toStartWith('# Mods report: last 7d (')
  expect(text.startsWith(written)).toBe(true)
  // The monitor wrote nothing else: no lines of its own yet, and the past files untouched.
  expect(w.writes.filter(write => write.by === 'mod-monitor').map(write => write.path)).toEqual([`${ROOT}/report-latest.md`])

  expect(await mods($, 'report 30d')).toContain('recall — loaded in 3 sessions')
  expect(await mods($, 'report fortnight')).toBe('mod-monitor: "fortnight" is not a range; use 24h, 7d or 30d.')
})

test('/mods failures: hook failures and process errors alone; /mods help', SLOW, async ($, on) => {
  const w = world(on)
  for (const past of PAST) {
    w.files.set(`${ROOT}/${dayOf(past.ts)}/${past.session}.jsonl`, jsonl(past.lines))
  }
  await start($, w)
  const text = await mods($, 'failures')
  expect(text).toStartWith('# Mod failures: last 7d (')
  expect(text).toContain('recall\n  hook failures 1:')
  expect(text).toContain('  process failures 2:')
  expect(text).not.toContain('pr-autopilot')
  expect(text).not.toContain('toasts')
  expect(await mods($, 'failures 24h')).toContain('No hook failures or process errors.')
  expect(await mods($, 'help')).toContain('/mods report [24h|7d|30d]')
  expect(await mods($, 'nonsense')).toStartWith('mod-monitor: no /mods nonsense.')
})

test('the monitor never changes what passes through it', { ...SLOW, plugins: [SHOUTER] }, async ($, on) => {
  const w = world(on)
  const answer = { result: { stdout: 'x', stderr: '', interrupted: false }, text: 'exact text', context: ['note one'] }
  on('tool.call', () => answer)
  on('prompt.submit', (_$, e) => ({ text: `${e.text}!`, context: ['from beneath'] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await start($, w)

  expect(await $.tool.call({ tool: 'Read', file_path: '/tmp/a.txt' })).toEqual(answer)
  expect(await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })).toEqual({
    text: 'HELLO!',
    context: ['from beneath'],
  })
  // A rejection from beneath comes back as it was.
  await expect($.tool.check({ tool: 'Read', input: { file_path: '/tmp/a.txt' } })).rejects.toThrow(/no implementation for tool\.check/)

  // A band drawn beneath keeps its Button.
  const ui = await $.ui.mount({ plugin: 'shouter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'shout' })
  await w.clock.settle()
  expect(w.toasts.filter(toast => toast.by === 'shouter').map(toast => toast.text)).toEqual(['shouted 1'])
  await ui.unmount()
  expect(alerts(w)).toEqual([])
})

test('retention removes old day folders, and only dated folders inside the monitor folder', SLOW, async ($, on) => {
  const w = world(on)
  const old = `${ROOT}/${dayOf(NOW - 45 * DAY)}`
  const recent = `${ROOT}/${dayOf(NOW - 3 * DAY)}`
  const keepers = [
    `${recent}/bbbb2222.jsonl`,
    `${ROOT}/notes/2001-01-01.txt`,
    `${ROOT}/report-latest.md`,
    `${HOME}/.claude/other/${dayOf(NOW - 90 * DAY)}/x.jsonl`,
  ]
  w.files.set(`${old}/aaaa1111.jsonl`, '{}\n')
  for (const path of keepers) {
    w.files.set(path, 'keep\n')
  }
  await start($, w)

  expect(w.argvs.filter(run => run.by === 'mod-monitor').map(run => run.argv)).toEqual([['/bin/rm', '-rf', '--', old]])
  expect(w.files.has(`${old}/aaaa1111.jsonl`)).toBe(false)
  for (const path of keepers) {
    expect(w.files.get(path)).toBe('keep\n')
  }
})

test('retention follows retentionDays', { ...SLOW, options: { retentionDays: 2 } }, async ($, on) => {
  const w = world(on)
  const recent = `${ROOT}/${dayOf(NOW - 3 * DAY)}`
  const yesterday = `${ROOT}/${dayOf(NOW - DAY)}`
  w.files.set(`${recent}/bbbb2222.jsonl`, '{}\n')
  w.files.set(`${yesterday}/cccc3333.jsonl`, '{}\n')
  await start($, w)
  expect(w.argvs.map(run => run.argv)).toEqual([['/bin/rm', '-rf', '--', recent]])
  expect(w.files.has(`${yesterday}/cccc3333.jsonl`)).toBe(true)
})

test('five process failures in ten minutes: one toast, and the mod is flagged', { ...SLOW, plugins: [POLLER] }, async ($, on) => {
  const w = world(on)
  w.procs.false = { exitCode: 1, stderr: 'nope' }
  await start($, w)
  for (let i = 0; i < 4; i++) {
    await $.command.run(typed('poll'))
    await w.clock.advance(60_000)
  }
  await w.clock.settle()
  expect(alerts(w)).toEqual([])
  await $.command.run(typed('poll'))
  await w.clock.settle()
  expect(alerts(w)).toEqual(["mod-monitor: poller's processes failed 5× in 10 min (last: false, exit 1) — /mods for details"])
  await $.command.run(typed('poll'))
  await w.clock.settle()
  expect(alerts(w)).toHaveLength(1)
  expect(await mods($)).toContain('⚠ poller: just now · /poll')
})

test('a mod whose band drawing throws: a failure, never a counted run', { ...SLOW, plugins: [PAINTER] }, async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'painter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.unmount()
  await w.clock.settle()
  expect(alerts(w)).toEqual(["mod-monitor: painter's ui.render hook threw (1×) — /mods for details"])
  await w.clock.advance(60_000)
  expect(tally(ownLines(w), 'painter')).toMatchObject({ runs: {}, fails: 1 })
})

test('with watchRender off, drawing is not watched', { ...SLOW, options: { watchRender: false }, plugins: [PAINTER] }, async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'painter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.unmount()
  await w.clock.settle()
  expect(alerts(w)).toEqual([])
})

test('after /clear the next lines go to the new session’s file', { ...SLOW, plugins: [CHATTY] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run(typed('chat'))
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  w.sessionId = 'c0ffee00-1111-4000-8000-000000000002'
  await $.command.run(typed('chat'))
  await w.clock.advance(60_000)

  const fresh = parseLines(w.files.get(`${ROOT}/${TODAY}/c0ffee00.jsonl`) ?? '')
  expect(events(fresh, 'chatty', 'seen')).toHaveLength(1)
  expect(events(fresh, 'chatty', 'command')).toHaveLength(1)
  expect(events(ownLines(w), 'chatty', 'command')).toHaveLength(1)
})

test('right after /clear the ended session’s file is never overwritten, even while its id still answers', { ...SLOW, plugins: [CHATTY] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run(typed('chat'))
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  const ended = w.files.get(OWN)
  expect(events(parseLines(ended ?? ''), 'chatty', 'command')).toHaveLength(1)

  // The old id still answers for a moment: nothing is written under it.
  await $.command.run(typed('chat'))
  await w.clock.advance(60_000)
  expect(w.files.get(OWN)).toBe(ended)

  // Once the new id answers, the held lines land in the new file.
  w.sessionId = 'c0ffee00-1111-4000-8000-000000000002'
  await w.clock.advance(60_000)
  expect(events(parseLines(w.files.get(`${ROOT}/${TODAY}/c0ffee00.jsonl`) ?? ''), 'chatty', 'command')).toHaveLength(1)
  expect(w.files.get(OWN)).toBe(ended)
})

/** A mod that writes a file while its session starts. */
const EARLY: Plugin = {
  name: 'early',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.fs.write('/Users/me/.claude/early/boot.json', '{"started":true}')
      return next(e)
    })
  },
}

test('a write made while the session starts is logged by its folder, home-relative', { ...SLOW, plugins: [EARLY] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(60_000)
  const lines = ownLines(w)
  expect(events(lines, 'early', 'write')).toEqual([expect.objectContaining({ dir: '~/.claude/early' })])
  expect(tally(lines, 'early')).toMatchObject({ runs: { 'session.start': 1 }, writes: 1 })
  expect(w.files.get(OWN)).not.toContain(HOME)
})

test('a git probe outside a repository is expected: logged, not counted, never alerted', { ...SLOW, plugins: [GIT_PROBE] }, async ($, on) => {
  const w = world(on, {})
  w.procs.git = { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
  await start($, w)
  for (let i = 0; i < 6; i++) {
    await $.command.run(typed('probe'))
  }
  await w.clock.settle()
  expect(alerts(w).filter(text => text.includes('processes failed'))).toEqual([])
  const summary = await mods($)
  expect(summary).not.toContain('⚠ git-probe')
})
