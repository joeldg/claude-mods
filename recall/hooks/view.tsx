import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  MarkdownProps,
  RenderElement,
  RenderSurface,
  TextProps,
} from 'claude-code'

import type {
  RecallHit,
  RecallHitSession,
  RecallLastBand,
  RecallListItem,
  RecallOpen,
  RecallRecap,
  RecallRelatedBand,
  RecallView,
} from '../types'
import {
  agoOf,
  clockOf,
  dayOf,
  decisionText,
  fitParts,
  kindLabel,
  modelLabel,
  oneLine,
  plural,
  recapLines,
  resumeOf,
  sessionLines,
  snippetParts,
  speakerOf,
  timelineLine,
} from './format'
import { relatedLine } from './refs'

/** The elements every surface has that the pane and the bands draw with. */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
}

/** What the pane's buttons do; each runs in the plugin, the hooks module supplying it. */
export type PaneActions = {
  open: (ref: string) => void
  attach: (ref: string) => void
  copy: (command: string, surface: RenderSurface) => void
  widen: () => void
  sendRecap: () => void
  sendAnswer: () => void
  confirm: () => void
  cancel: () => void
  close: () => void
}

export type PaneContext = {
  now: number
  /** The ids of the blocks armed for the next prompt: refs, `recap`, `ask`. */
  armed: readonly string[]
}

/** One `Markdown` element draws at most 10000 characters. */
const MARKDOWN_MAX = 9_000

/** True for what the engine draws when no plugin draws the band, or an empty Box. */
export function isBlankTree(tree: RenderElement): boolean {
  if (tree.type === 'engine') {
    return true
  }
  return tree.type === 'Box' && (tree.children ?? []).length === 0
}

function snippetText(kit: Kit, hit: RecallHit, max: number): RenderElement {
  const { Text } = kit
  const parts = fitParts(snippetParts(hit.snippet), max)
  return (
    <Text wrap="wrap">
      <Text color="cyan">{kindLabel(hit)}</Text> {parts.map(part => (part.isHit ? <Text bold>{part.text}</Text> : part.text))}
    </Text>
  )
}

/** The conversation Open loaded under a hit. */
function openBlock(kit: Kit, open: RecallOpen | undefined): RenderElement | null {
  const { Box, Text } = kit
  if (!open) {
    return null
  }
  if (open.state === 'loading') {
    return <Text dimColor>  Loading the conversation around it…</Text>
  }
  if (open.state === 'failed') {
    return (
      <Text color="red" wrap="wrap">
        {'  '}
        {oneLine(open.error, 300)}
      </Text>
    )
  }
  const expand = open.expand
  // How to resume it, or for a doc from no session, what it is.
  const facts = sessionLines(expand.session)
  const kept = facts[1] ?? facts[0] ?? ''
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor wrap="wrap">
        {kept}
      </Text>
      {expand.items.length === 0 && <Text dimColor>No extracts were found around it.</Text>}
      {expand.items.map(item => (
        <Text dimColor={item.ref !== expand.focus} wrap="wrap">
          {item.ref === expand.focus ? '→ ' : '  '}
          {clockOf(item.ts)} {speakerOf(item)}: {oneLine(item.text, 500)}
        </Text>
      ))}
    </Box>
  )
}

function rowButtons(kit: Kit, ref: string, open: RecallOpen | undefined, isArmed: boolean, actions: PaneActions) {
  const { Box, Button } = kit
  const isShown = open !== undefined && open.state !== 'failed'
  return (
    <Box flexShrink={0} flexDirection="row" gap={1}>
      <Button key={`open-${ref}`} label={isShown ? 'Hide' : 'Open'} onPress={() => actions.open(ref)} />
      <Button key={`attach-${ref}`} label={isArmed ? 'Attached' : 'Attach'} onPress={() => actions.attach(ref)} />
    </Box>
  )
}

