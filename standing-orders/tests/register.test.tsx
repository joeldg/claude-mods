import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/me'
const ROOT = '/Users/me/project'
const FILE = '/Users/me/.claude/standing-orders/-Users-me-project.json'
const BAMBU = 'never open bambu with full spectrum files'
const LEAD = 'Standing orders (kept by the standing-orders mod; follow them unless the user says otherwise):'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

type Entered = { text: string; context: readonly string[] | undefined }

type World = {
  files: Map<string, string>
  writes: string[]
  toasts: string[]
  entered: Entered[]
  goals: string[]
  ran: string[]
}

type Place = { cwd?: string; toplevel?: string | null }

/** Answers the host beneath the plugin: HOME, the folder and git, a file system in memory, toasts, the prompt. */
const world = (on: On, place: Place = {}): World => {
  const w: World = { files: new Map(), writes: [], toasts: [], entered: [], goals: [], ran: [] }
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: place.cwd ?? ROOT }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    w.ran.push(argv)
    const top = place.toplevel === undefined ? ROOT : place.toplevel
    const isRepo = argv === 'git rev-parse --show-toplevel' && top !== null
    return {
      value: {
        exitCode: isRepo ? 0 : 128,
        stdout: isRepo ? `${top}\n` : '',
        stderr: isRepo ? '' : 'fatal: not a git repository (or any of the parent directories): .git\n',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    w.entered.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  // The built-in /goal, standing beneath the plugin.
  on('command.run', { command: 'goal' }, (_$, e) => {
    w.goals.push(e.args)
    return { text: e.args ? `Goal set: ${e.args}` : 'No goal set.' }
  })
  // The engine's own band, drawn when the plugin passes: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return w
}

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const orders = async ($: Engine, args = ''): Promise<string> => (await $.command.run(typed('orders', args))).text ?? ''

const firstContext = { blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-07." }] }

/** The standing-orders block of a freshly read context, or undefined when there is none. */
const block = async ($: Engine): Promise<string | undefined> =>
  (await $.prompt.context(firstContext)).blocks.find(one => one.name === 'standingOrders')?.text

type Node = string | { type?: string; children?: Node[] }

/** The text a band draws, nested spans joined, Buttons left out: '' when only the engine's empty band shows. */
const shown = (node: Node): string =>
  typeof node === 'string' ? node : node.type === 'Button' ? '' : (node.children ?? []).map(shown).join('')

const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'standing-orders', surface, component: 'AbovePrompt', props: BAND })

const bandText = async ($: Engine): Promise<string> => {
  const ui = await mountBand($)
  const text = shown((await ui.drawn()) as Node)
  await ui.unmount()
  return text
}

/** Presses one of the band's buttons on the terminal. */
const pressBand = async ($: Engine, key: 'keep-project' | 'keep-session' | 'dismiss') => {
  const ui = await mountBand($)
  await ui.press({ key })
  await ui.unmount()
}

const projectFile = (w: World): unknown => JSON.parse(w.files.get(FILE) ?? 'null')

test('a directive in a prompt shows the band, and the prompt passes through untouched', async ($, on) => {
  const w = world(on)
  const entered = await say($, `Thanks, the slice looks right. ${BAMBU}.`)
  expect(entered.text).toBe(`Thanks, the slice looks right. ${BAMBU}.`)
  expect(w.entered).toEqual([{ text: `Thanks, the slice looks right. ${BAMBU}.`, context: undefined }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    expect(shown((await ui.drawn()) as Node)).toBe(`Keep as a standing order? "${BAMBU}"`)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(button => button.key)).toEqual(['keep-project', 'keep-session', 'dismiss'])
    expect(buttons.map(button => button.props.label)).toEqual(['Project', 'This session', 'No'])
    expect((await ui.find({ type: 'Text', text: /^Keep as a standing order/ }))?.props.wrap).toBe('truncate-end')
    await ui.unmount()
  }
  expect(w.writes).toEqual([])
})

