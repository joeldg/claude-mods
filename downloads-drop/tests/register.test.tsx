import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const HOME = '/Users/me'
const DIR = '/Users/me/Downloads'
const START = 1_700_000_000_000
const POLL = 5_000

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

type Fill = { text: string; mode: string }

type World = {
  /** The folder as `$.fs.list` answers it, by name. */
  files: Map<string, FsEntry>
  fills: Fill[]
  listed: string[]
  invalidations: number
  /** Whether the prompt box takes a fill (false: a dialog holds the keys). */
  isFilled: boolean
  /** The tree the band beneath draws: the engine's empty one, or another plugin's. */
  below: 'empty' | 'other'
}

/** Answers the host beneath the plugin: HOME, the Downloads folder, the prompt box and the band beneath. */
const world = (on: On, dir = DIR): World => {
  const w: World = { files: new Map(), fills: [], listed: [], invalidations: 0, isFilled: true, below: 'empty' }
  mock.env(on, { HOME })
  on('fs.list', (_$, e) => {
    w.listed.push(e.path)
    return e.path === dir ? { value: [...w.files.values()] } : { deny: `ENOENT: no such directory, ${e.path}` }
  })
  on('fs.exists', (_$, e) => ({ value: [...w.files.keys()].some(name => `${dir}/${name}` === e.path) }))
  on('prompt.fill', (_$, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    // A refusal's cause from a hook is stripped on the way up, so a refused fill reads as a plain refusal.
    return { isFilled: w.isFilled }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => {
    w.invalidations += 1
    return { value: undefined }
  })
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

/** A file as the listing reports it. */
const entry = (name: string, mtimeMs: number, size = 48_000): FsEntry => ({ name, kind: 'file', size, mtimeMs, isLink: false })

/** Puts files in the folder, modified now. */
const arrive = (w: World, now: number, ...names: string[]) => {
  for (const name of names) {
    w.files.set(name, entry(name, now))
  }
}

type Node = string | { type?: string; children?: Node[] }

/** The text a band draws, nested spans joined, Buttons left out: '' when only the empty band beneath shows. */
const shown = (node: Node): string =>
  typeof node === 'string' ? node : node.type === 'Button' ? '' : (node.children ?? []).map(shown).join('')

/** The band's text and its Buttons' keys, as drawn on `surface`. */
const band = async ($: any, surface: (typeof SURFACES)[number] = 'terminal', props: object = BAND) => {
  const ui = await $.ui.mount({ plugin: 'downloads-drop', surface, component: 'AbovePrompt', props })
  const text = shown((await ui.drawn()) as Node)
  const buttons = (await ui.findAll({ type: 'Button' })).map((found: { key?: string }) => found.key)
  await ui.unmount()
  return { text, buttons }
}

/** Starts an interactive session at START. */
const start = async ($: any) => {
  await $.session.start({ cwd: '/Users/me/project', surface: 'terminal', isInteractive: true })
}

test('a new file shows after two checks, on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  w.files.set('old-paper.pdf', entry('old-paper.pdf', START - 60_000))
  w.files.set('.DS_Store', entry('.DS_Store', START + 500))
  await start($)

  await clock.advance(1_000)
  arrive(w, clock.now(), 'model-a.3mf', 'notes.docx')
  await clock.advance(1_000)
  arrive(w, clock.now(), 'model-b.3mf')

  // First check: seen, not yet offered (it might still be downloading).
  await clock.advance(POLL - 2_000)
  expect(w.listed).toEqual([DIR])
  expect((await band($)).text).toBe('')

  // Second check: unchanged, so offered.
  await clock.advance(POLL)
  for (const surface of SURFACES) {
    const drawn = await band($, surface)
    expect(drawn.text).toBe('New in Downloads: model-a.3mf, model-b.3mf · just now')
    expect(drawn.buttons).toEqual(['attach', 'dismiss'])
  }

  // The age moves on with the checks.
  const before = w.invalidations
  await clock.advance(2 * 60_000)
  expect(w.invalidations).toBeGreaterThan(before)
  expect((await band($, 'desktop')).text).toBe('New in Downloads: model-a.3mf, model-b.3mf · 2m ago')
})

test('Attach puts quoted @-mentions at the cursor and empties the band, on both surfaces', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)

  for (const surface of SURFACES) {
    w.fills = []
    arrive(w, clock.now() + 1, 'paper.pdf', 'Painted model (v2).3mf')
    await clock.advance(2 * POLL)

    const ui = await $.ui.mount({ plugin: 'downloads-drop', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await ui.drawn()) as Node)).toBe('New in Downloads: Painted model (v2).3mf, paper.pdf · just now')
    await ui.press({ key: 'attach' })
    expect(w.fills).toEqual([
      {
        text: `@"${DIR}/Painted model (v2).3mf" @"${DIR}/paper.pdf" `,
        mode: 'insert',
      },
    ])
    expect(shown((await ui.drawn()) as Node)).toBe('')
    await ui.unmount()

    // Attached files stay away on later checks.
    await clock.advance(3 * POLL)
    expect((await band($, surface)).text).toBe('')
    w.files.clear()
  }
})

