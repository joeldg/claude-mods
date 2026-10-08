/**
 * The light secret mask applied to everything the monitor stores or shows,
 * and the small text helpers around it. Pure: no `$`.
 */

const MASK = '[masked]'

/** Known token shapes, most specific first; each is replaced whole. */
const SHAPES: readonly RegExp[] = [
  // A PEM block (a private key above all), to its END line or the end of the text.
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_-])xox[a-z]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}/g,
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}/g,
]

/** `Bearer <token>`: the word stays, the token goes. */
const BEARER = /\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{8,}/g

/** `password: x`, `"passwd": "x"`: the label stays, the value goes. */
const PASSWORD = /\b(passw(?:or)?d|pwd|passphrase)(["']?[ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi

/** `token=x`, `API_KEY=x`, `secret=x` (an assignment or a query string, never prose with a colon). */
const ASSIGNED = /\b([A-Za-z_]*(?:secret|token|api[_-]?key|access[_-]?key))([ \t]*=[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s&,;]+)/gi

/** A password inside a URL: `scheme://user:password@host`. */
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi

/** Replaces every known secret shape in `text`; text without one comes back as it was. */
export function mask(text: string): string {
  let out = text
  for (const shape of SHAPES) {
    out = out.replace(shape, MASK)
  }
  const labelled = (_all: string, label: string, sep: string) => `${label}${sep}${MASK}`
  return out
    .replace(BEARER, `$1 ${MASK}`)
    .replace(PASSWORD, labelled)
    .replace(ASSIGNED, labelled)
    .replace(URL_PASSWORD, `$1${MASK}@`)
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Masked and cut: how any outside text is kept. */
export function keep(text: string, max: number): string {
  return clip(mask(text), max)
}

/** The first line with something on it. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      return line.trim()
    }
  }
  return ''
}

/** The last part of a path. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** `path` with the home folder written `~`. */
export function homeRelative(path: string, home: string | null): string {
  if (home && home !== '/' && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }
  return path
}

/**
 * What a write is logged as: the folder it went to, home-relative; a relative
 * path is under the session's folder (`./`). Never the file's contents.
 */
export function dirCategory(path: string, home: string | null): string {
  const cut = path.lastIndexOf('/')
  const dir = cut < 0 ? '.' : cut === 0 ? '/' : path.slice(0, cut)
  const shown = dir.startsWith('/') ? homeRelative(dir, home) : dir === '.' ? '.' : `./${dir.replace(/^\.\//, '')}`
  return keep(shown, 120)
}

/**
 * A command line as the logs name it: argv[0] and its first argument that is
 * not a flag, each cut to its last path part (`gh pr`, `python3 recall.py`).
 */
export function commandKey(argv: readonly string[]): string {
  const [first = '', ...rest] = argv
  const arg = rest.find(one => one !== '' && !one.startsWith('-'))
  const parts = [basename(first), arg === undefined ? '' : arg.includes('/') ? basename(arg) : arg]
  return keep(parts.filter(Boolean).join(' '), 60)
}

/** A short age: `now`, `40s`, `12m`, `3h`, `2d`. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) {
    return 'now'
  }
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** Milliseconds as people read them: `840 ms`, `2.4 s`, `3.1 min`. */
export function msText(ms: number): string {
  if (ms < 1) {
    return '<1 ms'
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  }
  return `${(ms / 60_000).toFixed(1)} min`
}

/** A count with thousands separators: `12,345`. */
export function countText(n: number): string {
  const digits = String(Math.abs(Math.round(n)))
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return n < 0 ? `-${grouped}` : grouped
}
