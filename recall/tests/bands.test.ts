import { expect, test } from 'claude-code/testing'

import {
  BAND,
  CWD,
  DAY,
  NOW,
  RECAP_UPLOAD,
  ROOT,
  SESSION,
  SURFACES,
  argOf,
  band,
  callsOf,
  pane,
  say,
  start,
  world,
} from './world'
import type { World } from './world'

const SLOW = { timeoutMs: 30_000 }
const LAST = 'Last session here (2d ago): "Fix the upload test" · PR #99 · 3 open tasks'
const RELATED = 'Past sessions mention #214: Sep 25 "merged 213, go ahead with #214" (+2 more)'
const TURN = { answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' as const }

const mention = (ref: string, hour: number, kind: string, snippet: string, extra: Record<string, unknown> = {}) => ({
  ref,
  session: 's-merge',
  project: ROOT,
  projectName: 'widgets',
  title: 'Merge the retry PRs',
  ts: Date.UTC(2026, 8, 25, hour),
  kind,
  role: 'assistant',
  source: 'claude',
  snippet,
  score: 4,
  extra,
})

/** Past sessions that mention #214: a prompt, the PR itself and its commit. */
const MENTIONS = {
  query: '"#214"',
  total: 3,
  hits: [
    mention('d300', 10, 'prompt', 'merged 213, go ahead with [[#214]]'),
    mention('d301', 11, 'pr', 'PR [[#214]]: Retry uploads (acme/widgets)', { number: 214, url: 'https://github.com/acme/widgets/pull/214' }),
    mention('d302', 12, 'commit', 'Retry uploads ([[#214]])'),
  ],
  sessions: [],
}

const NOTHING = { query: '', total: 0, hits: [], sessions: [] }

/** The engine finds MENTIONS for a search of "#214", nothing for any other. */
function answerMentions(w: World): void {
  w.engine.search = call => ({ json: argOf(call, '--query') === '"#214"' ? MENTIONS : NOTHING })
}

const mountBand = ($: Parameters<typeof band>[0], surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'recall', surface, component: 'AbovePrompt', props: BAND })

test('the last-session band: drawn once the index is checked, on both surfaces; Recap and Dismiss', SLOW, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect((await band($)).text).toBe('')
  await w.clock.settle()
  // Looked for after the index's update, this session left out.
  expect(w.calls.map(call => call.command)).toEqual(['stats', 'update', 'recap'])
  expect(callsOf(w, 'recap')[0]?.args).toEqual(['--project', ROOT, '--exclude-session', SESSION, '--count', '1', '--routines', 'exclude'])
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({ text: LAST, buttons: ['recap', 'dismiss-last'] })
  }

  const ui = await mountBand($, 'desktop')
  await ui.press({ key: 'recap' })
  expect(callsOf(w, 'recap').at(-1)?.args).toEqual(['--session', 's-upload'])
  expect(w.opened).toEqual([{ id: 'recall', focus: true }])
  expect((await pane($)).lines[0]).toBe('The last session in widgets')
  await ui.press({ key: 'dismiss-last' })
  await ui.unmount()
  expect(await band($)).toEqual({ text: '', buttons: [] })
})

test('it stacks above another band, shows beside the related band through the first turn, and goes after it', SLOW, async ($, on) => {
  const w = world(on)
  w.below = 'other'
  answerMentions(w)
  await start($, w)
  for (const surface of SURFACES) {
    expect((await band($, surface)).text).toBe(`${LAST}main ↑1 · 3 changed`)
  }

  await say($, 'is #214 ready to merge?')
  await w.clock.settle()
  for (const surface of SURFACES) {
    const drawn = await band($, surface)
    expect(drawn.text).toBe(`${LAST}${RELATED}main ↑1 · 3 changed`)
    expect(drawn.buttons).toEqual(['recap', 'dismiss-last', 'related-show', 'related-attach', 'related-dismiss'])
  }

  await $.turn.complete(TURN)
  expect((await band($)).text).toBe(`${RELATED}main ↑1 · 3 changed`)
})

test('a second prompt hides the last-session band even before a turn ends', SLOW, async ($, on) => {
  const w = world(on)
  await start($, w)
  await say($, 'first thing')
  expect((await band($)).text).toBe(LAST)
  await say($, 'second thing')
  expect((await band($)).text).toBe('')
})

test('a prompt sent before the band was ready means no band', SLOW, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await say($, 'hello there')
  await w.clock.settle()
  expect(callsOf(w, 'recap')).toEqual([])
  expect((await band($)).text).toBe('')
})

test('no last-session band for a session from months ago', SLOW, async ($, on) => {
  const w = world(on)
  w.engine.recap = () => ({ json: { sessions: [{ ...RECAP_UPLOAD, start: NOW - 91 * DAY, end: NOW - 90 * DAY }] } })
  await start($, w)
  expect((await band($)).text).toBe('')
})

test('no last-session band in a resumed session', SLOW, async ($, on) => {
  const w = world(on)
  w.turns = 4
  await start($, w)
  expect(callsOf(w, 'recap')).toHaveLength(1)
  expect((await band($)).text).toBe('')
})