function hitRow(kit: Kit, hit: RecallHit, open: RecallOpen | undefined, isArmed: boolean, actions: PaneActions) {
  const { Box } = kit
  return (
    <Box key={`hit-${hit.ref}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          {snippetText(kit, hit, 400)}
        </Box>
        {rowButtons(kit, hit.ref, open, isArmed, actions)}
      </Box>
      {openBlock(kit, open)}
    </Box>
  )
}

function armedNote(kit: Kit, armed: readonly string[]): RenderElement | null {
  const { Text } = kit
  return armed.length > 0 ? (
    <Text dimColor wrap="truncate-end">
      Attached to your next message: {armed.join(', ')}
    </Text>
  ) : null
}

/** The hits by session, sessions in the order of their best hit; a hit from no session (a memory file) stands alone. */
export function bySession(hits: readonly RecallHit[]): RecallHit[][] {
  const groups = new Map<string, RecallHit[]>()
  for (const hit of hits) {
    const key = hit.session ? `${hit.source}:${hit.session}` : `ref:${hit.ref}`
    groups.set(key, [...(groups.get(key) ?? []), hit])
  }
  return [...groups.values()]
}

function sessionGroup(
  kit: Kit,
  hits: readonly RecallHit[],
  info: RecallHitSession | undefined,
  open: Readonly<Record<string, RecallOpen>>,
  ctx: PaneContext,
  actions: PaneActions,
) {
  const { Box, Text, Button } = kit
  const first = hits[0]
  if (!first) {
    return null
  }
  const title = oneLine(first.title || info?.title || 'Untitled session', 80)
  const last = Math.max(...hits.map(hit => hit.ts), info?.lastTs ?? 0)
  const exists = info?.transcriptExists ?? true
  const resume = resumeOf(first.source, first.session)
  return (
    <Box key={`session-${first.session || first.ref}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text bold wrap="truncate-end">
            {dayOf(last)} · {oneLine(first.projectName || info?.projectName || 'no project', 40)} · {title}
          </Text>
        </Box>
        {resume && exists && (
          <Box flexShrink={0}>
            <Button
              key={`copy-${first.session}`}
              label="Copy resume command"
              plain
              dimColor
              onPress={press => actions.copy(resume, press.surface)}
            />
          </Box>
        )}
      </Box>
      {!exists && <Text dimColor>The transcript was deleted; these extracts are what remains.</Text>}
      {hits.map(hit => hitRow(kit, hit, open[hit.ref], ctx.armed.includes(hit.ref), actions))}
    </Box>
  )
}

function searchView(kit: Kit, view: Extract<RecallView, { kind: 'search' }>, ctx: PaneContext, actions: PaneActions) {
  const { Box, Text, Button } = kit
  const info = new Map(view.sessions.map(one => [one.session, one]))
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor wrap="truncate-end">
            {view.label} · {view.note}
          </Text>
        </Box>
        {view.canWiden && (
          <Box flexShrink={0}>
            <Button key="widen" label="All projects" onPress={actions.widen} />
          </Box>
        )}
      </Box>
      {armedNote(kit, ctx.armed)}
      {view.hits.length === 0 && (
        <Text dimColor>No past session matches. Try other or fewer words, a "quoted phrase" or a PR number.</Text>
      )}
      {bySession(view.hits).map(hits => sessionGroup(kit, hits, info.get(hits[0]?.session ?? ''), view.open, ctx, actions))}
    </Box>
  )
}

function recapTree(kit: Kit, recap: RecallRecap, now: number, actions: PaneActions) {
  const { Box, Text, Button } = kit
  const [first = '', ...rest] = recapLines(recap, now)
  const resume = recap.resume || resumeOf('claude', recap.session)
  return (
    <Box key={`recap-${recap.session}`} flexDirection="column">
      <Text bold wrap="wrap">
        {first}
      </Text>
      {rest.map(line => (
        <Text wrap="wrap" dimColor={line.startsWith('When:') || line.startsWith('Resume:')}>
          {line}
        </Text>
      ))}
      {resume && recap.transcriptExists && (
        <Box flexDirection="row">
          <Button key={`copy-${recap.session}`} label="Copy resume command" onPress={press => actions.copy(resume, press.surface)} />
        </Box>
      )}
    </Box>
  )
}