test('Project saves the order to the project file, toasts, and the next context carries it', async ($, on) => {
  const w = world(on)
  await say($, BAMBU)
  await pressBand($, 'keep-project')

  expect(w.writes).toEqual([FILE])
  expect(projectFile(w)).toEqual({ root: ROOT, orders: [{ text: BAMBU, addedAt: 1_000 }] })
  expect(w.toasts).toEqual([`Standing order kept for this project: ${BAMBU}`])
  expect(await bandText($)).toBe('')

  expect(await block($)).toBe(`${LEAD}\nFor this project:\n- ${BAMBU}`)
  const blocks = (await $.prompt.context(firstContext)).blocks.map(one => one.name)
  expect(blocks).toEqual(['currentDate', 'standingOrders'])
})

test('This session keeps the order out of the file', async ($, on) => {
  const w = world(on)
  await say($, 'for this job, use PETG at 0.2mm layers')
  // Pressed on the desktop this time: the band works the same on either surface.
  const ui = await mountBand($, 'desktop')
  await ui.press({ key: 'keep-session' })
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()

  expect(w.writes).toEqual([])
  expect(w.toasts).toEqual(['Standing order kept for this session: for this job, use PETG at 0.2mm layers'])
  expect(await block($)).toBe(`${LEAD}\nFor this session:\n- for this job, use PETG at 0.2mm layers`)
})

test('No dismisses the band, keeps nothing, and the same directive is not offered again', async ($, on) => {
  const w = world(on)
  await say($, BAMBU)
  await pressBand($, 'dismiss')

  expect(await bandText($)).toBe('')
  expect(w.writes).toEqual([])
  expect(w.toasts).toEqual([])
  expect(await block($)).toBeUndefined()

  await say($, `${BAMBU}!`)
  expect(await bandText($)).toBe('')
  await say($, 'from now on, run the linter before committing')
  expect(await bandText($)).toBe('Keep as a standing order? "from now on, run the linter before committing"')
})

test('/goal is passed on untouched and its argument is the Active goal; /goal clear clears it', async ($, on) => {
  const w = world(on)
  const ran = await $.command.run(typed('goal', 'all tests in test/auth pass (bun test exits 0)'))
  expect(ran.text).toBe('Goal set: all tests in test/auth pass (bun test exits 0)')
  expect(w.goals).toEqual(['all tests in test/auth pass (bun test exits 0)'])
  expect(await block($)).toBe(`${LEAD}\nActive goal: all tests in test/auth pass (bun test exits 0)`)

  await $.command.run(typed('goal', ''))
  expect(await block($)).toBe(`${LEAD}\nActive goal: all tests in test/auth pass (bun test exits 0)`)
  expect(await orders($)).toContain('Active goal: all tests in test/auth pass (bun test exits 0)')

  await $.command.run(typed('goal', 'clear'))
  expect(w.goals).toEqual(['all tests in test/auth pass (bun test exits 0)', '', 'clear'])
  expect(await block($)).toBeUndefined()
})

test('an order kept mid-conversation rides along with the next prompt once', async ($, on) => {
  const w = world(on)
  expect(await block($)).toBeUndefined()

  await say($, BAMBU)
  await pressBand($, 'keep-project')
  await say($, 'now slice the tiger at 0.12mm')
  await say($, 'and export the gcode')

  expect(w.entered.map(one => one.context)).toEqual([
    undefined,
    [
      `A standing order was just added (kept by the standing-orders mod; follow it unless the user says otherwise):\n- ${BAMBU} (for this project)`,
    ],
    undefined,
  ])
  expect(w.entered.map(one => one.text)).toEqual([BAMBU, 'now slice the tiger at 0.12mm', 'and export the gcode'])
})

test('a context read after an order was kept carries it, so the next prompt does not repeat it', async ($, on) => {
  const w = world(on)
  await orders($, 'add session use the staging database')
  // A compaction re-reads the context: the order is in it from here on.
  expect(await block($)).toBe(`${LEAD}\nFor this session:\n- use the staging database`)
  await say($, 'run the migration')
  expect(w.entered.map(one => one.context)).toEqual([undefined])
})

