import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandItem, BandView, Finding } from '../types'
import { describeFindings, detect, hashText, isBlankTree, mask, testReport, toEnvName, typedName } from './detect'
import { planExports, replaceWithRefs, resolveRcPath, saveToast } from './zshrc'

type Engine = EngineInterface

const band = atom({ plugin: 'secret-guard', key: 'band' } as const, null)
const isOff = atom({ plugin: 'secret-guard', key: 'isOff' } as const, false)

/**
 * Prompts the person sent: Enter at the terminal, Remote Control, and a host app's own box (the desktop
 * app's Code tab submits through the SDK). Plugins', schedules', peers' and notifications' are left alone.
 */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
/** How long Send anyway lets the same text through. */
const ALLOW_MS = 5 * 60_000
/** How many name fields the band draws; secrets past them are saved under their suggested names. */
const SHOWN = 3
/** A `/secrets` command's record in the transcript, which `/secrets test` would otherwise leave a secret in. */
const SECRETS_COMMAND = /(?:^|[\s>])\/secrets(?![\w-])/

const USAGE = [
  'Usage: /secrets test <text>  shows what secret-guard would catch in the text (masked)',
  '       /secrets off | on     turns the check off or back on for this session',
].join('\n')

type Config = { enabled: boolean; extra: RegExp | null; extraError: string | null; zshrcPath: string }

let config: Config = { enabled: true, extra: null, extraError: null, zshrcPath: '~/.zshrc' }

/** The prompt held back last, secrets and all: kept in this module's memory only, never in state or on screen. */
type Held = { id: number; text: string; findings: Finding[] }

let held: Held | null = null
/** The fingerprint of the one text Send anyway lets through, and until when. */
let allowance: { hash: string; until: number } | null = null
let isSaving = false
let lastId = 0

/** The band's rows for a held prompt: labels, masked tails and suggested names; never a value. */
function itemsOf(findings: readonly Finding[]): BandItem[] {
  return findings.map(finding => ({ label: finding.label, masked: mask(finding.value), name: finding.name, suggested: finding.name }))
}

/** `Looks like a secret: Secret Access Key …vxrm (masked)`. */
function headline(items: readonly BandItem[]): string {
  const listed = items.map(item => `${item.label} ${item.masked}`).join(', ')
  return `Looks like ${items.length === 1 ? 'a secret' : `${items.length} secrets`}: ${listed} (masked)`
}

/** The field for the secret at `index`: `name`, then `name-2`, `name-3`. */
function fieldKey(index: number): string {
  return index === 0 ? 'name' : `name-${index + 1}`
}

/** What the person sees where the prompt would have entered: why, and what to do; never a value. */
function dropReason(findings: readonly Finding[], isRefilled: boolean): string {
  const what = describeFindings(findings.map(finding => finding.label))
  const where = isRefilled ? 'It is back in the box: above' : 'Above'
  return `secret-guard held this prompt back, unsent: it looks like it holds ${what}. ${where} the prompt, choose Save as env var, Send anyway or Edit.`
}

/** Holds a prompt back: keeps it here, puts its text back in the box, and raises the band and a toast. */
async function hold($: Engine, text: string, findings: Finding[]): Promise<boolean> {
  lastId += 1
  const id = lastId
  held = { id, text, findings }
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => null)
  const isRefilled = filled?.isFilled === true
  const view: BandView = { id, items: itemsOf(findings), isRefilled }
  await update($, band, () => view)
  $.ui.toast(`secret-guard held your prompt back: it looks like it holds ${describeFindings(findings.map(f => f.label))}.`, {
    timeoutMs: 8_000,
  })
  return isRefilled
}

/** Takes the band down and forgets the held prompt. */
async function dismiss($: Engine) {
  held = null
  await update($, band, () => null)
}

/** The name field changed: kept as typed, uppercased, other characters as `_`. */
async function rename($: Engine, index: number, value: string) {
  await update($, band, view =>
    view ? { ...view, items: view.items.map((item, i) => (i === index ? { ...item, name: typedName(value) } : item)) } : null,
  )
}

