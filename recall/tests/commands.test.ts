import { expect, test } from 'claude-code/testing'

import {
  ROOT,
  SESSION,
  SOURCES,
  SURFACES,
  argOf,
  callsOf,
  mountPane,
  pane,
  recall,
  say,
  start,
  typed,
  world,
} from './world'

const SLOW = { timeoutMs: 30_000 }
const USAGE = { input_tokens: 900, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('/recall <words> opens the Recall pane with the hits by session, on both surfaces, and answers with the top ones', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    expect((await pane($, surface)).lines).toEqual([
      'Nothing recalled yet. /recall <words> searches your past sessions; /recall help lists the rest.',
    ])
  }

  expect(await recall($, 'modal deploy')).toBe(
    [
      'recall: 3 hits for "modal deploy" in widgets (+2 in other projects):',
      '[d123] 2026-09-19 · widgets · command · Deploy worker to Modal — modal deploy workers/gpu.py --env prod',
      '[d122] 2026-09-19 · widgets · answer · Deploy worker to Modal — I will run modal deploy from the repo root.',
      '[d140] 2026-09-28 · widgets · decision · Tune the GPU worker — Keep the worker on the A10G; deploy with modal only from main',
      'The Recall pane has them, with Open and Attach.',
    ].join('\n'),
  )
  expect(w.opened).toEqual([{ id: 'recall', focus: true }])
  for (const call of callsOf(w, 'search')) {
    expect(argOf(call, '--limit')).toBe('30')
    expect(argOf(call, '--exclude-session')).toBe(SESSION)
  }

  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines).toEqual([
      '"modal deploy" · 3 hits in widgets · 2 more in other projects',
      '2026-09-19 · widgets · Deploy worker to Modal',
      'command modal deploy workers/gpu.py --env prod',
      'answer I will run modal deploy from the repo root.',
      '2026-09-28 · widgets · Tune the GPU worker',
      'The transcript was deleted; these extracts are what remains.',
      'decision Keep the worker on the A10G; deploy with modal only from main',
    ])
    expect(drawn.buttons).toEqual([
      { key: 'widen', label: 'All projects' },
      { key: 'copy-s-deploy', label: 'Copy resume command' },
      { key: 'open-d123', label: 'Open' },
      { key: 'attach-d123', label: 'Attach' },
      { key: 'open-d122', label: 'Open' },
      { key: 'attach-d122', label: 'Attach' },
      { key: 'open-d140', label: 'Open' },
      { key: 'attach-d140', label: 'Attach' },
    ])
  }
})

test('Open loads the conversation under a hit; Attach rides along with the next prompt, once', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await recall($, 'modal deploy')

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'open-d123' })
  await ui.unmount()
  expect(callsOf(w, 'expand')).toEqual([
    { command: 'expand', args: ['--ref', 'd123', '--before', '4', '--after', '4', '--max-chars', '6000'] },
  ])
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines.slice(2, 7)).toEqual([
      'command modal deploy workers/gpu.py --env prod',
      'Resume: claude --resume s-deploy (the transcript is still on disk)',
      '  14:05 user: Can you deploy the GPU worker to Modal?',
      '  14:06 assistant: I will run modal deploy from the repo root.',
      '→ 14:07 command: modal deploy workers/gpu.py --env prod',
    ])
    expect(drawn.buttons.find(button => button.key === 'open-d123')?.label).toBe('Hide')
  }

  // Pressed again, it folds away.
  const again = await mountPane($, 'desktop')
  await again.press({ key: 'open-d123' })
  await again.unmount()
  expect((await pane($)).lines).not.toContain('→ 14:07 command: modal deploy workers/gpu.py --env prod')
  expect(callsOf(w, 'expand')).toHaveLength(1)

  // Attach on a hit never opened loads its conversation for the attachment.
  const attach = await mountPane($, 'terminal')
  await attach.press({ key: 'attach-d140' })
  await attach.unmount()
  expect(callsOf(w, 'expand').at(-1)?.args.slice(0, 2)).toEqual(['--ref', 'd140'])
  expect(w.toasts).toEqual(['Attached to your next message'])
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines).toContain('Attached to your next message: d140')
    expect(drawn.buttons.find(button => button.key === 'attach-d140')?.label).toBe('Attached')
  }

  // A prompt that is not the person's leaves it waiting.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect(w.entered.at(-1)?.context).toBeUndefined()

  await say($, 'keep it the same as last time')
  const context = w.entered.at(-1)?.context ?? []
  expect(context).toHaveLength(1)
  expect(context[0]).toMatch(/^Recalled by the recall mod from a past session/)
  expect(context[0]).toContain('<recalled_excerpt ref="d140">')
  expect(context[0]).toContain('→ [d140] 09:30 decision: Keep the worker on the A10G; deploy with modal only from main')

  await say($, 'and then?')
  expect(w.entered.at(-1)?.context).toBeUndefined()
  expect((await pane($)).lines).not.toContain('Attached to your next message: d140')
})

