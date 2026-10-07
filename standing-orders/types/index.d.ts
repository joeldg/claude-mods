/** Where an order holds: this repo or folder, across sessions; or this session alone. */
export type Scope = 'project' | 'session'

export type Order = {
  /** The instruction, one line of at most 200 characters. */
  text: string
  /** When it was kept, in epoch milliseconds. */
  addedAt: number
}

/** A directive from the person's prompt that the band offers to keep. */
export type Candidate = {
  text: string
  /** Prompts submitted since it was offered; left unanswered for a few, it is dropped. */
  promptsSince: number
}

/** An order kept mid-conversation, waiting to ride along with the next prompt. */
export type Unsent = { text: string; scope: Scope }

declare module 'claude-code' {
  interface PluginState {
    'standing-orders': {
      candidate: Candidate | null
      sessionOrders: Order[]
      /** The `/goal` last set in this session; null when none, or after `/goal clear`. */
      goal: string | null
      unsent: Unsent[]
      /** Directives answered No this session (lower-cased), so they are not offered again. */
      dismissed: string[]
    }
  }
}
