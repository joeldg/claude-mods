import type { RenderElement } from 'claude-code'

import type { Finding, Separator } from '../types'

/** A known secret shape: what it looks like, what the band calls it, and the env var it suggests. */
type Shape = {
  kind: string
  label: string
  name: string
  pattern: RegExp
  /** The capture group holding the secret, when the match carries more than the secret. */
  group?: number
  /** Whether the secret must also pass the value checks a labelled one does (mixed characters, no placeholder). */
  isLoose?: boolean
}

/** Shapes the vendors document. Each pattern is global; its boundaries keep it off longer words. */
const SHAPES: readonly Shape[] = [
  {
    kind: 'private-key',
    label: 'Private key',
    name: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    kind: 'aws-access-key-id',
    label: 'AWS access key ID',
    name: 'AWS_ACCESS_KEY_ID',
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  {
    kind: 'github-token',
    label: 'GitHub token',
    name: 'GITHUB_TOKEN',
    pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
  },
  {
    kind: 'github-token',
    label: 'GitHub token',
    name: 'GITHUB_TOKEN',
    pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g,
  },
  {
    kind: 'anthropic-key',
    label: 'Anthropic API key',
    name: 'ANTHROPIC_API_KEY',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    kind: 'openai-key',
    label: 'OpenAI API key',
    name: 'OPENAI_API_KEY',
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  },
  {
    kind: 'slack-token',
    label: 'Slack token',
    name: 'SLACK_TOKEN',
    pattern: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    kind: 'google-api-key',
    label: 'Google API key',
    name: 'GOOGLE_API_KEY',
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  {
    kind: 'huggingface-token',
    label: 'Hugging Face token',
    name: 'HF_TOKEN',
    pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/g,
  },
  {
    kind: 'gitlab-token',
    label: 'GitLab token',
    name: 'GITLAB_TOKEN',
    pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    kind: 'npm-token',
    label: 'npm token',
    name: 'NPM_TOKEN',
    pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
  },
  {
    kind: 'stripe-key',
    label: 'Stripe live key',
    name: 'STRIPE_SECRET_KEY',
    pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{20,}/g,
  },
  {
    kind: 'bearer-token',
    label: 'Bearer token',
    name: 'BEARER_TOKEN',
    pattern: /(?<![A-Za-z0-9])Bearer[ \t]+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
    isLoose: true,
  },
]

/** A password inside a URL (`scheme://user:password@host`); a URL without one is never a secret. */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:([^\s/@]+)@([^\s/:?#]+)/gi

/** The 40-character secret that sits beside an AWS access key ID. */
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

/** How far from an AWS access key ID its secret is looked for, and how far back a "for <service>" is. */
const AWS_SECRET_REACH = 300
const CONTEXT_REACH = 300

/**
 * The labels a secret is typed after. Longer ones first, so `Secret Access Key` is one label and not
 * `secret` then `Access Key`. `_` and `-` may join a label to more of an identifier (`DB_PASSWORD`).
 */
const LABEL =
  /(?<![A-Za-z0-9])(wi-?fi[ _-]?passw(?:or)?d|client[ _-]?secret|secret(?:[ _-]?access)?[ _-]?key|access[ _-]?key(?:[ _-]?id)?|api[ _-]?key|passw(?:or)?d|pass|secret|token)(?![A-Za-z0-9])/gi

/** What may stand between a label and its separator: `for the guest network`, `of the router` (group 1). */
const QUALIFIER = String.raw`(?:[ \t]+(?:for|of|on|at|in|to)[ \t]+((?:[^\s:=.,;!?]+[ \t]+){0,3}?[^\s:=.,;!?]+))?`

/** `label: value`, `label = value`, `"label": "value"`, `label := value`, `label => value`. */
const SAME_LINE = new RegExp(`${QUALIFIER}["'\`]?[ \\t]*(?:\\*\\*|__)?[ \\t]*(?::=|=>|:(?!:)|=(?!=))[ \\t]*(?:\\*\\*|__)?[ \\t]*(\\S+)`, 'iy')

/** `label is value`, `label for the guest network is value`. */
const IS_FORM = new RegExp(`${QUALIFIER}[ \\t]+(?:is|was)[ \\t]*:?[ \\t]+(\\S+)`, 'iy')

/** The label ending its line (`for <what>` and a colon allowed) and the value alone on the next one: the two-line paste. */
const NEXT_LINE = new RegExp(`${QUALIFIER}["'\`]?[ \\t]*:?[ \\t]*\\r?\\n[ \\t]*(\\S+)(?=[ \\t]*(?:\\r?\\n|$))`, 'iy')

/** The last part of an identifier label that says it names something about a secret, not the secret. */
const NOT_A_SECRET_SUFFIX = new Set([
  'length', 'len', 'min', 'max', 'count', 'type', 'url', 'uri', 'endpoint', 'path', 'file', 'dir', 'name',
  'field', 'label', 'hint', 'policy', 'expiry', 'expires', 'expiration', 'ttl', 'timeout', 'header', 'prefix',
  'regex', 'pattern', 'rule', 'rules', 'limit', 'limits', 'size', 'format', 'mode', 'enabled', 'required',
  'hash', 'env', 'var', 'variable', 'location', 'store', 'manager', 'provider', 'source', 'version',
])

/** The env var name each label stands for. */
const LABEL_NAMES: readonly [RegExp, string][] = [
  [/^wi-?fi[ _-]?passw(?:or)?d$/i, 'WIFI_PASSWORD'],
  [/^client[ _-]?secret$/i, 'CLIENT_SECRET'],
  [/^secret[ _-]?access[ _-]?key$/i, 'SECRET_ACCESS_KEY'],
  [/^secret[ _-]?key$/i, 'SECRET_KEY'],
  [/^access[ _-]?key[ _-]?id$/i, 'ACCESS_KEY_ID'],
  [/^access[ _-]?key$/i, 'ACCESS_KEY'],
  [/^api[ _-]?key$/i, 'API_KEY'],
  [/^passw(?:or)?d$|^pass$/i, 'PASSWORD'],
  [/^secret$/i, 'SECRET'],
  [/^token$/i, 'TOKEN'],
]

/** Words that never name a service: "my", "the", "for now", "at least", ... */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'new',
  'old', 'current', 'same', 'other', 'and', 'or', 'with', 'use', 'using', 'here', 'there', 'is', 'are', 'was',
  'be', 'for', 'from', 'on', 'at', 'to', 'in', 'of', 'it', 'me', 'you', 'us', 'them', 'now', 'later', 'also',
  'both', 'all', 'each', 'any', 'some', 'following', 'below', 'above', 'example', 'instance', 'least', 'most',
  'once', 'temporary', 'temp', 'default', 'personal', 'secret', 'token', 'password', 'key', 'keys', 'api',
  'access', 'please', 'set', 'get', 'got', 'just', 'then', 'what', 'which', 'whose', 'one', 'two', 'it\'s',
  'login', 'log', 'sign', 'signing', 'free', 'real', 'actual', 'correct', 'right', 'wrong', 'today',
])

/** Second-level parts of a domain that are not the service's name. */
const DOMAIN_NOISE = new Set(['www', 'api', 'app', 'apps', 'console', 'platform', 'dashboard', 'portal', 'co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'io'])

const PASSWORD_LABEL = /passw(?:or)?d|^pass$|[ _-]pass$/i

type Candidate = Finding & {
  /** 2: named by an identifier (`DB_PASSWORD=`); 1: by a label with a service before it; 0: by a bare label or a shape. */
  strength: number
  isShape: boolean
}

/** What `detect` can be given beside the text: a person's own extra pattern. */
export type DetectOptions = { extra?: RegExp | null }

/** The secret's character classes present: lowercase, uppercase, digits, anything else. */
export function characterClasses(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length
}

/** `$NAME`, `${NAME}`, `$(cmd)`, `%NAME%`, `{{ secrets.X }}`, `process.env.X`, `os.environ[...]`, `getenv(...)`. */
export function isReference(value: string): boolean {
  return (
    value.startsWith('$') ||
    /^%[A-Za-z_][A-Za-z0-9_]*%/.test(value) ||
    /^\{\{.*\}\}$/.test(value) ||
    /(?:^|[^A-Za-z0-9_])(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv|System\.getenv|ENV\[|env\(|secrets\.)/.test(value)
  )
}

/** `xxxx`, `***`, `...`, `<your-key>`, `[token]`, `your-key-here`, `changeme`, `aaaaaaaa`. */
export function isPlaceholder(value: string): boolean {
  return (
    /xxxx|XXXX|\*{3,}|\.{3,}|…|•{3,}/.test(value) ||
    /^<[^>]*>$|^\[[^\]]*\]$|^\{[^}]*\}$/.test(value) ||
    /your[-_ ]?(?:own[-_ ]?)?(?:api[-_ ]?|access[-_ ]?|secret[-_ ]?)?(?:key|token|secret|pass(?:word)?)/i.test(value) ||
    /(?:key|token|secret|password)[-_]?here|change[-_]?me|placeholder|redacted|replace[-_]?me|insert[-_]?your/i.test(value) ||
    new Set(value).size <= 2
  )
}

/** A URL: an address, never a secret by itself (a password inside one is found as its own shape). */
export function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^www\./i.test(value)
}

/** `/etc/x`, `~/.ssh/id_rsa`, `./secrets.json`, `C:\x`, `config/secrets.yml`; a base64 value has `+` or `=` far more often. */
export function isPath(value: string): boolean {
  if (/^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6}$/.test(value)) {
    return true
  }
  return /^(?:~|\.{1,2})?\/|^[A-Za-z]:[\\/]/.test(value) && !/[+=]/.test(value)
}

/** Code, not a value: `getToken()`, `config.apiKey`, `access_token`, `accessToken`, `API_KEY`, `Required`. */
export function isCodeLike(value: string): boolean {
  return (
    /^[A-Za-z_$][\w$.]*[ \t]*[([{]/.test(value) ||
    /^(?:true|false|null|none|nil|undefined)$/i.test(value) ||
    /^[a-z]+(?:_[a-z]+)+$/.test(value) ||
    /^[a-z]+(?:[A-Z][a-z]+)+$/.test(value) ||
    /^(?:[A-Z][a-z]+)+$/.test(value) ||
    /^[A-Z]+(?:_[A-Z0-9]+)*$/.test(value) ||
    (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) && value.split('.').every(part => part.length <= 24))
  )
}

/**
 * Whether a value typed after a label reads as a secret rather than prose, code or a pointer to one:
 * at least 8 characters, no reference, placeholder, URL, path or code, and mixed characters (digits
 * alone only after a password label).
 */
export function isSecretValue(value: string, label = ''): boolean {
  if (value.length < 8 || /\s/.test(value)) {
    return false
  }
  if (isReference(value) || isPlaceholder(value) || isUrl(value) || isPath(value) || isCodeLike(value)) {
    return false
  }
  if (/^\d+$/.test(value)) {
    return PASSWORD_LABEL.test(label)
  }
  return characterClasses(value) >= 2
}

/** `FOO bar-baz.qux` → `FOO_BAR_BAZ_QUX`: uppercase, `[A-Z][A-Z0-9_]*`; `''` when nothing is left. */
export function toEnvName(text: string): string {
  const name = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (name === '') {
    return ''
  }
  return /^[A-Z]/.test(name) ? name : `SECRET_${name}`
}

/** The name field as the person types it: uppercased, other characters as `_`, nothing trimmed yet. */
export function typedName(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

/** `opendatalab.com` → `opendatalab`, `api.openai.com` → `openai`; a plain word is kept. */
export function serviceOf(word: string): string {
  const parts = word.split('.').filter(Boolean)
  if (parts.length < 2) {
    return word
  }
  const core = parts.slice(0, -1).filter(part => !DOMAIN_NOISE.has(part.toLowerCase()))
  return core.at(-1) ?? parts[0] ?? word
}

/** The env var name part a label stands for: `Access Key ID` → `ACCESS_KEY_ID`. */
export function labelName(label: string): string {
  return LABEL_NAMES.find(([re]) => re.test(label))?.[1] ?? toEnvName(label)
}

/** The service word just before a label on its line (`KIT api key`, `OpenDataLab Access Key ID`), or null. */
function wordBefore(text: string, at: number): string | null {
  const lineStart = Math.max(text.lastIndexOf('\n', at - 1) + 1, at - 80)
  const match = /([A-Za-z][A-Za-z0-9.-]*[A-Za-z0-9])(?:'s)?[ \t]+$/.exec(text.slice(lineStart, at))
  const word = match?.[1]
  return word && !STOP_WORDS.has(word.toLowerCase()) ? word : null
}

/** The service a nearby "for opendatalab", "from huggingface", "on staging", "at example.com" names, or null. */
function contextWord(text: string, at: number): string | null {
  const window = text.slice(Math.max(0, at - CONTEXT_REACH), at)
  const words = [...window.matchAll(/(?<![A-Za-z0-9])(?:for|from|on|at)[ \t]+(?:(?:the|my|our|your)[ \t]+)?([A-Za-z][A-Za-z0-9.-]*[A-Za-z0-9])/gi)]
    .map(match => match[1] ?? '')
    .filter(word => word !== '' && !STOP_WORDS.has(word.toLowerCase()))
  return words.at(-1) ?? null
}

/**
 * The service prefix for a secret whose label starts at `at`: the word before the label, else the label's own
 * `for <what>`, else a "for <service>" up to 300 characters back; `''` for none.
 */
export function servicePrefix(text: string, at: number, qualifier: string | null = null): string {
  const word = wordBefore(text, at) ?? qualifier ?? contextWord(text, at)
  return word ? toEnvName(serviceOf(word)) : ''
}

/** Joins a service prefix to a name part, not repeating it: `OPENDATALAB` + `ACCESS_KEY_ID`. */
function prefixed(prefix: string, name: string): string {
  return prefix === '' || name === prefix || name.startsWith(`${prefix}_`) ? name : `${prefix}_${name}`
}

/** The ranges of fenced code blocks (``` or ~~~), each from its opening fence to its closing one or the end. */
export function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  let open: { at: number; fence: string } | null = null
  let at = 0
  for (const line of text.split('\n')) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence && open === null) {
      open = { at, fence: fence.slice(0, 3) }
    } else if (fence && open !== null && fence.startsWith(open.fence)) {
      ranges.push([open.at, at + line.length])
      open = null
    }
    at += line.length + 1
  }
  if (open !== null) {
    ranges.push([open.at, text.length])
  }
  return ranges
}

/** Quotes, a wrapping tag and trailing punctuation around a value: `"abc",` and `abc</td>` → `abc`; the trimmed offsets. */
function trimValue(text: string, start: number, end: number): [number, number] {
  let s = start
  let e = end
  for (let isTrimming = true; isTrimming; ) {
    isTrimming = false
    while (s < e && /["'`]/.test(text[s] ?? '')) {
      s += 1
    }
    const tag = /<\/?[A-Za-z][\w-]*>$/.exec(text.slice(s, e))
    if (tag && tag.index > 0) {
      e -= tag[0].length
      isTrimming = true
    }
    while (e > s && /[.,;:!?)\]}"'`]/.test(text[e - 1] ?? '')) {
      e -= 1
      isTrimming = true
    }
  }
  return [s, e]
}

/** The token around a label joined by `_` or `-` (`DB_PASSWORD`, `x-api-key`): its offsets. */
function identifierAround(text: string, start: number, end: number): [number, number] {
  let s = start
  let e = end
  while (s > 0 && /[A-Za-z0-9_-]/.test(text[s - 1] ?? '')) {
    s -= 1
  }
  while (e < text.length && /[A-Za-z0-9_-]/.test(text[e] ?? '')) {
    e += 1
  }
  return [s, e]
}

/** The value a label ending at `end` is tied to, by `:`/`=`, `is`, or the next line, with any `for <what>` between; or null. */
function valueAfter(
  text: string,
  end: number,
): { start: number; end: number; separator: Separator; qualifier: string } | null {
  const forms: [RegExp, Separator][] = [
    [SAME_LINE, 'colon'],
    [IS_FORM, 'is'],
    [NEXT_LINE, 'newline'],
  ]
  for (const [re, separator] of forms) {
    re.lastIndex = end
    const match = re.exec(text)
    const value = match?.[2]
    if (match && value !== undefined) {
      const stop = match.index + match[0].length
      return { start: stop - value.length, end: stop, separator, qualifier: match[1] ?? '' }
    }
  }
  return null
}

/** The first word of a `for the guest network` qualifier that can name a service (`guest`), or null. */
function qualifierWord(qualifier: string): string | null {
  return qualifier.split(/[ \t]+/).find(word => /^[A-Za-z][A-Za-z0-9.-]*[A-Za-z0-9]$/.test(word) && !STOP_WORDS.has(word.toLowerCase())) ?? null
}

/** Secrets typed after a label: `password: …`, `Secret Access Key\n…`, `the wifi password is …`, `DB_PASSWORD=…`. */
function labelled(text: string): Candidate[] {
  const found: Candidate[] = []
  for (const match of text.matchAll(LABEL)) {
    const label = match[1] ?? ''
    const labelStart = match.index ?? 0
    const [idStart, idEnd] = identifierAround(text, labelStart, labelStart + match[0].length)
    const identifier = text.slice(idStart, idEnd)
    const isIdentifier = identifier !== label
    if (isIdentifier) {
      const last = identifier.split(/[_-]/).at(-1)?.toLowerCase() ?? ''
      if (NOT_A_SECRET_SUFFIX.has(last) && !LABEL_NAMES.some(([re]) => re.test(last))) {
        continue
      }
    }
    const tied = valueAfter(text, idEnd)
    if (!tied) {
      continue
    }
    const [start, end] = trimValue(text, tied.start, tied.end)
    const value = text.slice(start, end)
    if (!isSecretValue(value, isIdentifier ? identifier : label)) {
      continue
    }
    if (isIdentifier) {
      const name = toEnvName(identifier)
      found.push({ kind: 'labelled', label: identifier, value, start, end, name, strength: 2, isShape: false })
      continue
    }
    const prefix = servicePrefix(text, labelStart, qualifierWord(tied.qualifier))
    const name = prefixed(prefix, labelName(label))
    found.push({ kind: 'labelled', label, value, start, end, name, strength: prefix ? 1 : 0, isShape: false })
  }
  return found
}

/** The env var a URL's password suggests: `POSTGRES_PASSWORD`, or the host's name for http(s). */
function urlPasswordName(scheme: string, host: string): string {
  const base = /^(?:https?|ftp|sftp|ssh|wss?)$/i.test(scheme) ? serviceOf(host) : scheme.replace(/ql$/i, '').replace(/\+srv$/i, '')
  return prefixed(toEnvName(base), 'PASSWORD')
}

/** Secrets of a known shape, the AWS secret beside an access key ID, and passwords inside URLs. */
function shaped(text: string): Candidate[] {
  const found: Candidate[] = []
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const value = shape.group === undefined ? match[0] : (match[shape.group] ?? '')
      const start = (match.index ?? 0) + (shape.group === undefined ? 0 : match[0].lastIndexOf(value))
      if (value === '' || isPlaceholder(value.replace(/^[A-Za-z]+[_-]/, '')) || (shape.isLoose && !isSecretValue(value))) {
        continue
      }
      found.push({ kind: shape.kind, label: shape.label, value, start, end: start + value.length, name: shape.name, strength: 0, isShape: true })
    }
  }
  for (const key of found.filter(one => one.kind === 'aws-access-key-id')) {
    const from = Math.max(0, key.start - AWS_SECRET_REACH)
    const window = text.slice(from, key.end + AWS_SECRET_REACH)
    for (const match of window.matchAll(AWS_SECRET)) {
      const value = match[0]
      const start = from + (match.index ?? 0)
      const isKey = start < key.end && start + value.length > key.start
      if (isKey || /^[0-9a-f]{40}$/i.test(value) || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || isPlaceholder(value)) {
        continue
      }
      found.push({
        kind: 'aws-secret-access-key',
        label: 'AWS secret access key',
        value,
        start,
        end: start + value.length,
        name: 'AWS_SECRET_ACCESS_KEY',
        strength: 0,
        isShape: true,
      })
    }
  }
  for (const match of text.matchAll(URL_PASSWORD)) {
    const value = match[2] ?? ''
    const start = (match.index ?? 0) + match[0].lastIndexOf(`:${value}@`) + 1
    if (!isSecretValue(value, 'password')) {
      continue
    }
    const name = urlPasswordName(match[1] ?? '', match[3] ?? '')
    found.push({ kind: 'url-password', label: 'Password in a URL', value, start, end: start + value.length, name, strength: 0, isShape: true })
  }
  return found
}

