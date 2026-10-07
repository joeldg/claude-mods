/** How a labelled value was tied to its label: `:` or `=`, ` is `, or the value alone on the next line. */
export type Separator = 'colon' | 'is' | 'newline'

/** One secret found in a prompt: where it sits, what it is, and the env var name suggested for it. */
export type Finding = {
  /** A known shape's id (`aws-access-key-id`, `github-token`, ...), `labelled` or `custom`. */
  kind: string
  /** What the band calls it: the label as typed (`Secret Access Key`) or the shape's name (`GitHub token`). */
  label: string
  /** The secret itself. Kept in the module's memory only: never in state, a toast, a log or the status line. */
  value: string
  /** Offsets of `value` in the prompt's text. */
  start: number
  end: number
  /** The env var name suggested for it, `[A-Z][A-Z0-9_]*`; unique within one prompt. */
  name: string
}

/** One secret as the band shows it: its label, its masked tail and the name to save it under; never its value. */
export type BandItem = {
  label: string
  /** `…vxrm`: the last few characters, at most a fifth of the value. */
  masked: string
  /** The name in the band's field, as the person is typing it. */
  name: string
  /** The suggested name, used when the field is left empty. */
  suggested: string
}

/** What the band above the prompt shows for the prompt held back last. */
export type BandView = {
  /** Which held prompt this is; the band draws only while the module still holds that prompt. */
  id: number
  items: BandItem[]
  /** Whether the box took the text back; false where no box could (headless). */
  isRefilled: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'secret-guard': { band: BandView | null; isOff: boolean }
  }
}