/**
 * Save as env var: appends `export NAME='value'` for each secret to the shell file (an existing NAME with
 * the same value is reused, with another value the name gets `_2`), puts the prompt back with `$NAME` in
 * each secret's place, and says so in a toast that names the variables, never their values.
 */
async function save($: Engine) {
  const current = held
  const view = await read($, band)
  if (current === null || view === null || view.id !== current.id || isSaving) {
    return
  }
  isSaving = true
  try {
    const where = config.zshrcPath.trim() || '~/.zshrc'
    const path = resolveRcPath(where, await $.env.get('HOME'))
    if (path === null) {
      $.ui.toast(`secret-guard: HOME is not set, so ${where} could not be found. Nothing was saved.`)
      return
    }
    const exists = await $.fs.exists(path).catch(() => false)
    const before = exists ? await $.fs.read(path).catch(() => null) : ''
    if (typeof before !== 'string') {
      $.ui.toast(`secret-guard could not read ${where}, so nothing was saved; the prompt is still in the box.`)
      return
    }
    const wanted = current.findings.map((finding, index) => toEnvName(view.items[index]?.name ?? '') || finding.name)
    const unique = wanted.map((name, index) => (wanted.indexOf(name) === index ? name : `${name}_${index + 1}`))
    const { text, plans } = planExports(
      before,
      current.findings.map((finding, index) => ({ name: unique[index] ?? finding.name, value: finding.value })),
    )
    if (text !== before) {
      const isWritten = await $.fs.write(path, text).then(
        () => true,
        () => false,
      )
      if (!isWritten) {
        $.ui.toast(`secret-guard could not write ${where}, so nothing was saved; the prompt is still in the box.`)
        return
      }
    }
    const names = plans.map(plan => plan.name)
    await $.prompt.fill({ text: replaceWithRefs(current.text, current.findings, names), mode: 'replace' }).catch(() => null)
    await dismiss($)
    $.ui.toast(saveToast(plans, where), { timeoutMs: 15_000 })
  } finally {
    isSaving = false
  }
}

/** The name field's Enter: keep the name typed, then save. */
async function renameAndSave($: Engine, index: number, value: string) {
  await rename($, index, value)
  await save($)
}

/** Send anyway: the next submission of exactly this text, within five minutes, goes through once. */
async function sendAnyway($: Engine) {
  const current = held
  if (current === null) {
    return
  }
  allowance = { hash: hashText(current.text), until: (await $.clock.now()) + ALLOW_MS }
  await $.prompt.fill({ text: current.text, mode: 'replace' }).catch(() => null)
  await dismiss($)
  $.ui.toast('Press Enter to send it as is: secret-guard lets this exact text through once, within 5 minutes.')
}

/** Whether this text is the one Send anyway allowed, still in time; the allowance is used up either way it matches. */
async function isAllowed($: Engine, text: string): Promise<boolean> {
  if (allowance === null) {
    return false
  }
  if ((await $.clock.now()) > allowance.until) {
    allowance = null
    return false
  }
  if (allowance.hash !== hashText(text)) {
    return false
  }
  allowance = null
  return true
}