/** Matches of the person's own pattern (group 1 when it has one), named by a nearby service when one is. */
function custom(text: string, extra: RegExp): Candidate[] {
  const found: Candidate[] = []
  const pattern = new RegExp(extra.source, `${extra.flags.replace(/[gy]/g, '')}g`)
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[0]
    if (value.length < 4 || isReference(value) || isPlaceholder(value)) {
      continue
    }
    const start = (match.index ?? 0) + Math.max(0, match[0].indexOf(value))
    const prefix = servicePrefix(text, match.index ?? 0)
    const name = prefix ? `${prefix}_SECRET` : ''
    found.push({ kind: 'custom', label: 'Custom pattern', value, start, end: start + value.length, name, strength: prefix ? 1 : 0, isShape: true })
  }
  return found
}

/** One finding per stretch of text: a shape's range and kind, a label's naming when it names more. */
function merge(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const kept: Candidate[] = []
  for (const next of sorted) {
    const index = kept.findIndex(one => next.start < one.end && one.start < next.end)
    const prior = index === -1 ? undefined : kept[index]
    if (prior === undefined) {
      kept.push(next)
      continue
    }
    const shape = prior.isShape ? prior : next.isShape ? next : prior.end - prior.start >= next.end - next.start ? prior : next
    const namer = [prior, next].sort((a, b) => b.strength - a.strength)[0] ?? prior
    const isNamedByLabel = namer.strength > 0
    kept[index] = {
      ...shape,
      label: isNamedByLabel ? namer.label : shape.label,
      name: isNamedByLabel ? namer.name : shape.name || namer.name,
      strength: Math.max(prior.strength, next.strength),
    }
  }
  return kept
}