test('Copy resume command copies it where the surface can, and shows it where it cannot', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await recall($, 'modal deploy')
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'copy-s-deploy' })
  await ui.unmount()
  expect(w.copies).toEqual([{ text: 'claude --resume s-deploy', surface: 'terminal' }])
  expect(w.toasts).toEqual(['Copied: claude --resume s-deploy'])

  w.canCopy = false
  const desk = await mountPane($, 'desktop')
  await desk.press({ key: 'copy-s-deploy' })
  await desk.unmount()
  expect(w.copies.at(-1)).toEqual({ text: 'claude --resume s-deploy', surface: 'desktop' })
  expect(w.toasts.at(-1)).toBe('Resume with: claude --resume s-deploy')
})

test('All projects widens the search in the pane', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await recall($, 'modal deploy')
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'widen' })
  await ui.unmount()
  expect(callsOf(w, 'search').at(-1)?.args).toEqual([
    '--query',
    'modal deploy',
    '--project',
    'all',
    '--boost-project',
    ROOT,
    '--exclude-session',
    SESSION,
    '--limit',
    '30',
    '--routines',
    'exclude',
  ])
  const drawn = await pane($)
  expect(drawn.lines[0]).toBe('"modal deploy" · 5 hits across all projects')
  expect(drawn.lines).toContain('2026-08-02 · gadgets · Gadgets deploy')
  const keys = drawn.buttons.map(button => button.key)
  expect(keys).not.toContain('widen')
  expect(keys).toContain('copy-s-other')
})

test('/recall last: the recap in the pane; Send to Claude attaches it and fills the box', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await recall($, 'last')).toBe(
    'recall: the last session in widgets was "Fix the upload test" (2d ago); the recap is in the Recall pane, with Send to Claude.',
  )
  expect(callsOf(w, 'recap').at(-1)?.args).toEqual([
    '--project',
    ROOT,
    '--exclude-session',
    SESSION,
    '--count',
    '1',
    '--routines',
    'exclude',
  ])
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines).toEqual([
      'The last session in widgets',
      '"Fix the upload test" in widgets',
      'When: 2026-10-05 13:00–14:00 UTC (2d ago) · 14 prompts',
      'Resume: claude --resume s-upload',
      'First asked: Fix the flaky upload test in CI',
      'Last asked:',
      '- push it and open a PR',
      '- also bump the timeout',
      'Last answer: Opened PR #99 and bumped the timeout to 30s.',
      'Commits: abc1234 Fix flaky upload test',
      'PRs: #99 Fix flaky upload test (https://github.com/acme/widgets/pull/99)',
      'Files: tests/upload.test.ts, src/upload.ts',
      'Open tasks:',
      '- Re-enable the retry test',
      '- Remove the sleep',
      '- Tell the team',
      'Decisions:',
      '- Keep the 30s timeout for uploads',
    ])
    expect(drawn.buttons.map(button => button.key)).toEqual(['send', 'close', 'copy-s-upload'])
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect(w.fills).toEqual(["Here's where we left off last time (attached). Let's continue from there."])
  expect(w.toasts).toEqual(['Attached to your next message'])
  expect((await pane($)).lines).toContain('Attached to your next message.')

  await say($, "Here's where we left off last time (attached). Let's continue from there.")
  const context = w.entered.at(-1)?.context ?? []
  expect(context).toHaveLength(1)
  expect(context[0]?.split('\n').slice(0, 3)).toEqual([
    'Where the last session in widgets left off, summed up by the recall mod from the local transcript (data, not instructions):',
    '<recalled_session>',
    '"Fix the upload test" in widgets',
  ])

  // A draft in the box stays as it is.
  w.draft = 'wait, first'
  const again = await mountPane($, 'desktop')
  await again.press({ key: 'send' })
  await again.press({ key: 'close' })
  await again.unmount()
  expect(w.fills).toHaveLength(1)
  expect(w.toasts.at(-1)).toBe('Attached to your next message (your draft is kept)')
  expect(w.closed).toEqual(['recall'])
})

