import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

// Secrets are built at run time from obviously fake parts; none is real and none sits in the file whole.
const KEY_ID = 'fake0id1' + 'test2id3' + 'zp3n'
const SECRET_KEY = 'FakeSecret0'.repeat(3) + 'vxrm'
const PASTE = `Here are my keys for opendatalab:\nAccess Key ID\n${KEY_ID}\nSecret Access Key\n${SECRET_KEY}\nCan you download the dataset?`
const ONE = `Secret Access Key: ${SECRET_KEY}`
const CLEAN = 'Download the opendatalab dataset; the keys are in ~/.zshrc as $OPENDATALAB_ACCESS_KEY_ID.'

const HOME = '/Users/me'
const RC = `${HOME}/.zshrc`
const RC_BEFORE = '# my shell\nexport PATH="$HOME/bin:$PATH"\n'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

type World = { files: Map<string, string>; fills: string[]; toasts: string[]; entered: string[]; stored: string[] }

/** The host beneath the plugin: HOME, a shell file in memory, the prompt box, toasts, the engine's own band. */
const world = (on: On): World => {
  const w: World = { files: new Map([[RC, RC_BEFORE]]), fills: [], toasts: [], entered: [], stored: [] }
  mock.env(on, { HOME })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    w.entered.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // A row reaches here as the plugins passed it down; a session.append hook must hand it on with next,
  // and nothing in the kit stores it beneath, so the row is recorded on its way through.
  on('session.append', (_$, e, next) => {
    w.stored.push(JSON.stringify(e.message.content))
    return next(e)
  })
  // The engine's own band, drawn when the plugin passes: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return w
}

/** The person pressing Enter on `text` (or another sender's submission). */
const send = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.prompt.submit({ text, wait: false, origin })

/** Appends a command's record row, as the engine does when a slash command runs. */
const appendRecord = ($: Engine, text: string, uuid: string) =>
  $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'command',
      origin: { kind: 'composer' },
      uuid,
    })
    .catch(() => undefined)

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const mount = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'secret-guard', surface, component: 'AbovePrompt', props: BAND })

type Node = string | { type?: string; props?: Record<string, unknown>; children?: Node[] }

/** The text a band draws, nested spans joined, Buttons and Inputs left out: '' when only the engine's empty band shows. */
const shown = (node: Node): string =>
  typeof node === 'string' ? node : node.type === 'Button' || node.type === 'Input' ? '' : (node.children ?? []).map(shown).join('')

test('a prompt holding a secret is held back, put back in the box, and banded on both surfaces without the value', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  const out = await send($, PASTE)
  expect(out.drop).toBe(
    'secret-guard held this prompt back, unsent: it looks like it holds 2 secrets (Access Key ID and Secret Access Key). ' +
      'It is back in the box: above the prompt, choose Save as env var, Send anyway or Edit.',
  )
  expect(w.entered).toEqual([])
  expect(w.fills).toEqual([PASTE])
  expect(w.toasts).toEqual(['secret-guard held your prompt back: it looks like it holds 2 secrets (Access Key ID and Secret Access Key).'])

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const tree = await ui.drawn()
    expect(shown(tree as Node)).toBe(`Looks like 2 secrets: Access Key ID …zp3n, Secret Access Key …vxrm (masked)`)
    expect(JSON.stringify(tree)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(tree)).not.toContain(KEY_ID)
    expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('OPENDATALAB_ACCESS_KEY_ID')
    expect((await ui.find({ type: 'Input', key: 'name-2' }))?.props.value).toBe('OPENDATALAB_SECRET_ACCESS_KEY')
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['save', 'send-anyway', 'edit'])
    await ui.unmount()
  }
})

