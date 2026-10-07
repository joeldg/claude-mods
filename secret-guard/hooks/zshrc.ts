/** A value in single quotes for zsh: every `'` closed, escaped and reopened (`it's` → `'it'\''s'`). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The line Save appends: `export NAME='value'`. */
export function exportLine(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`
}

/**
 * One shell word from `at`, its quoting undone: `'…'` as written, `"…"` with `\"`, `\\`, `\$` and
 * `` \` `` unescaped, a bare `\x` as `x`; it ends at unquoted whitespace, `;`, `&` or `|`.
 */
export function readShellWord(text: string, at: number): string {
  let out = ''
  let i = at
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      out += close === -1 ? text.slice(i + 1) : text.slice(i + 1, close)
      i = close === -1 ? text.length : close + 1
    } else if (c === '"') {
      i += 1
      while (i < text.length && text[i] !== '"') {
        const d = text[i] ?? ''
        const after = text[i + 1] ?? ''
        if (d === '\\' && '"\\$`\n'.includes(after) && after !== '') {
          out += after === '\n' ? '' : after
          i += 2
        } else {
          out += d
          i += 1
        }
      }
      i += 1
    } else if (c === '\\') {
      const after = text[i + 1] ?? ''
      out += after === '\n' ? '' : after
      i += 2
    } else if (/[\s;&|]/.test(c)) {
      break
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/** The value `export NAME=…` gives NAME in a shell file (the last such line wins), or undefined when none does. */
export function exportedValue(rc: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`^[ \\t]*(?:export|typeset[ \\t]+-x|declare[ \\t]+-x)[ \\t]+${escaped}=`, 'gm')
  let value: string | undefined
  for (const match of rc.matchAll(line)) {
    value = readShellWord(rc, (match.index ?? 0) + match[0].length)
  }
  return value
}

/** What saving one secret does to the shell file: its new text, the name used, and whether it was there already. */
export type ExportPlan = { text: string; name: string; isReused: boolean }

/**
 * Saves `value` as `name` in the shell file's text: reused when `name` already exports that value,
 * appended as `export NAME='value'` when `name` is not exported, and as `NAME_2` (`_3`, …) when `name`
 * already holds a different value.
 */
export function planExport(rc: string, name: string, value: string): ExportPlan {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? name : `${name}_${n}`
    const existing = exportedValue(rc, candidate)
    if (existing === value) {
      return { text: rc, name: candidate, isReused: true }
    }
    if (existing === undefined) {
      const lead = rc === '' || rc.endsWith('\n') ? rc : `${rc}\n`
      return { text: `${lead}${exportLine(candidate, value)}\n`, name: candidate, isReused: false }
    }
  }
  throw new Error(`${name} and its _2 to _99 are all taken in the shell file`)
}

/** Several secrets saved in turn: the final text, and the name each one ended up under. */
export function planExports(rc: string, secrets: readonly { name: string; value: string }[]): { text: string; plans: ExportPlan[] } {
  let text = rc
  const plans: ExportPlan[] = []
  for (const secret of secrets) {
    const plan = planExport(text, secret.name, secret.value)
    text = plan.text
    plans.push(plan)
  }
  return { text, plans }
}

/** The shell file's absolute path: `~` and a relative path are under HOME; null when HOME is needed and unset. */
export function resolveRcPath(configured: string, home: string | undefined): string | null {
  const path = configured.trim() || '~/.zshrc'
  if (path.startsWith('/')) {
    return path
  }
  if (!home) {
    return null
  }
  const base = home.replace(/\/+$/, '')
  if (path === '~') {
    return base
  }
  return path.startsWith('~/') ? `${base}/${path.slice(2)}` : `${base}/${path}`
}

/** The prompt with each secret replaced by `$NAME` (`${NAME}` when a word character follows). */
export function replaceWithRefs(text: string, spans: readonly { start: number; end: number }[], names: readonly string[]): string {
  const order = spans.map((span, index) => ({ ...span, name: names[index] ?? '' })).sort((a, b) => b.start - a.start)
  let out = text
  for (const { start, end, name } of order) {
    const ref = /[A-Za-z0-9_]/.test(out[end] ?? '') ? `\${${name}}` : `$${name}`
    out = out.slice(0, start) + ref + out.slice(end)
  }
  return out
}

/** `A`, `A and B`, `A, B and C`. */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * The toast after Save: what was saved or already there, what the prompt now says, and how to check.
 * Names only, never a value.
 */
export function saveToast(plans: readonly ExportPlan[], where: string): string {
  const saved = plans.filter(plan => !plan.isReused).map(plan => plan.name)
  const reused = plans.filter(plan => plan.isReused).map(plan => plan.name)
  const names = plans.map(plan => plan.name)
  const parts = [
    ...(saved.length > 0 ? [`Saved ${listed(saved)} to ${where}`] : []),
    ...(reused.length > 0 ? [`${listed(reused)} ${reused.length === 1 ? 'was' : 'were'} already in ${where}`] : []),
  ]
  const first = names[0] ?? 'NAME'
  return (
    `${parts.join('; ')}; the prompt now says ${listed(names.map(name => `$${name}`))}. ` +
    `New shells see ${names.length === 1 ? 'it' : 'them'} (Claude can run: zsh -ic 'echo \${#${first}}' to check).`
  )
}
