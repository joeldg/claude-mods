import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { DocsAudit, DocsAuditFile, DocsAuditItem } from '../types'
import { findingLine } from './plan'

/** The elements every surface has that the pane draws with. */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/** What the pane's buttons do; each runs in the plugin, the hooks module supplying it. */
export type PaneActions = {
  apply: (file: number, item: number) => void
  skip: (file: number, item: number) => void
  applyAll: (file: number) => void
  close: () => void
}

const POLICY_LINE =
  'Apply rewrites or removes a section in place; Skip leaves it. Nothing else is moved or deleted: a finished plan gets a git mv suggestion, a dated series a roll-up beside the dailies.'

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** An item the person can still act on. */
export const isActionable = (item: DocsAuditItem): boolean => item.verdict !== 'current' && item.state === 'pending'

export const headerLine = (audit: DocsAudit): string => `Docs audit · ${audit.scope} · ${plural(audit.docs, 'doc')}, ${plural(audit.findings, 'finding')}`

/** `Asking claude-haiku-5-5 about 6 files… 2 answered`, then `claude-haiku-5-5 answered for 6 files`. */
export function modelLine(audit: DocsAudit): string {
  const asked = audit.files.filter(file => file.model !== 'skipped').length
  const answered = audit.files.filter(file => file.model === 'done' || file.model === 'failed').length
  const skipped = audit.files.length - asked
  const tail = skipped > 0 ? `; ${skipped} not sent (maxModelFiles)` : ''
  return audit.state === 'running'
    ? `Asking ${audit.model} about ${plural(asked, 'file')}… ${answered} answered${tail}`
    : `${audit.model} answered for ${plural(asked, 'file')}${tail}`
}

export const fileLine = (file: DocsAuditFile): string =>
  `${file.file} · ${file.findings.length === 0 ? 'changed, no findings' : plural(file.findings.length, 'finding')}`

export const itemLine = (item: DocsAuditItem): string => `  ${item.verdict} · ${item.section}${item.reason ? `: ${item.reason}` : ''}`

/** What became of an item, under its line; null while it waits. */
export function stateLine(item: DocsAuditItem): string | null {
  switch (item.state) {
    case 'applied':
      return `  ✓ ${item.note ?? 'applied'}`
    case 'skipped':
      return '  skipped'
    case 'failed':
      return `  ✗ ${item.note ?? 'failed'}`
    default:
      return null
  }
}

/** The model's standing for one file, under its items; null when the items say it all. */
export function fileModelLine(file: DocsAuditFile, model: string): string | null {
  switch (file.model) {
    case 'waiting':
      return `  asking ${model}…`
    case 'skipped':
      return `  not sent to the model: ${file.modelNote ?? ''}`
    case 'failed':
      return `  model call failed: ${file.modelNote ?? ''}`
    default:
      return file.items.length === 0 ? `  ${file.modelNote ?? 'nothing to change'}` : null
  }
}

function itemTree(kit: Kit, item: DocsAuditItem, fi: number, ii: number, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = kit
  const state = stateLine(item)
  return (
    <Box key={`item-${fi}-${ii}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="wrap" dimColor={item.verdict === 'current'}>
            {itemLine(item)}
          </Text>
        </Box>
        {isActionable(item) && (
          <Box flexShrink={0} flexDirection="row" gap={1}>
            <Button key={`apply-${fi}-${ii}`} label="Apply" variant="primary" onPress={() => actions.apply(fi, ii)} />
            <Button key={`skip-${fi}-${ii}`} label="Skip" onPress={() => actions.skip(fi, ii)} />
          </Box>
        )}
      </Box>
      {state !== null && (
        <Text wrap="wrap" dimColor={item.state === 'skipped'} color={item.state === 'failed' ? 'red' : undefined}>
          {state}
        </Text>
      )}
    </Box>
  )
}

function fileTree(kit: Kit, file: DocsAuditFile, fi: number, model: string, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = kit
  const pending = file.items.filter(isActionable).length
  const standing = fileModelLine(file, model)
  return (
    <Box key={`file-${fi}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text bold wrap="truncate-end">
            {fileLine(file)}
          </Text>
        </Box>
        {pending > 1 && (
          <Box flexShrink={0}>
            <Button key={`apply-all-${fi}`} label="Apply all" variant="primary" onPress={() => actions.applyAll(fi)} />
          </Box>
        )}
      </Box>
      {file.findings.map(found => (
        <Text dimColor wrap="wrap">
          {findingLine(found)}
        </Text>
      ))}
      {file.items.map((item, ii) => itemTree(kit, item, fi, ii, actions))}
      {standing !== null && (
        <Text dimColor wrap="wrap">
          {standing}
        </Text>
      )}
      {file.kind === 'series' && file.items.some(item => item.verdict === 'rollup') && (
        <Text dimColor wrap="wrap">
          {'  The dailies stay in place; Apply writes the roll-up beside them.'}
        </Text>
      )}
    </Box>
  )
}

/** The Docs audit pane: the run's header, then each file with its findings and the plan's items. */
export function auditTree(kit: Kit, audit: DocsAudit | null, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = kit
  if (audit === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No docs audit yet. /garden audit runs one.</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text bold wrap="truncate-end">
              {headerLine(audit)}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Button key="close" label="Close" role="dismiss" onPress={actions.close} />
          </Box>
        </Box>
        <Text dimColor wrap="wrap">
          {modelLine(audit)}
        </Text>
        <Text dimColor wrap="wrap">
          {POLICY_LINE}
        </Text>
      </Box>
      {audit.files.map((file, fi) => fileTree(kit, file, fi, audit.model, actions))}
    </Box>
  )
}