test('several kept orders ride along together, and a forgotten one is dropped from the note', async ($, on) => {
  const w = world(on)
  await orders($, 'add never push to main')
  await orders($, 'add session use the staging database')
  await orders($, 'add project use pnpm')
  await orders($, 'forget 2')
  await say($, 'go ahead')
  expect(w.entered[0]?.context).toEqual([
    [
      'Standing orders were just added (kept by the standing-orders mod; follow them unless the user says otherwise):',
      '- never push to main (for this project)',
      '- use the staging database (for this session)',
    ].join('\n'),
  ])
})

test('/orders adds, lists numbered, forgets and exports', async ($, on) => {
  const w = world(on)
  expect(await orders($, 'add never push to main')).toBe('Standing order kept for this project: never push to main')
  expect(await orders($, 'add session use the staging database')).toBe(
    'Standing order kept for this session: use the staging database',
  )
  expect(await orders($, 'add project Never push to main.')).toBe('Already a standing order for this project: Never push to main')
  expect(await orders($, 'add project use pnpm, not npm')).toBe('Standing order kept for this project: use pnpm, not npm')
  expect(w.toasts).toEqual([])

  expect((await orders($)).split('\n')).toEqual([
    `Standing orders for ${ROOT}:`,
    'This project (~/.claude/standing-orders/-Users-me-project.json):',
    '  1. never push to main',
    '  2. use pnpm, not npm',
    'This session:',
    '  3. use the staging database',
  ])

  expect(await orders($, 'export')).toBe(
    [
      'Paste this into CLAUDE.md:',
      '',
      '```markdown',
      '## Standing orders',
      '',
      '- never push to main',
      '- use pnpm, not npm',
      '- use the staging database',
      '```',
    ].join('\n'),
  )

  expect(await orders($, 'forget 1')).toBe('Forgot standing order 1 (this project), it no longer applies: never push to main')
  expect(projectFile(w)).toEqual({ root: ROOT, orders: [{ text: 'use pnpm, not npm', addedAt: 1_000 }] })
  expect(await orders($, 'forget 2')).toBe(
    'Forgot standing order 2 (this session), it no longer applies: use the staging database',
  )
  expect(await orders($, 'forget 5')).toBe('standing-orders: there is no order 5; /orders lists them.')
  expect(await block($)).toBe(`${LEAD}\nFor this project:\n- use pnpm, not npm`)
  expect(await orders($, 'dance')).toMatch(/^Usage:/)
})

test('/orders clear drops one scope and leaves the other', async ($, on) => {
  const w = world(on)
  await orders($, 'add never push to main')
  await orders($, 'add session use the staging database')
  await orders($, 'add session keep answers short')

  expect(await orders($, 'clear session')).toBe('Cleared 2 standing orders for this session; they no longer apply.')
  expect(await block($)).toBe(`${LEAD}\nFor this project:\n- never push to main`)
  expect(await orders($, 'clear session')).toBe('No standing orders for this session to clear.')

  expect(await orders($, 'clear project')).toBe('Cleared 1 standing order for this project; they no longer apply.')
  expect(projectFile(w)).toEqual({ root: ROOT, orders: [] })
  expect(await block($)).toBeUndefined()
})

test('with nothing kept there is no block and /orders says how to add one', async ($, on) => {
  const w = world(on)
  const out = await $.prompt.context(firstContext)
  expect(out.blocks.map(one => one.name)).toEqual(['currentDate'])
  expect(await orders($)).toMatch(/^No standing orders for \/Users\/me\/project\. /)
  expect(await orders($, 'export')).toBe('No standing orders to export.')
  expect(w.writes).toEqual([])
})

test("a subfolder of the repo shares the repo's orders, git asked once per folder", async ($, on) => {
  const w = world(on, { cwd: `${ROOT}/src/slicer` })
  await orders($, 'add never push to main')
  expect(w.writes).toEqual([FILE])
  expect(await orders($)).toContain(`Standing orders for ${ROOT}:`)
  expect(await block($)).toBe(`${LEAD}\nFor this project:\n- never push to main`)
  expect(w.ran).toEqual(['git rev-parse --show-toplevel'])
})

