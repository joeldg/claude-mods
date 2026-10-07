/** A file in the watched folder, as the band and /downloads show it. */
export type DropFile = {
  name: string
  /** The absolute path the @-mention names. */
  path: string
  /** Bytes. */
  size: number
  /** Last modification, milliseconds since the epoch. */
  mtimeMs: number
}

/** A file already attached or dismissed: it is offered again only when its modification time changes. */
export type DropMark = { name: string; mtimeMs: number }

/** What the last check saw of a candidate: it is ready once the next check sees the same size and time. */
export type DropSeen = { size: number; mtimeMs: number }

declare module 'claude-code' {
  interface PluginState {
    'downloads-drop': {
      /** The new files the band offers, oldest first. */
      pending: DropFile[]
      /** Only files modified after this count as new: the session's start, or the last /downloads clear. */
      since: number | null
      /** Files attached or dismissed since then. */
      cleared: DropMark[]
      /** The last /downloads listing, whose numbers /downloads attach takes. */
      listed: DropFile[]
    }
  }
}
