/** One search hit as the engine answers `search`; times are ms since the epoch. */
export type RecallHit = {
  /** The indexed extract's id (`d123`): what `expand` takes. */
  ref: string
  session: string
  project: string
  projectName: string
  /** The session's title. */
  title: string
  ts: number
  /** prompt, answer, summary, title, command, file, commit, pr, issue, url, decision, task, memory, order, review, note. */
  kind: string
  role: string
  /** claude, codex, memory, orders or reviews. */
  source: string
  /** The matched text, the query's terms marked `[[term]]`. */
  snippet: string
  score: number
  extra: Record<string, unknown> | null
}

/** A session the hits fall in, as `search` sums them up. */
export type RecallHitSession = {
  session: string
  title: string
  projectName: string
  hits: number
  lastTs: number
  /** False once Claude Code deleted the transcript: only the index's extracts remain. */
  transcriptExists: boolean
}

export type RecallSearch = {
  query: string
  total: number
  hits: RecallHit[]
  sessions: RecallHitSession[]
}

/** The session around an expanded hit. */
export type RecallSessionInfo = {
  session: string
  title: string
  project: string
  projectName: string
  start: number
  end: number
  source: string
  /** `claude --resume <id>`; '' when the source has no resume command. */
  resume: string
  transcriptExists: boolean
  transcriptPath: string
}

/** One extract of the conversation around a hit. */
export type RecallItem = {
  ref: string
  ts: number
  kind: string
  role: string
  text: string
}

export type RecallExpand = {
  session: RecallSessionInfo
  /** The ref expanded around. */
  focus: string
  items: RecallItem[]
}

export type RecallCommit = { sha: string; message: string }
export type RecallLink = { number: number; url: string; title: string }

/** One session as `recap` sums it up: where it left off. */
export type RecallRecap = {
  session: string
  title: string
  projectName: string
  start: number
  end: number
  prompts: number
  routine: boolean
  firstPrompt: string
  lastPrompts: string[]
  lastAnswer: string
  commits: RecallCommit[]
  prs: RecallLink[]
  issues: RecallLink[]
  files: string[]
  openTasks: string[]
  decisions: string[]
  resume: string
  transcriptExists: boolean
}

export type RecallTimelineSession = {
  session: string
  title: string
  projectName: string
  start: number
  end: number
  prompts: number
  commits: number
  prs: number
  routine: boolean
  source: string
}

export type RecallTimelineDay = { date: string; sessions: RecallTimelineSession[] }

/** One row of `list` (decisions, commands, files, PRs, notes, ...). */
export type RecallListItem = {
  ref: string
  ts: number
  session: string
  projectName: string
  title: string
  kind: string
  text: string
  extra: Record<string, unknown> | null
}

/** The extracts a hit's Open loaded into the pane, by ref. */
export type RecallOpen =
  | { state: 'loading' }
  | { state: 'open'; expand: RecallExpand }
  | { state: 'failed'; error: string }

/** What `/recall forget` is about to forget. */
export type RecallForgetTarget =
  | { kind: 'session'; id: string }
  | { kind: 'project'; name: string }
  | { kind: 'before'; date: string }

/** What the Recall pane shows: one view at a time. */
export type RecallView =
  | {
      kind: 'search'
      /** The engine query the hits answer; '' for hits that came from elsewhere (the related band). */
      query: string
      /** What the hits answer, in words: `"modal deploy"` or `#214`. */
      label: string
      /** Where they come from, in words: `14 hits in widgets · 12 more in other projects`. */
      note: string
      /** True when other projects have hits this view leaves out: an All projects button widens it. */
      canWiden: boolean
      hits: RecallHit[]
      sessions: RecallHitSession[]
      open: Record<string, RecallOpen>
    }
  | { kind: 'recap'; label: string; sessions: RecallRecap[] }
  | {
      kind: 'list'
      /** decision, command, file, commit, pr, issue, url, task or note. */
      listKind: string
      label: string
      note: string
      items: RecallListItem[]
      open: Record<string, RecallOpen>
    }
  | { kind: 'timeline'; label: string; days: RecallTimelineDay[] }
  | {
      kind: 'ask'
      question: string
      model: string
      state: 'asking' | 'answered' | 'failed'
      answer: string
      error: string
      /** The hits the answer drew on, cited ones first. */
      hits: RecallHit[]
      open: Record<string, RecallOpen>
    }
  | {
      kind: 'forget'
      target: RecallForgetTarget
      /** What will be forgotten, in words. */
      description: string
      state: 'confirm' | 'working' | 'done' | 'failed' | 'cancelled'
      result: string
    }
  | { kind: 'message'; label: string; text: string }

/** A block armed to ride along with the person's next prompt, once. */
export type RecallArmed = {
  /** What it came from (`d123`, `recap`, `ask`), so a second Attach of it replaces the first. */
  id: string
  block: string
}

/** The pick-up-where-you-left-off band: this project's last session. */
export type RecallLastBand = {
  session: string
  title: string
  /** When it last moved, ms since the epoch. */
  ts: number
  prs: RecallLink[]
  openTasks: number
  isHidden: boolean
}

/** The related-work band: past sessions that mention what the person's prompt names. */
export type RecallRelatedBand = {
  terms: string[]
  hits: RecallHit[]
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    recall: {
      /** What the Recall pane shows; null before anything was asked. */
      view: RecallView | null
      /** Blocks attached to the person's next prompt, once. */
      armed: RecallArmed[]
      lastBand: RecallLastBand | null
      relatedBand: RecallRelatedBand | null
      /** Terms the person dismissed from the related band this session, lowercased. */
      dismissed: string[]
    }
  }
}