test('Dismiss empties the band without filling the prompt; a later file is still offered', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  arrive(w, clock.now() + 1, 'diagram.png')
  await clock.advance(2 * POLL)

  const ui = await $.ui.mount({ plugin: 'downloads-drop', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toBe('New in Downloads: diagram.png · just now')
  await ui.press({ key: 'dismiss' })
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()
  expect(w.fills).toEqual([])

  await clock.advance(3 * POLL)
  expect((await band($)).text).toBe('')

  arrive(w, clock.now(), 'diagram-v2.png')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: diagram-v2.png · just now')
})

test('a growing file waits until two checks see the same size; partials never show', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  arrive(w, clock.now() + 1, 'Unconfirmed 4821.crdownload', 'clip.mp4.part')

  let size = 0
  for (let check = 0; check < 3; check++) {
    size += 10_000_000
    w.files.set('render.mp4', entry('render.mp4', clock.now() + 1, size))
    await clock.advance(POLL)
    expect((await band($)).text).toBe('')
  }

  // Done: the same size and time on the next check.
  await clock.advance(POLL)
  expect((await band($)).text).toBe('New in Downloads: render.mp4 · just now')
})

test('a file that grows again after being offered waits again', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  arrive(w, clock.now() + 1, 'scan.pdf')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: scan.pdf · just now')

  w.files.set('scan.pdf', entry('scan.pdf', clock.now(), 96_000))
  await clock.advance(POLL)
  expect((await band($)).text).toBe('')
  await clock.advance(POLL)
  expect((await band($)).text).toBe('New in Downloads: scan.pdf · just now')
})

test('/downloads lists the 10 newest matching files; attach 1 and attach 1 3 insert them', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  for (let i = 0; i < 12; i++) {
    w.files.set(`paper-${i}.pdf`, entry(`paper-${i}.pdf`, START - (12 - i) * 60 * 60_000, 812_000))
  }
  w.files.set('.DS_Store', entry('.DS_Store', START))
  w.files.set('half.zip.crdownload', entry('half.zip.crdownload', START))
  await start($)
  arrive(w, clock.now() + 1, 'model b.3mf')
  w.files.set('model b.3mf', entry('model b.3mf', clock.now() + 1, 2_400_000))
  await clock.advance(2 * POLL + 3 * 60_000)

  const listing = await $.command.run(typed('downloads', ''))
  const lines = listing.text?.split('\n') ?? []
  expect(lines[0]).toBe('Newest in ~/Downloads (/downloads attach 1 3 puts files in the prompt):')
  expect(lines).toHaveLength(11)
  expect(lines[1]).toBe('   1. model b.3mf · 2.4 MB · 3m ago · new')
  expect(lines[2]).toBe('   2. paper-11.pdf · 812 KB · 1h ago')
  expect(lines[10]).toBe('  10. paper-3.pdf · 812 KB · 9h ago')

  const one = await $.command.run(typed('downloads', 'attach 1'))
  expect(one.text).toBe('Put 1 file in the prompt: model b.3mf')
  expect(w.fills).toEqual([{ text: `@"${DIR}/model b.3mf" `, mode: 'insert' }])
  // Attaching the band's file by number takes it off the band too.
  expect((await band($)).text).toBe('')

  const two = await $.command.run(typed('downloads', 'attach 1 3'))
  expect(two.text).toBe('Put 2 files in the prompt: model b.3mf, paper-10.pdf')
  expect(w.fills.at(-1)).toEqual({ text: `@"${DIR}/model b.3mf" @"${DIR}/paper-10.pdf" `, mode: 'insert' })

  expect((await $.command.run(typed('downloads', 'attach 11'))).text).toBe(
    'There is no file 11; the list has 10.',
  )
  expect(w.fills).toHaveLength(2)
})

