import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Candidate, Order, Scope, Unsent } from '../types'
import {
  USAGE,
  blockText,
  exportMarkdown,
  findDirective,
  goalChange,
  hasOrder,
  isBlankTree,
  listText,
  normalizeOrder,
  ordersPath,
  parseOrdersCommand,
  parseProjectFile,
  sameOrder,
  serializeProjectFile,
  tildePath,
  unsentText,
} from './orders'

type Engine = EngineInterface

/** The name the orders render under in the conversation's context. */
const BLOCK = 'standingOrders'

const candidate = atom({ plugin: 'standing-orders', key: 'candidate' } as const, null)
const sessionOrders = atom({ plugin: 'standing-orders', key: 'sessionOrders' } as const, [])
const goal = atom({ plugin: 'standing-orders', key: 'goal' } as const, null)
const unsent = atom({ plugin: 'standing-orders', key: 'unsent' } as const, [])
const dismissed = atom({ plugin: 'standing-orders', key: 'dismissed' } as const, [])

/** Prompts the person wrote: the only ones whose directives are offered, and the ones new orders ride along with. */
const PERSONAL = new Set(['composer', 'bridge', 'sdk'])
/** How many later prompts an unanswered band stays up for. */
const CANDIDATE_PROMPTS = 3
/** How many directives answered No are remembered, so they are not offered again. */
const MAX_DISMISSED = 50
const GIT_MS = 3_000

type Config = { capture: boolean; deliver: boolean; maxOrders: number }

let config: Config = { capture: true, deliver: true, maxOrders: 30 }
/** The folder git was last asked about, and the project root it answered. */
let rootCache: { cwd: string; root: string } | null = null

function debug($: Engine, line: string) {
  $.ui.log(`standing-orders: ${line}`, { to: 'debug' })
}

/** The git work tree's top folder, or the session's folder outside one. */
async function projectRoot($: Engine): Promise<string> {
  const cwd = await $.session.cwd()
  if (rootCache?.cwd === cwd) {
    return rootCache.root
  }
  const out = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: GIT_MS }).catch(() => null)
  const top = out?.exitCode === 0 ? out.stdout.trim() : ''
  rootCache = { cwd, root: top || cwd }
  return rootCache.root
}

type Project = {
  root: string
  /** The orders file; null when no home folder is known. */
  path: string | null
  home: string | undefined
  orders: Order[]
  /** True when the file is there but holds nothing this mod can read: it is then never overwritten. */
  isBroken: boolean
}

/** This project's orders, read from `~/.claude/standing-orders/<key>.json` (none while it does not exist). */
async function loadProject($: Engine): Promise<Project> {
  const root = await projectRoot($)
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const path = home ? ordersPath(home, root) : null
  if (path === null) {
    return { root, path, home, orders: [], isBroken: false }
  }
  const text = await $.fs.read(path).catch(() => null)
  const orders = text === null ? [] : parseProjectFile(text)
  return { root, path, home, orders: orders ?? [], isBroken: orders === null }
}

/** Why project orders cannot be changed right now, or null when they can. */
function projectBlocker(project: Project): string | null {
  if (project.path === null) {
    return 'standing-orders: HOME is not set, so there is nowhere to keep project orders.'
  }
  return project.isBroken
    ? `standing-orders: ${tildePath(project.path, project.home)} is not a file of orders this mod can read; fix or remove it first (it was left as it is).`
    : null
}

/** Writes the project's orders back; the error in words when the write failed. */
async function saveProject($: Engine, project: Project, orders: readonly Order[]): Promise<string | null> {
  if (project.path === null) {
    return 'standing-orders: HOME is not set, so there is nowhere to keep project orders.'
  }
  try {
    await $.fs.write(project.path, serializeProjectFile(project.root, orders))
    return null
  } catch (error) {
    return `standing-orders: could not write ${tildePath(project.path, project.home)}: ${String(error)}`
  }
}

const scopeWords = (scope: Scope): string => (scope === 'project' ? 'this project' : 'this session')

type Kept = { isKept: boolean; text: string }