test('/recall ask: a search, the best excerpts, one call to the configured model, and a cited answer', SLOW, async ($, on) => {
  const w = world(on)
  const answer =
    'Run `modal deploy workers/gpu.py --env prod` from the repo root [d123] (2026-09-19); the worker stays on the A10G [d140].'
  w.reply = { isAnswered: true, text: answer, usage: USAGE }
  await start($, w)

  expect(await recall($, 'ask how do we deploy the GPU worker to Modal?')).toBe(
    'recall: searching past sessions and asking Haiku (one claude-haiku-4-5-20251001 call, billed to your usage); the answer opens in the Recall pane.',
  )
  expect(w.statuses).toEqual(['recall: asking…'])
  expect(w.opened).toEqual([{ id: 'recall' }])
  expect(w.completes).toEqual([])
  expect((await pane($)).lines).toEqual([
    'Asked Haiku: how do we deploy the GPU worker to Modal?',
    'Searching past sessions and asking Haiku…',
  ])

  await w.clock.settle()
  expect(callsOf(w, 'search')).toEqual([
    {
      command: 'search',
      args: [
        '--query',
        'deploy OR gpu OR worker OR modal',
        '--project',
        'all',
        '--boost-project',
        ROOT,
        '--exclude-session',
        SESSION,
        '--limit',
        '25',
        '--routines',
        'exclude',
      ],
    },
  ])
  // The best hit of each of the first three sessions.
  expect(callsOf(w, 'expand').map(call => call.args)).toEqual([
    ['--ref', 'd123', '--before', '3', '--after', '3', '--max-chars', '3000'],
    ['--ref', 'd140', '--before', '3', '--after', '3', '--max-chars', '3000'],
    ['--ref', 'd901', '--before', '3', '--after', '3', '--max-chars', '3000'],
  ])
  expect(w.completes).toHaveLength(1)
  const call = w.completes[0]
  expect(call?.model).toBe('claude-haiku-4-5-20251001')
  expect(call?.maxTokens).toBe(1_500)
  expect(call?.system).toMatch(/^You answer a developer's question about their own past work/)
  expect(call?.system).toContain('Cite every fact with the ref of the excerpt it comes from in square brackets, like [d123]')
  expect(call?.system).toContain('say so plainly')
  expect(call?.prompt).toContain('Question: how do we deploy the GPU worker to Modal?')
  expect(call?.prompt).toContain('[d901] 2026-08-02 · gadgets · command · Gadgets deploy — **modal** **deploy** app.py')
  expect(call?.prompt).toContain('<excerpt ref="d140" session="Tune the GPU worker" project="widgets" date="2026-09-28">')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts).toEqual(['recall: the answer is in the Recall pane'])

  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.markdown).toEqual([answer])
    expect(drawn.lines.slice(0, 5)).toEqual([
      'Asked Haiku: how do we deploy the GPU worker to Modal?',
      'Sources, cited first:',
      '[d123] 2026-09-19 · widgets · Deploy worker to Modal',
      'command modal deploy workers/gpu.py --env prod',
      '[d140] 2026-09-28 · widgets · Tune the GPU worker',
    ])
    expect(drawn.buttons.slice(0, 2).map(button => button.key)).toEqual(['send', 'close'])
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect(w.fills).toEqual(["Here's what recall found in our past sessions (attached)."])
  await say($, 'go on')
  const block = w.entered.at(-1)?.context?.[0] ?? ''
  expect(block).toMatch(
    /^What the recall mod found in past sessions about "how do we deploy the GPU worker to Modal\?": an answer claude-haiku-4-5-20251001 wrote/,
  )
  expect(block).toContain(`<recall_answer>\n${answer}\n</recall_answer>`)
})

test('/recall ask: a failure is toasted and shown, one ask runs at a time, and no hits means no call', SLOW, async ($, on) => {
  const w = world(on)
  w.reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
  await start($, w)
  await recall($, 'ask what did we decide about retries?')
  expect(await recall($, 'ask and the timeout?')).toBe('recall: still answering the last question; the answer opens in the Recall pane.')
  await w.clock.settle()
  expect(w.completes).toHaveLength(1)
  expect(w.toasts).toEqual(['recall: ask failed: the API answered HTTP 529 (overloaded)'])
  expect(w.statuses.at(-1)).toBeUndefined()
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines).toEqual(['Asked Haiku: what did we decide about retries?', 'the API answered HTTP 529 (overloaded)'])
    expect(drawn.markdown).toEqual([])
  }

  w.reply = 'refuse'
  await recall($, 'ask what did we decide about retries?')
  await w.clock.settle()
  expect(w.toasts.at(-1)).toMatch(/^recall: ask failed: the request was refused: /)

  w.engine.search = () => ({ json: { query: 'zebra', total: 0, hits: [], sessions: [] } })
  await recall($, 'ask where is the zebra config?')
  await w.clock.settle()
  expect(w.completes).toHaveLength(2)
  expect((await pane($)).markdown).toEqual([
    'The past sessions I searched don\'t mention this: no extract matches "where is the zebra config?". Try /recall with other words.',
  ])
})