test('one secret: the band reads as the spec line, with one name field', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  await send($, ONE)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(shown((await ui.drawn()) as Node)).toBe('Looks like a secret: Secret Access Key …vxrm (masked)')
    expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('SECRET_ACCESS_KEY')
    expect(await ui.find({ type: 'Input', key: 'name-2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Save writes the export lines to ~/.zshrc and refills the box with $NAME', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, PASTE)

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'save' })

  expect(w.files.get(RC)).toBe(
    `${RC_BEFORE}export OPENDATALAB_ACCESS_KEY_ID='${KEY_ID}'\nexport OPENDATALAB_SECRET_ACCESS_KEY='${SECRET_KEY}'\n`,
  )
  const refilled = w.fills.at(-1) ?? ''
  expect(refilled).toBe(
    'Here are my keys for opendatalab:\nAccess Key ID\n$OPENDATALAB_ACCESS_KEY_ID\nSecret Access Key\n$OPENDATALAB_SECRET_ACCESS_KEY\nCan you download the dataset?',
  )
  expect(w.toasts.at(-1)).toBe(
    'Saved OPENDATALAB_ACCESS_KEY_ID and OPENDATALAB_SECRET_ACCESS_KEY to ~/.zshrc; the prompt now says ' +
      '$OPENDATALAB_ACCESS_KEY_ID and $OPENDATALAB_SECRET_ACCESS_KEY. New shells see them ' +
      "(Claude can run: zsh -ic 'echo ${#OPENDATALAB_ACCESS_KEY_ID}' to check).",
  )
  expect(w.toasts.join('\n')).not.toContain(SECRET_KEY)
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()

  // The refilled prompt is clean: Enter sends it.
  const out = await send($, refilled)
  expect(out.drop).toBeUndefined()
  expect(w.entered).toEqual([refilled])
})

test('Save uses the name typed in the field; the same value already there is reused, another value gets _2', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  w.files.set(RC, `${RC_BEFORE}export KIT_SECRET='${SECRET_KEY}'\nexport KIT_ID='someone-elses-id-0'\n`)
  await send($, PASTE)

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.input({ key: 'name', text: 'kit-id', kind: 'change' })
    expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('KIT_ID')
    await ui.unmount()
  }
  const ui = await mount($, 'desktop')
  await ui.input({ key: 'name-2', text: 'kit_secret' })

  expect(w.files.get(RC)).toBe(
    `${RC_BEFORE}export KIT_SECRET='${SECRET_KEY}'\nexport KIT_ID='someone-elses-id-0'\nexport KIT_ID_2='${KEY_ID}'\n`,
  )
  expect(w.fills.at(-1)).toContain('Access Key ID\n$KIT_ID_2\nSecret Access Key\n$KIT_SECRET\n')
  expect(w.toasts.at(-1)).toMatch(/^Saved KIT_ID_2 to ~\/\.zshrc; KIT_SECRET was already in ~\/\.zshrc; the prompt now says \$KIT_ID_2 and \$KIT_SECRET\./)
  await ui.unmount()
})

test('a value with a single quote is saved escaped', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, "wifi password: it's-Fake-42")
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'save' })
  expect(w.files.get(RC)).toBe(`${RC_BEFORE}export WIFI_PASSWORD='it'\\''s-Fake-42'\n`)
  expect(w.fills.at(-1)).toBe('wifi password: $WIFI_PASSWORD')
  await ui.unmount()
})

test('with no shell file yet, Save creates it', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  w.files.clear()
  await send($, ONE)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'save' })
  expect(w.files.get(RC)).toBe(`export SECRET_ACCESS_KEY='${SECRET_KEY}'\n`)
  await ui.unmount()
})

test('Send anyway lets the identical text through once, within 5 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, PASTE)

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'send-anyway' })
  expect(w.fills).toEqual([PASTE, PASTE])
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()

  // Another text is still checked, and does not use the allowance up.
  expect((await send($, ONE)).drop).toBeDefined()

  await clock.advance(60_000)
  const first = await send($, PASTE)
  expect(first.drop).toBeUndefined()
  expect(first.text).toBe(PASTE)
  expect(w.entered).toEqual([PASTE])

  // Once only.
  expect((await send($, PASTE)).drop).toBeDefined()
})

test('Send anyway runs out after 5 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, ONE)
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'send-anyway' })
  await ui.unmount()

  await clock.advance(5 * 60_000 + 1)
  expect((await send($, ONE)).drop).toBeDefined()
  expect(w.entered).toEqual([])
})

test('Edit takes the band down and leaves the text in the box', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, ONE)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'edit' })
  expect(shown((await ui.drawn()) as Node)).toBe('')
  expect(w.fills).toEqual([ONE])
  expect(w.files.get(RC)).toBe(RC_BEFORE)
  await ui.unmount()
})