function recapView(kit: Kit, view: Extract<RecallView, { kind: 'recap' }>, ctx: PaneContext, actions: PaneActions) {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="truncate-end">
        {view.label}
      </Text>
      {view.sessions.length > 0 && (
        <Box flexDirection="row" gap={1}>
          <Button key="send" label="Send to Claude" variant="primary" onPress={actions.sendRecap} />
          <Button key="close" label="Close" role="dismiss" onPress={actions.close} />
        </Box>
      )}
      {ctx.armed.includes('recap') && <Text dimColor>Attached to your next message.</Text>}
      {view.sessions.length === 0 && <Text dimColor>No earlier session was found here.</Text>}
      {view.sessions.map(recap => recapTree(kit, recap, ctx.now, actions))}
    </Box>
  )
}

function listRow(kit: Kit, item: RecallListItem, open: RecallOpen | undefined, isArmed: boolean, actions: PaneActions) {
  const { Box, Text } = kit
  const facts = [dayOf(item.ts), oneLine(item.projectName, 40), item.title ? `"${oneLine(item.title, 60)}"` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <Box key={`item-${item.ref}`} flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {facts}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="wrap">{item.kind === 'decision' ? decisionText(item.text, 500) : oneLine(item.text, 500)}</Text>
        </Box>
        {rowButtons(kit, item.ref, open, isArmed, actions)}
      </Box>
      {openBlock(kit, open)}
    </Box>
  )
}

function listView(kit: Kit, view: Extract<RecallView, { kind: 'list' }>, ctx: PaneContext, actions: PaneActions) {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="truncate-end">
        {view.label}
        {view.note ? ` · ${view.note}` : ''}
      </Text>
      {armedNote(kit, ctx.armed)}
      {view.items.length === 0 && <Text dimColor>Nothing was found.</Text>}
      {view.items.map(item => listRow(kit, item, view.open[item.ref], ctx.armed.includes(item.ref), actions))}
    </Box>
  )
}