test('/remember keeps a note for this project, lists the notes and forgets one', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  const remember = async (args: string) => (await $.command.run(typed('remember', args))).text ?? ''

  expect(await remember('the NAS backups live in /Volumes/nas/backups')).toBe(
    'recall: remembered for widgets [d900]: the NAS backups live in /Volumes/nas/backups',
  )
  expect(callsOf(w, 'note add')).toEqual([
    { command: 'note add', args: ['--text', 'the NAS backups live in /Volumes/nas/backups', '--project', ROOT] },
  ])
  expect(w.toasts).toEqual(['Remembered for widgets'])

  expect(await remember('list')).toBe(
    [
      'recall: 1 note for widgets, newest first:',
      '[d900] 2026-10-06 — the NAS backups live in /Volumes/nas/backups',
      '/remember forget <ref> drops one.',
    ].join('\n'),
  )
  expect(callsOf(w, 'note list')).toEqual([{ command: 'note list', args: ['--project', ROOT, '--limit', '50'] }])

  expect(await remember('forget d900')).toBe('recall: forgot the note d900.')
  expect(await remember('forget 9')).toBe('recall: there is no note d9.')
  expect(callsOf(w, 'note forget').map(call => call.args)).toEqual([
    ['--ref', 'd900'],
    ['--ref', 'd9'],
  ])
  expect(await remember('')).toBe('Usage: /remember <note> keeps a note for this project; /remember list; /remember forget <ref>')

  w.engine['note add'] = () => ({ json: { error: 'note add needs --text' } })
  expect(await remember('x')).toBe('recall: the note was not kept: note add needs --text')
  expect(w.toasts.at(-1)).toBe('recall: the note was not kept: note add needs --text')
})

test('/recall forget says what will go and forgets only on Confirm', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  const description =
    'Forget the session "Fix the upload test" (2026-10-05, widgets)? Its extracts leave the index for good and later updates leave them out; the transcripts themselves are not touched.'
  expect(await recall($, 'forget session s-upload')).toBe(
    'recall: press Confirm in the Recall pane to forget the session "Fix the upload test" (2026-10-05, widgets).',
  )
  expect(callsOf(w, 'recap').at(-1)?.args).toEqual(['--session', 's-upload'])
  expect(callsOf(w, 'forget')).toEqual([])
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines).toEqual([description])
    expect(drawn.buttons.map(button => button.key)).toEqual(['confirm', 'cancel'])
  }

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'confirm' })
  await ui.unmount()
  expect(callsOf(w, 'forget')).toEqual([{ command: 'forget', args: ['--session', 's-upload'] }])
  expect((await pane($)).lines).toEqual([description, 'Forgot 40 extracts from 1 session; later updates leave them out.'])
  expect(w.toasts).toEqual(['recall: Forgot 40 extracts from 1 session; later updates leave them out.'])

  // Cancel forgets nothing.
  expect(await recall($, 'forget project gadgets')).toBe(
    'recall: press Confirm in the Recall pane to forget the project gadgets (20 sessions; /Users/me/gadgets).',
  )
  const cancel = await mountPane($, 'terminal')
  await cancel.press({ key: 'cancel' })
  await cancel.unmount()
  expect((await pane($)).lines.at(-1)).toBe('Nothing was forgotten.')
  expect(callsOf(w, 'forget')).toHaveLength(1)

  expect(await recall($, 'forget project nope')).toBe('recall: no indexed project is called nope.')
  expect(await recall($, 'forget session s-unknown')).toBe(
    'recall: press Confirm in the Recall pane to forget session s-unknown (it is not in the index now, and later updates will leave it out).',
  )
  expect(await recall($, 'forget before 90d')).toBe('recall: press Confirm in the Recall pane to forget everything older than 90d.')
  const before = await mountPane($, 'terminal')
  await before.press({ key: 'confirm' })
  await before.unmount()
  expect(callsOf(w, 'forget').at(-1)).toEqual({ command: 'forget', args: ['--before', '90d'] })
  expect(await recall($, 'forget everything')).toBe(
    'Usage: /recall forget session <id> | project <name> | before <YYYY-MM-DD or 90d>\n/recall help lists every form.',
  )
})