test('/downloads attach with no numbers takes the band; a refused fill keeps it', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  expect((await $.command.run(typed('downloads', 'attach'))).text).toBe(
    'Nothing new in ~/Downloads to attach. /downloads lists the newest files by number.',
  )

  arrive(w, clock.now() + 1, 'a.md', 'b.md')
  await clock.advance(2 * POLL)
  w.isFilled = false
  const refused = await $.command.run(typed('downloads', 'attach'))
  expect(refused.text).toBe(`The prompt box did not take the files. Paste these instead:\n@"${DIR}/a.md" @"${DIR}/b.md"`)
  expect((await band($)).text).toBe('New in Downloads: a.md, b.md · just now')

  w.isFilled = true
  expect((await $.command.run(typed('downloads', 'attach'))).text).toBe('Put 2 files in the prompt: a.md, b.md')
  expect((await band($)).text).toBe('')
})

test('/downloads clear dismisses everything so far; a download finishing later still shows', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  arrive(w, clock.now() + 1, 'one.pdf', 'two.pdf')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: one.pdf, two.pdf · just now')

  const cleared = await $.command.run(typed('downloads', 'clear'))
  expect(cleared.text).toBe('Dismissed 2 new files; only files that arrive from now on will be offered.')
  expect((await band($)).text).toBe('')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('')

  arrive(w, clock.now(), 'three.pdf')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: three.pdf · just now')
  expect(w.fills).toEqual([])
})

test('the band shows +N more, yields to a survey and stacks above another band', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await start($)
  arrive(w, clock.now() + 1, 'a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: a.jpg, b.jpg, c.jpg +2 more · just now')
  expect((await band($, 'terminal', { ...BAND, hasSurvey: true })).text).toBe('')

  w.below = 'other'
  for (const surface of SURFACES) {
    expect((await band($, surface)).text).toBe('New in Downloads: a.jpg, b.jpg, c.jpg +2 more · just nowmain ↑1 · 3 changed')
  }
  await $.command.run(typed('downloads', 'clear'))
  expect((await band($)).text).toBe('main ↑1 · 3 changed')
})

test('after a reload (no session.start) drawing the band starts the checks again', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  expect((await band($)).text).toBe('')
  // The first check marks the start; files modified after it count.
  await clock.advance(POLL)
  expect(w.listed).toEqual([DIR])
  arrive(w, clock.now() + 1, 'late.pdf')
  await clock.advance(2 * POLL)
  expect((await band($)).text).toBe('New in Downloads: late.pdf · just now')
})

test('an SDK or -p session watches only once a surface draws the band (the desktop app)', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on)
  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
  arrive(w, clock.now() + 1, 'paper.pdf')
  await clock.advance(4 * POLL)
  expect(w.listed).toEqual([])

  // The desktop attaches and draws the band: the checks start, and the session's start still counts.
  expect((await band($, 'desktop')).text).toBe('')
  await clock.advance(2 * POLL)
  expect(w.listed).toEqual([DIR, DIR])
  expect((await band($, 'desktop')).text).toBe('New in Downloads: paper.pdf · just now')
})

test('/downloads with an unknown word shows the usage', async ($, on) => {
  mock.clock(on, { now: START })
  world(on)
  const out = await $.command.run(typed('downloads', 'frobnicate'))
  expect(out.text?.split('\n')[0]).toBe('Usage:')
})

test(
  'a custom folder, file types and age limit',
  { options: { folder: '~/Desktop/inbox', extensions: 'stl, 3mf', maxAgeMinutes: 1, pollSeconds: 2 } },
  async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, '/Users/me/Desktop/inbox')
    await start($)
    arrive(w, clock.now() + 1, 'bracket.stl', 'paper.pdf')
    await clock.advance(2 * 2_000)
    expect(w.listed).toEqual(['/Users/me/Desktop/inbox', '/Users/me/Desktop/inbox'])
    expect((await band($)).text).toBe('New in inbox: bracket.stl · just now')

    // Past maxAgeMinutes it is no longer new.
    await clock.advance(70_000)
    expect((await band($)).text).toBe('')
  },
)