test('lastSessionBand off: no band, and no recap looked up for one', { ...SLOW, options: { lastSessionBand: false } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(callsOf(w, 'recap')).toEqual([])
  expect((await band($)).text).toBe('')
})

test('a prompt that names #214 brings the related band; Show opens the hits, Attach arms them for the next prompt', SLOW, async ($, on) => {
  const w = world(on)
  w.engine.recap = () => ({ json: { sessions: [] } })
  answerMentions(w)
  await start($, w)

  await say($, 'is #214 ready to merge?')
  // The prompt went in untouched, ahead of the search.
  expect(w.entered.at(-1)).toEqual({ text: 'is #214 ready to merge?', context: undefined })
  expect(callsOf(w, 'search')).toEqual([])
  await w.clock.settle()
  expect(callsOf(w, 'search')).toEqual([
    {
      command: 'search',
      args: [
        '--query',
        '"#214"',
        '--project',
        'all',
        '--boost-project',
        ROOT,
        '--exclude-session',
        SESSION,
        '--kinds',
        'pr,issue,commit,decision,summary,prompt,file',
        '--limit',
        '5',
        '--routines',
        'exclude',
      ],
    },
  ])
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({ text: RELATED, buttons: ['related-show', 'related-attach', 'related-dismiss'] })
  }

  const ui = await mountBand($, 'terminal')
  await ui.press({ key: 'related-show' })
  expect(w.opened).toEqual([{ id: 'recall', focus: true }])
  expect((await pane($)).lines.slice(0, 3)).toEqual([
    '#214 · past sessions that mention #214',
    '2026-09-25 · widgets · Merge the retry PRs',
    'prompt merged 213, go ahead with #214',
  ])
  await ui.press({ key: 'related-attach' })
  await ui.unmount()
  expect(callsOf(w, 'expand').map(call => argOf(call, '--ref'))).toEqual(['d300', 'd301', 'd302'])
  expect(w.toasts).toEqual(['Attached 3 past excerpts to your next message'])

  await say($, 'ok, merge it')
  const context = w.entered.at(-1)?.context ?? []
  expect(context.map(block => /<recalled_excerpt ref="(d\d+)">/.exec(block)?.[1])).toEqual(['d300', 'd301', 'd302'])
  expect(context[1]).toContain('[d301] 2026-09-25 · widgets · pr · Merge the retry PRs — PR **#214**: Retry uploads (acme/widgets)')
  // That prompt took the band away and named nothing new.
  await w.clock.settle()
  expect(await band($)).toEqual({ text: '', buttons: [] })
})

test('Dismiss keeps that term out for the session; faint or unrelated hits draw no band; /clear starts afresh', SLOW, async ($, on) => {
  const w = world(on)
  w.engine.recap = () => ({ json: { sessions: [] } })
  answerMentions(w)
  await start($, w)
  await say($, '#214 status?')
  await w.clock.settle()
  const ui = await mountBand($, 'desktop')
  await ui.press({ key: 'related-dismiss' })
  await ui.unmount()
  expect((await band($)).text).toBe('')

  await say($, 'what about #214 now?')
  await w.clock.settle()
  expect(callsOf(w, 'search')).toHaveLength(1)
  expect((await band($)).text).toBe('')

  // Faint, old mentions: no band.
  w.engine.search = () => ({
    json: { ...MENTIONS, hits: [{ ...mention('d310', 9, 'prompt', 'blocked by [[ABC-77]]'), score: 0.05 }] },
  })
  await say($, 'and ABC-77?')
  await w.clock.settle()
  expect(callsOf(w, 'search').at(-1)?.args.slice(0, 2)).toEqual(['--query', '"ABC-77"'])
  expect((await band($)).text).toBe('')

  // Hits that do not name it: no band.
  w.engine.search = () => ({ json: { ...MENTIONS, total: 1, hits: [mention('d311', 9, 'prompt', 'something else entirely')] } })
  await say($, 'look at `retryUpload`')
  await w.clock.settle()
  expect(callsOf(w, 'search').at(-1)?.args.slice(0, 2)).toEqual(['--query', '"retryUpload"'])
  expect((await band($)).text).toBe('')

  // A prompt the person did not write is not searched.
  answerMentions(w)
  const searched = callsOf(w, 'search').length
  await $.prompt.submit({ text: 'task #555 finished', wait: false, origin: { kind: 'task-notification' } })
  await w.clock.settle()
  expect(callsOf(w, 'search')).toHaveLength(searched)

  // After /clear the dismissed terms are forgotten.
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  await say($, 'is #214 merged?')
  await w.clock.settle()
  expect((await band($)).text).toBe(RELATED)
})

test('relatedBand off: prompts are not searched', { ...SLOW, options: { relatedBand: false } }, async ($, on) => {
  const w = world(on)
  answerMentions(w)
  await start($, w)
  await say($, 'is #214 ready?')
  await w.clock.settle()
  expect(callsOf(w, 'search')).toEqual([])
  expect((await band($)).text).toBe(LAST)
})