/** Keeps `raw` as a standing order of `scope`, and queues it for the next prompt; says what happened. */
async function keep($: Engine, scope: Scope, raw: string): Promise<Kept> {
  const text = normalizeOrder(raw)
  const now = await $.clock.now()
  const full = `standing-orders: ${scopeWords(scope)} already has ${config.maxOrders} orders (maxOrders); /orders forget one first.`
  if (scope === 'project') {
    const project = await loadProject($)
    const blocker = projectBlocker(project)
    if (blocker) {
      return { isKept: false, text: blocker }
    }
    if (hasOrder(project.orders, text)) {
      return { isKept: false, text: `Already a standing order for this project: ${text}` }
    }
    if (project.orders.length >= config.maxOrders) {
      return { isKept: false, text: full }
    }
    const failed = await saveProject($, project, [...project.orders, { text, addedAt: now }])
    if (failed) {
      return { isKept: false, text: failed }
    }
  } else {
    const list = await read($, sessionOrders)
    if (hasOrder(list, text)) {
      return { isKept: false, text: `Already a standing order for this session: ${text}` }
    }
    if (list.length >= config.maxOrders) {
      return { isKept: false, text: full }
    }
    await update($, sessionOrders, current => [...(current ?? []), { text, addedAt: now }])
  }
  if (config.deliver) {
    await update($, unsent, current => [...(current ?? []).filter(one => !sameOrder(one.text, text)), { text, scope }])
  }
  return { isKept: true, text: `Standing order kept for ${scopeWords(scope)}: ${text}` }
}

/** Drops orders no longer in force from the queue for the next prompt. */
async function unqueue($: Engine, isGone: (order: Unsent) => boolean) {
  await update($, unsent, current => (current ?? []).filter(order => !isGone(order)))
}

/** Whether a directive is worth offering: not answered No this session, and not already kept. */
async function isNew($: Engine, text: string): Promise<boolean> {
  if ((await read($, dismissed)).includes(text.toLowerCase())) {
    return false
  }
  if (hasOrder(await read($, sessionOrders), text)) {
    return false
  }
  return !hasOrder((await loadProject($)).orders, text)
}

/** Offers the prompt's directive in the band (the newest replaces any other); an unanswered one ages out. */
async function offer($: Engine, prompt: string) {
  const found = findDirective(prompt)
  if (found !== null && (await isNew($, found))) {
    await update($, candidate, () => ({ text: found, promptsSince: 0 }))
    return
  }
  if ((await read($, candidate)) === null) {
    return
  }
  await update($, candidate, current =>
    !current || current.promptsSince + 1 >= CANDIDATE_PROMPTS ? null : { ...current, promptsSince: current.promptsSince + 1 },
  )
}

/** The band's answer: keep the offered directive for the project or the session, or let it go. */
async function answer($: Engine, choice: Scope | 'dismiss') {
  let taken: Candidate | null = null
  await update($, candidate, current => {
    taken = current ?? null
    return null
  })
  const offered = taken as Candidate | null
  if (offered === null) {
    return
  }
  if (choice === 'dismiss') {
    const key = offered.text.toLowerCase()
    await update($, dismissed, current => [...(current ?? []).filter(one => one !== key), key].slice(-MAX_DISMISSED))
    return
  }
  const kept = await keep($, choice, offered.text)
  $.ui.toast(kept.text)
}

/** `/orders forget <n>`: project orders are numbered first, then session orders. */
async function forget($: Engine, number: number): Promise<string> {
  const project = await loadProject($)
  if (number <= project.orders.length) {
    const gone = project.orders[number - 1]
    const blocker = projectBlocker(project)
    if (!gone || blocker) {
      return blocker ?? USAGE
    }
    const failed = await saveProject($, project, project.orders.filter((_, i) => i !== number - 1))
    if (failed) {
      return failed
    }
    await unqueue($, order => order.scope === 'project' && sameOrder(order.text, gone.text))
    return `Forgot standing order ${number} (this project), it no longer applies: ${gone.text}`
  }
  const session = await read($, sessionOrders)
  const gone = session[number - project.orders.length - 1]
  if (!gone) {
    return `standing-orders: there is no order ${number}; /orders lists them.`
  }
  await update($, sessionOrders, current => (current ?? []).filter(order => !sameOrder(order.text, gone.text)))
  await unqueue($, order => order.scope === 'session' && sameOrder(order.text, gone.text))
  return `Forgot standing order ${number} (this session), it no longer applies: ${gone.text}`
}

/** `/orders clear session|project`. */
async function clear($: Engine, scope: Scope): Promise<string> {
  let count = 0
  if (scope === 'project') {
    const project = await loadProject($)
    const blocker = projectBlocker(project)
    if (blocker) {
      return blocker
    }
    count = project.orders.length
    const failed = count > 0 ? await saveProject($, project, []) : null
    if (failed) {
      return failed
    }
  } else {
    count = (await read($, sessionOrders)).length
    await update($, sessionOrders, () => [])
  }
  await unqueue($, order => order.scope === scope)
  return count === 0
    ? `No standing orders for ${scopeWords(scope)} to clear.`
    : `Cleared ${count} standing order${count === 1 ? '' : 's'} for ${scopeWords(scope)}; they no longer apply.`
}