/** Unnamed findings become `SECRET_1`, `SECRET_2`, ...; a name used twice gets `_2`, `_3`. */
function nameAll(findings: Candidate[]): Finding[] {
  const used = new Set<string>()
  let unnamed = 0
  return findings.map(({ strength: _strength, isShape: _isShape, ...finding }) => {
    let base = finding.name
    if (base === '') {
      unnamed += 1
      base = `SECRET_${unnamed}`
    }
    let name = base
    for (let n = 2; used.has(name); n += 1) {
      name = `${base}_${n}`
    }
    used.add(name)
    return { ...finding, name }
  })
}

/**
 * The secrets in a prompt, in order: known shapes, values typed after a label, the person's own pattern.
 * Values in fenced code that say `EXAMPLE` are examples, not secrets.
 */
export function detect(text: string, options: DetectOptions = {}): Finding[] {
  const fences = fencedRanges(text)
  const candidates = [...shaped(text), ...labelled(text), ...(options.extra ? custom(text, options.extra) : [])]
  const real = candidates.filter(
    one => !(one.value.includes('EXAMPLE') && fences.some(([from, to]) => one.start >= from && one.end <= to)),
  )
  return nameAll(merge(real))
}

/** `…vxrm`: the last characters of a secret, never more than a fifth of it; a private key shows none. */
export function mask(value: string): string {
  if (value.startsWith('-----BEGIN')) {
    return '(key block)'
  }
  const shown = Math.min(4, Math.floor(value.length / 5))
  return shown > 0 ? `…${value.slice(-shown)}` : '…'
}

