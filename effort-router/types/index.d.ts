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
}

declare module 'claude-code' {
  interface PluginState {
    'effort-router': { router: RouteState }
  }
}
