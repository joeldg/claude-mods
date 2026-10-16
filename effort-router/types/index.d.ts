/** The effort levels a `turn.step` request can name, lowest first. */
export type RouteLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What a prompt asks for: little thought, deep thought, or no opinion. */
export type RouteClass = 'routine' | 'deep' | 'neutral'

/** A prompt's class, waiting for the turn it starts. */
export type RoutePending = {
  cls: RouteClass
  /** Why it got that class, for /route ("starts with \"merged\""). */
  why: string
  /** True when /route deep or /route routine chose the class. */
  isForced: boolean
  text: string
}

/** The main loop's current (or last) turn and the effort chosen for it. */
export type RouteTurn = RoutePending & {
  id: string
  /** The effort every request of the turn carries; null until its first request. */
  effort: RouteLevel | null
  /** The effort the class asked for; differs from `effort` while the cache guard holds. */
  want: RouteLevel | null
  /** Why `effort` was chosen (`same`, `small`, `up`, `hold`, ...). */
  decision: string | null
  /** Turns in a row that wanted less effort than was being sent, this one included. */
  streak: number
  /** The percent of the 5-hour budget used when its cap lowered this turn's wanted effort; null when the cap did not. */
  cappedAt: number | null
}

/** What the prompt cache was last written with on the main loop, so a switch is only made when it pays. */
export type RouteCache = {
  /** The effort the main loop's last request carried. */
  applied: RouteLevel
  /** The model the main loop's last request named. */
  model: string
  /** The session's own effort, as the engine last offered it. */
  base: RouteLevel
  /** How many messages the main loop's last request carried. */
  messageCount: number
  /** Prompt tokens the last response was answered over, plus its output: what the next request re-sends. */
  contextTokens: number
  /** When the last main-loop response arrived; null before one has. */
  lastAt: number | null
  /** Turns in a row that wanted less effort than `applied`. */
  lowerStreak: number
}

export type RouteCounts = {
  routine: number
  deep: number
  neutral: number
  /** Turns whose effort differed from the turn before (each one rewrites the prompt cache). */
  switches: number
  /** Turns kept at the previous effort to spare the prompt cache. */
  holds: number
}

/** usage-meter's reading of the machine-wide 5-hour budget, as last read (one reading serves 30 s). */
export type RouteBudget = {
  /** When the summary was last read, for the memo. */
  checkedAt: number
  /** Percent of the last learned 5-hour limit already used; null without budget information. */
  pct: number | null
  /** Why there is no information ("no usage-meter summary", "summary is 12 min old", "no limit learned yet"); "" when pct is known. */
  note: string
  /** True while pct is at or over budgetCapAt: every turn and subagent is capped at budgetCapEffort. */
  isCapping: boolean
}

/** A subagent's running turn and the effort chosen at its first request, kept for the turn. */
export type RouteAgentTurn = {
  turnId: string
  effort: RouteLevel
}

export type RouteState = {
  /** /route off turns automatic routing off for the session; /route deep and /route routine still apply. */
  isOn: boolean
  /** A class /route forced on the next prompt. */
  forced: 'routine' | 'deep' | null
  pending: RoutePending | null
  turn: RouteTurn | null
  cache: RouteCache | null
  counts: RouteCounts
  /** Model rewrites already announced with a toast (`from→to`). */
  rewrites: string[]
  /** The last budget reading; null before one, or while the cap is off. */
  budget: RouteBudget | null
  /** Subagents with a turn running, by agent id, each with the effort its turn keeps. */
  agents: Record<string, RouteAgentTurn>
}

declare module 'claude-code' {
  interface PluginState {
    'effort-router': { router: RouteState }
  }
}
