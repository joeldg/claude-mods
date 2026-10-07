/** One finished second opinion: what the pane draws and the saved file keeps. */
export type Opinion = {
  /** The review as the model wrote it (Markdown). */
  text: string
  /** The model id or alias that wrote it. */
  model: string
  /** The effort it was asked for. */
  effort: string
  /** What was reviewed, in words: "the last 12 commits on main", "docs/plan.md". */
  subject: string
  /** The question the person asked it to focus on; '' when none. */
  focus: string
  /** When it finished, ms since the epoch. */
  createdAt: number
  /** Where it was saved; null when it could not be. */
  path: string | null
}

/** The review under way: one at a time. */
export type OpinionRun = {
  model: string
  subject: string
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'second-opinion': {
      /** The review the pane shows: the last one this session, or one reopened from disk. */
      current: Opinion | null
      running: OpinionRun | null
      /** The context block armed by Send to Claude, attached to the person's next prompt once. */
      armed: string | null
    }
  }
}
