/**
 * One turn as this session's turns file keeps it, one JSON line each:
 * when it ended and the four token counts the API reported.
 */
export type TurnLine = {
  /** When the turn ended, in `$.clock.now()` milliseconds. */
  ts: number
  /** Uncached input tokens. */
  in: number
  /** Input tokens the prompt cache served. */
  cr: number
  /** Input tokens written to the prompt cache. */
  cw: number
  /** Output tokens. */
  out: number
  /** True for a subagent's turn. */
  sub: boolean
  /** The API's five-hour window reading when the turn ended, percent used; absent when it reported none. */
  u?: number
  /** When that window resets, in milliseconds; absent when the API said nothing. */
  r?: number
}

/** The window's token counts by category, summed over every session. */
export type WindowTotals = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** One session's share of the window, as /meter tables it. */
export type SessionUsageRow = {
  /** The session id (the turns file's name). */
  id: string
  turns: number
  /** How many of the turns were subagents'. */
  subTurns: number
  effective: number
}

/** The newest reading of the API's own five-hour window found in the window's turns. */
export type ApiReading = {
  /** When it was read, in milliseconds. */
  ts: number
  /** Percent of the five-hour limit used, as the API reported it. */
  percentUsed: number
  /** When the API said the window resets, in milliseconds; null when it did not say. */
  resetsAt: number | null
  /** Which session read it. */
  sessionId: string
}

/** One session-limit hit, as hits.json keeps it. */
export type Hit = {
  /** When the limit message was seen, in milliseconds. */
  at: number
  /** The next occurrence of the clock time the message named, in milliseconds. */
  resetAt: number
  /** The window's effective tokens when the limit was hit: a sample of the cap. */
  effectiveAtHit: number
  /** The zone the message named (`America/Los_Angeles`), or null when it named none. */
  zone: string | null
}

/** What summary.json holds for other mods: the contract, field for field. */
export type Summary = {
  ts: number
  windowMs: number
  sessions: number
  tokens: WindowTotals
  effective: number
  capEstimate: number | null
  pct: number | null
  lastHitAt: number | null
  nextResetAt: number | null
}

/** The plugin's settings, as /meter describes them. */
export type UsageSettings = {
  windowHours: number
  refreshSeconds: number
  warnAt: number
}

/** What this session has already said, so a reload does not say it again. */
export type UsageAlerts = {
  /** Whether the warn toast has fired for the share now above the threshold. */
  isWarned: boolean
  /** The reset times of the hits this session has toasted; at most 20. */
  toastedResets: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { alerts: UsageAlerts }
  }
}
