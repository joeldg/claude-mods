/** What a deterministic check found: in one doc, or for a dated series in one folder. */
export type DocsFindingKind =
  | 'dead-reference'
  | 'stale-marker'
  | 'duplicate-paragraph'
  | 'orphan'
  | 'dated-series'
  | 'oversized'
  | 'finished-plan'

export type DocsFinding = {
  /** The doc, relative to the repo root; the folder, with a trailing slash, for a dated series. */
  file: string
  /** 1-based; 0 when the finding is about the whole file or folder. */
  line: number
  kind: DocsFindingKind
  /** What was found, in one line. */
  text: string
  /** What to do about it, in one line. */
  suggestion: string
}

/** The model's verdict on one section; `rollup` only for a dated series. */
export type DocsVerdict = 'current' | 'update' | 'stray' | 'duplicate' | 'delete' | 'rollup'

/** One item of the model's edit plan, as parsed. */
export type DocsPlanItem = {
  /** A heading's text, a line range such as `12-20`, or `ROLLUP` for a series. */
  section: string
  verdict: DocsVerdict
  reason: string
  /** The section's full new text (the roll-up's text for a series), or null to delete the section. */
  replacement: string | null
  /** The section's first line when the plan was made, so a range that moved is found again. */
  anchor: string | null
}

export type DocsItemState = 'pending' | 'applied' | 'skipped' | 'failed'

export type DocsAuditItem = DocsPlanItem & {
  state: DocsItemState
  /** What applying it did, or why it failed; null while pending or skipped. */
  note: string | null
}

export type DocsAuditFile = {
  /** The doc relative to the root, or the folder of a dated series (trailing slash). */
  file: string
  kind: 'doc' | 'series'
  findings: DocsFinding[]
  items: DocsAuditItem[]
  /** `waiting` until the model has answered; `skipped` when it was not asked. */
  model: 'waiting' | 'done' | 'skipped' | 'failed'
  /** Why it was skipped or how the call failed; null otherwise. */
  modelNote: string | null
}

/** One /docs audit run, as the pane shows it. */
export type DocsAudit = {
  startedAt: number
  root: string
  /** What was audited, in words. */
  scope: string
  /** How many docs were checked. */
  docs: number
  /** How many findings the deterministic checks made, in all. */
  findings: number
  files: DocsAuditFile[]
  model: string
  state: 'running' | 'done'
  /** True for `--apply`: every item is applied as it arrives, without the pane. */
  isApplyAll: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'docs-gardener': { audit: DocsAudit | null }
  }
  /** The mod's own tool, named here so its hooks and tests type before the engine's table lists it. */
  interface McpToolInputs {
    'mcp__docs-gardener__docs_check': {
      /** A markdown file or a folder, relative to the project root or absolute. */
      path: string
    }
  }
}