function timelineView(kit: Kit, view: Extract<RecallView, { kind: 'timeline' }>) {
  const { Box, Text } = kit
  const projects = new Set(view.days.flatMap(day => day.sessions.map(one => one.projectName)))
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="truncate-end">
        {view.label}
      </Text>
      {view.days.length === 0 && <Text dimColor>No sessions in this period.</Text>}
      {view.days.map(day => (
        <Box key={`day-${day.date}`} flexDirection="column">
          <Text bold>{day.date}</Text>
          {day.sessions.map(one => (
            <Text wrap="truncate-end">
              {'  '}
              {timelineLine(one, projects.size > 1)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function askView(kit: Kit, view: Extract<RecallView, { kind: 'ask' }>, ctx: PaneContext, actions: PaneActions) {
  const { Box, Text, Button, Markdown } = kit
  const label = modelLabel(view.model)
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="wrap">
        Asked {label}: {oneLine(view.question, 300)}
      </Text>
      {view.state === 'asking' && <Text dimColor>Searching past sessions and asking {label}…</Text>}
      {view.state === 'failed' && (
        <Text color="red" wrap="wrap">
          {view.error}
        </Text>
      )}
      {view.state === 'answered' && (
        <Box flexDirection="row" gap={1}>
          <Button key="send" label="Send to Claude" variant="primary" onPress={actions.sendAnswer} />
          <Button key="close" label="Close" role="dismiss" onPress={actions.close} />
        </Box>
      )}
      {view.state === 'answered' && ctx.armed.includes('ask') && <Text dimColor>Attached to your next message.</Text>}
      {view.state === 'answered' && view.answer && <Markdown key="answer" text={view.answer.slice(0, MARKDOWN_MAX)} />}
      {view.hits.length > 0 && <Text dimColor>Sources, cited first:</Text>}
      {view.hits.map(hit => (
        <Box key={`source-${hit.ref}`} flexDirection="column">
          <Text dimColor wrap="truncate-end">
            [{hit.ref}] {dayOf(hit.ts)} · {oneLine(hit.projectName, 40)} · {oneLine(hit.title || 'Untitled session', 60)}
          </Text>
          {hitRow(kit, hit, view.open[hit.ref], ctx.armed.includes(hit.ref), actions)}
        </Box>
      ))}
    </Box>
  )
}

function forgetView(kit: Kit, view: Extract<RecallView, { kind: 'forget' }>, actions: PaneActions) {
  const { Box, Text, Button } = kit
  const isOver = view.state === 'done' || view.state === 'failed' || view.state === 'cancelled'
  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="wrap">{view.description}</Text>
      {view.state === 'confirm' && (
        <Box flexDirection="row" gap={1}>
          <Button key="confirm" label="Confirm" variant="primary" onPress={actions.confirm} />
          <Button key="cancel" label="Cancel" role="dismiss" onPress={actions.cancel} />
        </Box>
      )}
      {view.state === 'working' && <Text dimColor>Forgetting…</Text>}
      {isOver && (
        <Text color={view.state === 'failed' ? 'red' : undefined} wrap="wrap">
          {view.result}
        </Text>
      )}
    </Box>
  )
}

/** The Recall pane's body for the view it shows. */
export function paneTree(kit: Kit, view: RecallView | null, ctx: PaneContext, actions: PaneActions): RenderElement {
  const { Box, Text } = kit
  if (view === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{'Nothing recalled yet. /recall <words> searches your past sessions; /recall help lists the rest.'}</Text>
      </Box>
    )
  }
  switch (view.kind) {
    case 'search':
      return searchView(kit, view, ctx, actions)
    case 'recap':
      return recapView(kit, view, ctx, actions)
    case 'list':
      return listView(kit, view, ctx, actions)
    case 'timeline':
      return timelineView(kit, view)
    case 'ask':
      return askView(kit, view, ctx, actions)
    case 'forget':
      return forgetView(kit, view, actions)
    default:
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{view.label}</Text>
          <Text wrap="wrap">{view.text}</Text>
        </Box>
      )
  }
}

/** `Last session here (2d ago): "Fix the upload test" · PR #99 · 3 open tasks  [Recap] [Dismiss]` */
export function lastBandTree(
  kit: Kit,
  band: RecallLastBand,
  now: number,
  actions: { recap: () => void; dismiss: () => void },
): RenderElement {
  const { Box, Text, Button } = kit
  const pr = band.prs[0]
  const extras = [
    band.prs.length > 1 ? `${band.prs.length} PRs` : pr && pr.number > 0 ? `PR #${pr.number}` : '',
    band.openTasks > 0 ? plural(band.openTasks, 'open task') : '',
  ].filter(Boolean)
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text dimColor>Last session here ({agoOf(now, band.ts)}): </Text>"{oneLine(band.title || 'Untitled session', 80)}"
          {extras.length > 0 && <Text dimColor> · {extras.join(' · ')}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} flexDirection="row" gap={1}>
        <Button key="recap" label="Recap" variant="primary" onPress={actions.recap} />
        <Button key="dismiss-last" label="Dismiss" role="dismiss" onPress={actions.dismiss} />
      </Box>
    </Box>
  )
}

/** `Past sessions mention #214: Sep 25 "merged 213, go ahead with #214" (+2 more)  [Show] [Attach] [Dismiss]` */
export function relatedBandTree(
  kit: Kit,
  band: RecallRelatedBand,
  actions: { show: () => void; attach: () => void; dismiss: () => void },
): RenderElement {
  const { Box, Text, Button } = kit
  const line = relatedLine(band.terms, band.hits, band.total)
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text dimColor>{line.lead}</Text>
          {line.quote}
          {line.more && <Text dimColor>{line.more}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} flexDirection="row" gap={1}>
        <Button key="related-show" label="Show" variant="primary" onPress={actions.show} />
        <Button key="related-attach" label="Attach" onPress={actions.attach} />
        <Button key="related-dismiss" label="Dismiss" role="dismiss" onPress={actions.dismiss} />
      </Box>
    </Box>
  )
}
