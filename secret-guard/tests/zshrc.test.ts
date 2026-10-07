import { expect, test } from 'claude-code/testing'

import {
  exportLine,
  exportedValue,
  planExport,
  planExports,
  readShellWord,
  replaceWithRefs,
  resolveRcPath,
  saveToast,
  shellQuote,
} from '../hooks/zshrc'

// Values are made up and built from obviously fake parts.
const VALUE = 'Fake0' + 'Secret1' + 'vxrm'
const RC = `# my shell\nexport PATH="$HOME/bin:$PATH"\nalias ll='ls -la'\n`

test('single-quote escaping survives every quote and shell character', () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  expect(exportLine('NAME', "a'b")).toBe(`export NAME='a'\\''b'`)
  for (const value of [VALUE, "a'b\"c$d`e\\f g", "''", 'line one\nline two', '$(touch /tmp/x); echo']) {
    expect(readShellWord(shellQuote(value), 0)).toBe(value)
  }
})

test('reads what a shell file exports, the last line winning, comments left out', () => {
  const rc = [
    "export A='one'",
    'export B="two \\"quoted\\" \\$x"',
    'export C=bare # trailing comment',
    "# export D='commented out'",
    "  export A='again'",
    "typeset -x E='typed'",
  ].join('\n')
  expect(exportedValue(rc, 'A')).toBe('again')
  expect(exportedValue(rc, 'B')).toBe('two "quoted" $x')
  expect(exportedValue(rc, 'C')).toBe('bare')
  expect(exportedValue(rc, 'D')).toBeUndefined()
  expect(exportedValue(rc, 'E')).toBe('typed')
  expect(exportedValue(rc, 'AB')).toBeUndefined()
})

test('appends export NAME=\'value\' when NAME is not exported, adding a missing final newline', () => {
  expect(planExport(RC, 'KIT_API_KEY', VALUE)).toEqual({
    text: `${RC}export KIT_API_KEY='${VALUE}'\n`,
    name: 'KIT_API_KEY',
    isReused: false,
  })
  expect(planExport('alias ll=ls', 'KIT_API_KEY', VALUE).text).toBe(`alias ll=ls\nexport KIT_API_KEY='${VALUE}'\n`)
  expect(planExport('', 'KIT_API_KEY', VALUE).text).toBe(`export KIT_API_KEY='${VALUE}'\n`)
})

test('reuses NAME when it already exports the same value; a different value goes to NAME_2, then NAME_3', () => {
  const saved = `${RC}export KIT_API_KEY='${VALUE}'\n`
  expect(planExport(saved, 'KIT_API_KEY', VALUE)).toEqual({ text: saved, name: 'KIT_API_KEY', isReused: true })

  const other = planExport(saved, 'KIT_API_KEY', 'Other0Value1')
  expect(other.name).toBe('KIT_API_KEY_2')
  expect(other.text).toBe(`${saved}export KIT_API_KEY_2='Other0Value1'\n`)

  const third = planExport(other.text, 'KIT_API_KEY', 'Third0Value1')
  expect(third.name).toBe('KIT_API_KEY_3')
  expect(planExport(other.text, 'KIT_API_KEY', 'Other0Value1')).toMatchObject({ name: 'KIT_API_KEY_2', isReused: true })
})

test('saves several secrets in turn, each seeing the lines before it', () => {
  const { text, plans } = planExports(RC, [
    { name: 'PASSWORD', value: 'Abc12345xyz' },
    { name: 'PASSWORD', value: 'Qwe45678rty' },
  ])
  expect(plans.map(plan => plan.name)).toEqual(['PASSWORD', 'PASSWORD_2'])
  expect(text).toBe(`${RC}export PASSWORD='Abc12345xyz'\nexport PASSWORD_2='Qwe45678rty'\n`)
})

test('finds the shell file under HOME', () => {
  expect(resolveRcPath('~/.zshrc', '/Users/me')).toBe('/Users/me/.zshrc')
  expect(resolveRcPath('~/.zshrc', '/Users/me/')).toBe('/Users/me/.zshrc')
  expect(resolveRcPath('.config/zsh/secrets.zsh', '/Users/me')).toBe('/Users/me/.config/zsh/secrets.zsh')
  expect(resolveRcPath('/opt/shared/rc', undefined)).toBe('/opt/shared/rc')
  expect(resolveRcPath('', '/Users/me')).toBe('/Users/me/.zshrc')
  expect(resolveRcPath('~/.zshrc', undefined)).toBeNull()
})

test('puts $NAME where each secret was, ${NAME} when a word character follows', () => {
  const text = `id ${VALUE} and key ${VALUE}x end`
  const first = text.indexOf(VALUE)
  const second = text.indexOf(VALUE, first + 1)
  expect(
    replaceWithRefs(
      text,
      [
        { start: first, end: first + VALUE.length },
        { start: second, end: second + VALUE.length },
      ],
      ['KIT_ID', 'KIT_KEY'],
    ),
  ).toBe('id $KIT_ID and key ${KIT_KEY}x end')
})

test('the Save toast names the variables, never their values', () => {
  expect(saveToast([{ text: '', name: 'KIT_API_KEY', isReused: false }], '~/.zshrc')).toBe(
    "Saved KIT_API_KEY to ~/.zshrc; the prompt now says $KIT_API_KEY. New shells see it (Claude can run: zsh -ic 'echo ${#KIT_API_KEY}' to check).",
  )
  expect(
    saveToast(
      [
        { text: '', name: 'A_ID', isReused: false },
        { text: '', name: 'A_KEY', isReused: false },
        { text: '', name: 'B', isReused: true },
      ],
      '~/.zshrc',
    ),
  ).toBe(
    "Saved A_ID and A_KEY to ~/.zshrc; B was already in ~/.zshrc; the prompt now says $A_ID, $A_KEY and $B. New shells see them (Claude can run: zsh -ic 'echo ${#A_ID}' to check).",
  )
})