/** The text with each secret detected in it shown masked: `[masked …vxrm]`. */
function masked(text: string): string {
  const findings = detect(text, { extra: config.extra })
  let out = text
  for (const finding of [...findings].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, finding.start)}[masked ${mask(finding.value)}]${out.slice(finding.end)}`
  }
  return out
}

/** What `/secrets` alone answers. */
async function status($: Engine): Promise<string> {
  const off = await read($, isOff)
  const state = !config.enabled
    ? 'secret-guard is turned off in /config (Check prompts for secrets).'
    : off
      ? 'secret-guard is off for this session: prompts are sent unchecked.'
      : 'secret-guard is on: prompts that look like they hold a secret are held back.'
  const extra = config.extraError ? `\nThe "Also a secret" pattern is not a valid regex and is ignored: ${config.extraError}` : ''
  return `${state}${extra}\n${USAGE}`
}

/** What a /secrets record shows when it could not be masked. */
const WITHHELD = '/secrets … (withheld: secret-guard could not mask this record)'

export const register: Register = (on, options) => {
  let extra: RegExp | null = null
  let extraError: string | null = null
  const source = String(options.extraPatterns ?? '').trim()
  if (source !== '') {
    try {
      extra = new RegExp(source, 'g')
    } catch (error) {
      extraError = error instanceof Error ? error.message : String(error)
    }
  }
  config = {
    enabled: options.enabled !== false,
    extra,
    extraError,
    zshrcPath: String(options.zshrcPath ?? '~/.zshrc'),
  }
  held = null
  allowance = null
  isSaving = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'secrets',
      description: 'Show what secret-guard would catch in a text, or turn it off or on for this session',
      argumentHint: 'test <text> | off | on',
      immediate: true,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!config.enabled || !PERSONAL.has(e.origin.kind) || (await read($, isOff))) {
      return next(e)
    }
    if (await isAllowed($, e.text)) {
      await dismiss($)
      return next(e)
    }
    const findings = detect(e.text, { extra: config.extra })
    if (findings.length === 0) {
      if (held !== null) {
        await dismiss($)
      }
      return next(e)
    }
    const isRefilled = await hold($, e.text, findings)
    return { drop: dropReason(findings, isRefilled) }
  })

  // `/secrets test <text>` would leave the text in the command's record: the record keeps it masked.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    let isChanged = false
    const isSecretsText = (block: (typeof e.message.content)[number]) =>
      block.type === 'text' && typeof block.text === 'string' && SECRETS_COMMAND.test(block.text)
    let content: typeof e.message.content
    try {
      content = e.message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string' || !SECRETS_COMMAND.test(block.text)) {
          return block
        }
        const text = masked(block.text)
        isChanged ||= text !== block.text
        return { ...block, text }
      })
    } catch (error) {
      // Fail closed: a record that could not be masked keeps no text, rather than the secret it may hold.
      const message = error instanceof Error ? error.message : String(error)
      $.ui.log(`secret-guard: masking a /secrets record failed, so its text was withheld: ${message.slice(0, 200)}`, { to: 'debug' })
      content = e.message.content.map(block => (isSecretsText(block) && block.type === 'text' ? { ...block, text: WITHHELD } : block))
      isChanged = true
    }
    return next(isChanged ? { ...e, message: { ...e.message, content } } : e)
  })

  on('command.run', { command: 'secrets' }, async ($, e) => {
    const args = e.args.trim()
    const verb = (/^\S*/.exec(args)?.[0] ?? '').toLowerCase()
    if (verb === 'test') {
      const text = args.slice(verb.length).trim()
      return { text: text === '' ? USAGE : testReport(detect(text, { extra: config.extra })) }
    }
    if (verb === 'off') {
      await update($, isOff, () => true)
      await dismiss($)
      return { text: 'secret-guard is off for this session: prompts are sent unchecked. /secrets on turns it back on.' }
    }
    if (verb === 'on') {
      await update($, isOff, () => false)
      return {
        text: config.enabled
          ? 'secret-guard is on: prompts that look like they hold a secret are held back.'
          : 'secret-guard is turned off in /config (Check prompts for secrets); turn it on there.',
      }
    }
    return { text: await status($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, band)
    if (e.props.hasSurvey || view === null || held?.id !== view.id || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const fields = view.items.slice(0, SHOWN)
    const rest = view.items.length - fields.length

    const guard = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{headline(view.items)}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key="save" label="Save as env var" variant="primary" onPress={() => save($)} />
            <Button key="send-anyway" label="Send anyway" onPress={() => sendAnyway($)} />
            <Button key="edit" label="Edit" onPress={() => dismiss($)} />
          </Box>
        </Box>
        {fields.map((item, index) => (
          <Input
            key={fieldKey(index)}
            label={view.items.length === 1 ? 'Env var name: $' : `${item.label} as $`}
            value={item.name}
            placeholder={item.suggested}
            submitLabel="save"
            onInput={value => rename($, index, value)}
            onSubmit={value => renameAndSave($, index, value)}
          />
        ))}
        {rest > 0 ? <Text dimColor>{`+${rest} more, saved under their suggested names`}</Text> : null}
      </Box>
    )
    // Another plugin's band beneath stays, under this one.
    const below = await next(e)
    return isBlankTree(below) ? (
      guard
    ) : (
      <Box flexDirection="column">
        {guard}
        {below}
      </Box>
    )
  })
}