test('outside a git repository the orders are keyed by the folder', async ($, on) => {
  const w = world(on, { cwd: `${HOME}/Downloads/prints`, toplevel: null })
  await orders($, 'add never delete the originals')
  expect(w.writes).toEqual([`${HOME}/.claude/standing-orders/-Users-me-Downloads-prints.json`])
  expect(await orders($)).toContain(`Standing orders for ${HOME}/Downloads/prints:`)
})

test('orders already kept, and prompts from elsewhere, are not offered', async ($, on) => {
  const w = world(on)
  w.files.set(FILE, JSON.stringify({ root: ROOT, orders: [{ text: BAMBU, addedAt: 5 }] }))
  await say($, `${BAMBU}.`)
  expect(await bandText($)).toBe('')

  await $.prompt.submit({ text: 'never retry the flaky upload step', wait: false, origin: { kind: 'task-notification' } })
  expect(await bandText($)).toBe('')

  await say($, '/orders add never retry the flaky upload step')
  expect(await bandText($)).toBe('')

  await say($, "don't worry about the CPU, it's fine")
  expect(await bandText($)).toBe('')
})

test('the newest directive replaces the one offered, and an unanswered band goes after three more prompts', async ($, on) => {
  world(on)
  await say($, BAMBU)
  await say($, 'remember to bump the version in package.json')
  expect(await bandText($)).toBe('Keep as a standing order? "remember to bump the version in package.json"')

  await say($, 'slice the tiger')
  await say($, 'and the cube')
  expect(await bandText($)).toBe('Keep as a standing order? "remember to bump the version in package.json"')
  await say($, 'and the coupon')
  expect(await bandText($)).toBe('')
})

test('a project file this mod cannot read is reported and left as it is', async ($, on) => {
  const w = world(on)
  w.files.set(FILE, '{ "rules": oops')
  expect(await orders($, 'add never push to main')).toBe(
    'standing-orders: ~/.claude/standing-orders/-Users-me-project.json is not a file of orders this mod can read; fix or remove it first (it was left as it is).',
  )
  expect(w.writes).toEqual([])
  expect(w.files.get(FILE)).toBe('{ "rules": oops')
  expect(await orders($)).toContain('could not be read as orders; it was left as it is.')

  await say($, BAMBU)
  await pressBand($, 'keep-project')
  expect(w.toasts).toEqual([
    'standing-orders: ~/.claude/standing-orders/-Users-me-project.json is not a file of orders this mod can read; fix or remove it first (it was left as it is).',
  ])
  expect(w.writes).toEqual([])
})

test('maxOrders caps each scope', { options: { maxOrders: 2 } }, async ($, on) => {
  world(on)
  await orders($, 'add session use the staging database')
  await orders($, 'add session keep answers short')
  expect(await orders($, 'add session never print secrets')).toBe(
    'standing-orders: this session already has 2 orders (maxOrders); /orders forget one first.',
  )
  expect(await orders($, 'add never push to main')).toBe('Standing order kept for this project: never push to main')
})

test('with capture off no band is offered', { options: { capture: false } }, async ($, on) => {
  const w = world(on)
  await say($, BAMBU)
  expect(await bandText($)).toBe('')
  // Orders added by hand still reach Claude.
  await orders($, 'add never push to main')
  expect(await block($)).toBe(`${LEAD}\nFor this project:\n- never push to main`)
  expect(w.entered.map(one => one.context)).toEqual([undefined])
})

test('with deliver off Claude is handed nothing', { options: { deliver: false } }, async ($, on) => {
  const w = world(on)
  await say($, BAMBU)
  await pressBand($, 'keep-project')
  expect(w.writes).toEqual([FILE])
  await say($, 'next')
  expect(w.entered.map(one => one.context)).toEqual([undefined, undefined])
  expect(await block($)).toBeUndefined()
})