/** What `/orders <args>` prints. */
async function runOrders($: Engine, args: string): Promise<string> {
  const command = parseOrdersCommand(args)
  switch (command.verb) {
    case 'add':
      return (await keep($, command.scope, command.text)).text
    case 'forget':
      return forget($, command.number)
    case 'clear':
      return clear($, command.scope)
    case 'export': {
      const project = await loadProject($)
      const markdown = exportMarkdown([...project.orders, ...(await read($, sessionOrders))])
      return markdown ? `Paste this into CLAUDE.md:\n\n${markdown}` : 'No standing orders to export.'
    }
    case 'list': {
      const project = await loadProject($)
      const file = project.path === null ? null : tildePath(project.path, project.home)
      const text = listText({
        root: project.root,
        file,
        project: project.orders,
        session: await read($, sessionOrders),
        goal: await read($, goal),
      })
      return project.isBroken ? `${text}\n(${file} could not be read as orders; it was left as it is.)` : text
    }
    default:
      return USAGE
  }
}

export const register: Register = (on, options) => {
  const max = Number(options.maxOrders ?? 30)
  config = {
    capture: options.capture !== false,
    deliver: options.deliver !== false,
    maxOrders: Number.isFinite(max) ? Math.max(1, Math.min(200, Math.round(max))) : 30,
  }
  rootCache = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orders',
      description: 'Standing orders Claude keeps through compaction: list, add, forget, clear, export',
      argumentHint: '[add [project|session] <text> | forget <n> | clear session|project | export]',
      immediate: true,
    })
    return next(e)
  })

  // Spots a lasting instruction in the person's prompt and offers it in the band; the prompt passes untouched,
  // save for orders kept since the last one, which ride along once so Claude learns them before any compaction.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSONAL.has(e.origin.kind)) {
      return next(e)
    }
    let waiting: Unsent[] = []
    try {
      if (config.deliver && (await read($, unsent)).length > 0) {
        await update($, unsent, current => {
          waiting = current ?? []
          return []
        })
      }
      if (config.capture) {
        await offer($, e.text)
      }
    } catch (error) {
      debug($, `could not read the prompt for orders: ${String(error)}`)
    }
    if (waiting.length === 0) {
      return next(e)
    }
    const entered = await next({ ...e, context: [...(e.context ?? []), unsentText(waiting)] })
    if (entered.drop !== undefined) {
      // The prompt never entered, so neither did the note: it waits for the next one.
      const again = waiting
      await update($, unsent, current => [...again, ...(current ?? [])])
    }
    return entered
  })

  // Read once per conversation and again after a compaction or /clear: exactly when the orders are needed.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!config.deliver) {
      return result
    }
    try {
      const project = await loadProject($)
      const text = blockText(project.orders, await read($, sessionOrders), await read($, goal))
      await update($, unsent, () => [])
      const others = result.blocks.filter(block => block.name !== BLOCK)
      return { ...result, blocks: text === null ? others : [...others, { name: BLOCK, text }] }
    } catch (error) {
      debug($, `could not add the orders to the context: ${String(error)}`)
      return result
    }
  })

  // The built-in /goal, observed: its argument is the session's active goal; `/goal clear` clears it.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const change = goalChange(e.args)
    if (change !== undefined) {
      await update($, goal, () => change).catch((error: unknown) => debug($, `could not note the goal: ${String(error)}`))
    }
    return next(e)
  })

  on('command.run', { command: 'orders' }, async ($, e) => ({ text: await runOrders($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const offered = await read($, candidate)
    if (e.props.hasSurvey || offered === null) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const band = (
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            Keep as a standing order? <Text bold>"{offered.text}"</Text>
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Button key="keep-project" label="Project" hotkey="p" variant="primary" onPress={() => answer($, 'project')} />
          <Button key="keep-session" label="This session" hotkey="s" onPress={() => answer($, 'session')} />
          <Button key="dismiss" label="No" hotkey="n" onPress={() => answer($, 'dismiss')} />
        </Box>
      </Box>
    )
    // Another plugin's band beneath stays, under this one.
    const below = await next(e)
    return isBlankTree(below) ? (
      band
    ) : (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