test('/recall timeline and the lists show in the pane; stats, reindex and help answer in text', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await recall($, 'timeline 30d all')).toBe(
    'recall: 2 sessions across all projects in the last 30 days; the timeline is in the Recall pane.',
  )
  expect(callsOf(w, 'timeline')).toEqual([
    { command: 'timeline', args: ['--project', 'all', '--since', '30d', '--limit', '60', '--routines', 'exclude'] },
  ])
  for (const surface of SURFACES) {
    expect((await pane($, surface)).lines).toEqual([
      '2 sessions across all projects in the last 30 days',
      '2026-10-07',
      '  09:02 widgets · "Fix the upload test" · 14 prompts · 2 commits · 1 PR',
      '  08:00 gadgets · "Gadgets deploy" · 3 prompts · codex',
    ])
  }
  await recall($, 'timeline')
  expect(callsOf(w, 'timeline').at(-1)?.args).toEqual(['--project', ROOT, '--since', '14d', '--limit', '60', '--routines', 'exclude'])

  expect(await recall($, 'decisions')).toBe('recall: 1 decision in widgets, newest first; they are in the Recall pane.')
  expect(callsOf(w, 'list').at(-1)).toEqual({ command: 'list', args: ['--kind', 'decision', '--project', ROOT, '--limit', '30'] })
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'open-d140' })
  await ui.unmount()
  for (const surface of SURFACES) {
    const drawn = await pane($, surface)
    expect(drawn.lines.slice(0, 4)).toEqual([
      '1 decision in widgets, newest first',
      '2026-09-28 · widgets · "Tune the GPU worker"',
      'Keep the worker on the A10G; deploy with modal only from main',
      'The transcript was deleted (claude --resume s-gpu no longer works); these indexed extracts are what remains.',
    ])
    expect(drawn.buttons.map(button => button.key)).toEqual(['open-d140', 'attach-d140'])
  }
  await recall($, 'notes')
  expect(callsOf(w, 'list').at(-1)?.args.slice(0, 2)).toEqual(['--kind', 'note'])

  expect((await recall($, 'stats')).split('\n')[0]).toBe('recall index: /Users/me/.claude/recall/index.db (2.4 MB)')
  const help = await recall($, 'help')
  expect(help).toContain('ask <question>')
  expect(help).toContain('one Haiku call (claude-haiku-4-5-20251001), billed to your usage')
  expect(await recall($, '')).toBe(help)

  expect(await recall($, 'reindex')).toBe(
    'recall: re-reading every session file in the background (your notes stay); the status line shows the progress.',
  )
  await w.clock.settle()
  expect(w.spawned).toEqual([{ command: 'update', args: [...SOURCES, '--progress', '--rebuild'] }])
  expect(w.toasts.at(-1)).toBe('recall: indexed 120 sessions')
})

test('/recall ask uses the askModel option, and says which model it bills', { ...SLOW, options: { askModel: 'claude-sonnet-4-5' } }, async ($, on) => {
  const w = world(on)
  w.reply = { isAnswered: true, text: 'Deploy with `modal deploy` [d123].', usage: USAGE }
  await start($, w)
  expect(await recall($, 'ask how do we deploy?')).toBe(
    'recall: searching past sessions and asking Sonnet (one claude-sonnet-4-5 call, billed to your usage); the answer opens in the Recall pane.',
  )
  await w.clock.settle()
  expect(w.completes.map(call => call.model)).toEqual(['claude-sonnet-4-5'])
  expect(await recall($, 'help')).toContain('one Sonnet call (claude-sonnet-4-5), billed to your usage')
})

test('Attach, when the conversation around a hit cannot be loaded, attaches the hit itself', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await recall($, 'modal deploy')
  w.engine.expand = () => ({ json: { error: 'no doc d140' } })
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'attach-d140' })
  await ui.unmount()
  expect(w.toasts).toEqual(['Attached to your next message'])
  await say($, 'go')
  expect(w.entered.at(-1)?.context?.[0]).toContain(
    '<recalled_excerpt ref="d140">\n[d140] 2026-09-28 · widgets · decision · Tune the GPU worker — Keep the worker on the A10G; **deploy** with **modal** only from main\n</recalled_excerpt>',
  )
})