/** `Secret Access Key`, `Access Key ID and Secret Access Key`, `3 secrets`: never a value. */
export function describeFindings(labels: readonly string[]): string {
  if (labels.length === 1) {
    return `a secret (${labels[0]})`
  }
  if (labels.length === 2) {
    return `2 secrets (${labels[0]} and ${labels[1]})`
  }
  return `${labels.length} secrets`
}

/** What `/secrets test` answers: what would be caught, masked, and the names it would suggest. */
export function testReport(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'secret-guard finds no secret in that text: it would be sent as is.'
  }
  const count = findings.length === 1 ? '1 secret' : `${findings.length} secrets`
  return [
    `secret-guard would hold that prompt back: ${count}.`,
    ...findings.map(finding => `  ${finding.label} ${mask(finding.value)} → $${finding.name}`),
  ].join('\n')
}

/** Zero-width and other invisible characters, CRLF and the ends trimmed: what a refilled box sends back. */
function normalized(text: string): string {
  return text.replace(/\p{Cf}/gu, '').replace(/\r\n/g, '\n').trim()
}

/** A fingerprint of a prompt's text (two 32-bit FNV-style hashes and the length), so the text itself need not be kept. */
export function hashText(text: string): string {
  const s = normalized(text)
  let a = 0x811c9dc5
  let b = 0x9747b28c
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return `${s.length}:${a.toString(16)}:${b.toString(16)}`
}

/** True for what the engine draws when no plugin draws the band, or an empty Box. */
export function isBlankTree(tree: RenderElement): boolean {
  if (tree.type === 'engine') {
    return true
  }
  return tree.type === 'Box' && (tree.children ?? []).length === 0
}