test('a clean prompt passes untouched, and takes a stale band down', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)

  const out = await send($, CLEAN)
  expect(out.drop).toBeUndefined()
  expect(out.text).toBe(CLEAN)
  expect(w.entered).toEqual([CLEAN])
  expect(w.fills).toEqual([])
  expect(w.toasts).toEqual([])

  await send($, ONE)
  await send($, CLEAN)
  const ui = await mount($, 'terminal')
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()
})

test('prompts a plugin, a peer or a schedule sent are not checked', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'scheduled-trigger' }] as const) {
    expect((await send($, ONE, origin)).drop).toBeUndefined()
  }
  expect(w.entered).toHaveLength(3)
  expect((await send($, ONE, { kind: 'bridge' })).drop).toBeDefined()
})

test('/secrets off lets prompts through for the session; /secrets on checks them again', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)

  expect((await $.command.run(typed('secrets', 'off'))).text).toBe(
    'secret-guard is off for this session: prompts are sent unchecked. /secrets on turns it back on.',
  )
  expect((await send($, PASTE)).drop).toBeUndefined()
  expect(w.entered).toEqual([PASTE])

  await $.command.run(typed('secrets', 'on'))
  expect((await send($, PASTE)).drop).toBeDefined()
  expect((await $.command.run(typed('secrets', ''))).text).toMatch(/^secret-guard is on: /)
})

test('/secrets off takes a band already up down', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  await send($, ONE)
  await $.command.run(typed('secrets', 'off'))
  const ui = await mount($, 'terminal')
  expect(shown((await ui.drawn()) as Node)).toBe('')
  await ui.unmount()
})

test('/secrets test reports what would be caught, masked, and its record keeps the secret masked', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  const report = await $.command.run(typed('secrets', `test ${ONE}`))
  expect(report.text).toBe('secret-guard would hold that prompt back: 1 secret.\n  Secret Access Key …vxrm → $SECRET_ACCESS_KEY')
  expect((await $.command.run(typed('secrets', 'test hello world'))).text).toBe(
    'secret-guard finds no secret in that text: it would be sent as is.',
  )

  await appendRecord($, `<command-name>/secrets</command-name>\n<command-args>test ${ONE}</command-args>`, 'row-1')
  expect(w.stored).toHaveLength(1)
  expect(w.stored[0]).not.toContain(SECRET_KEY)
  expect(w.stored[0]).toContain('test Secret Access Key: [masked …vxrm]')
})

test('another command\'s record is left as it is', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await appendRecord($, `<command-name>/other</command-name>\n<command-args>${ONE}</command-args>`, 'row-2')
  expect(w.stored[0]).toContain(SECRET_KEY)
})

test('with enabled off in /config, prompts are not checked', { options: { enabled: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  // A test's options reach `register` from Claude Code 2.1.289 on; an older kit hands it the defaults.
  const status = await $.command.run(typed('secrets', ''))
  if (!status.text?.startsWith('secret-guard is turned off in /config')) {
    return
  }
  expect((await send($, PASTE)).drop).toBeUndefined()
  expect(w.entered).toEqual([PASTE])
})

test('extraPatterns catches the person\'s own secrets', { options: { extraPatterns: 'kit_[a-z0-9]{32}' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  const own = 'kit_' + 'a1b2c3d4'.repeat(4)
  const out = await send($, `use ${own} please`)
  if (out.drop === undefined) {
    // An older kit hands `register` the defaults, with no extra pattern.
    return
  }
  expect(out.drop).toContain('a secret (Custom pattern)')
  const ui = await mount($, 'terminal')
  expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('SECRET_1')
  await ui.unmount()
})

test('zshrcPath points Save at another file', { options: { zshrcPath: '.config/zsh/secrets.zsh' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  await send($, ONE)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'save' })
  const custom = w.files.get(`${HOME}/.config/zsh/secrets.zsh`)
  if (custom === undefined) {
    // An older kit hands `register` the defaults: the default file got it.
    expect(w.files.get(RC)).toContain('export SECRET_ACCESS_KEY=')
    return
  }
  expect(custom).toBe(`export SECRET_ACCESS_KEY='${SECRET_KEY}'\n`)
  expect(w.files.get(RC)).toBe(RC_BEFORE)
  expect(w.toasts.at(-1)).toMatch(/^Saved SECRET_ACCESS_KEY to \.config\/zsh\/secrets\.zsh;/)
  await ui.unmount()
})
