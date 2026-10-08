import { describe, expect, test } from 'claude-code/testing'

import { ageText, basename, clip, commandKey, countText, dirCategory, firstLine, homeRelative, keep, mask, msText } from '../hooks/mask'

/** Token-shaped strings are put together at run time, so no file holds one whole. */
const piece = (...parts: string[]) => parts.join('')

describe('mask', () => {
  test('replaces every known token shape', () => {
    const secrets = [
      piece('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
      piece('AS', 'IA', 'QRSTUVWXYZ234567'),
      piece('gh', 'p_', 'a1'.repeat(18)),
      piece('gh', 's_', 'b2'.repeat(18)),
      piece('gh', 'o_', 'c3'.repeat(18)),
      piece('github', '_pat_', '11ABCDEFG0', 'x'.repeat(30)),
      piece('sk', '-ant-', 'api03-', 'Z'.repeat(40)),
      piece('sk', '-', 'proj-', 'q'.repeat(40)),
      piece('xo', 'xb-', '1234567890-abcdefghij'),
      piece('xo', 'xp-', '0987654321-zyxwvutsrq'),
      piece('AI', 'za', 'S'.repeat(35)),
      piece('hf', '_', 'H'.repeat(34)),
      piece('gl', 'pat-', 'G'.repeat(20)),
      piece('np', 'm_', 'N'.repeat(36)),
    ]
    for (const secret of secrets) {
      const out = mask(`it printed ${secret} and went on`)
      expect(out).toBe('it printed [masked] and went on')
    }
  })

  test('masks a PEM block, a bearer token, labelled passwords, assignments and URL passwords', () => {
    const pem = piece('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----')
    expect(mask(`key: ${pem} done`)).toBe('key: [masked] done')
    expect(mask(piece('Authorization: Bearer ', 'abcdefghijklmnop.123'))).toBe('Authorization: Bearer [masked]')
    expect(mask('login failed, password: hunter22 was wrong')).toBe('login failed, password: [masked] was wrong')
    expect(mask('{"passwd": "two words"}')).toBe('{"passwd": [masked]}')
    expect(mask(piece('export API_KEY=', 'abc123def'))).toBe('export API_KEY=[masked]')
    expect(mask(piece('GET /x?token=', 'abc&page=2'))).toBe('GET /x?token=[masked]&page=2')
    expect(mask(piece('https://deploy:', 'pw1234@git.example.com/repo'))).toBe('https://deploy:[masked]@git.example.com/repo')
  })

  test('leaves the narration mods toast alone', () => {
    const ordinary = [
      '#219 merged → main, branch deleted',
      'CI failed on #12: lint, test',
      'secret-guard held your prompt back: it looks like it holds an AWS access key ID.',
      'model calls 3 — 1,234 in / 56 out tokens',
      'Memory critical: 4% free, swap 9/10 GB.',
      'sk-short is not a key',
    ]
    for (const text of ordinary) {
      expect(mask(text)).toBe(text)
    }
  })
})

describe('text helpers', () => {
  test('clip and keep flatten and cut', () => {
    expect(clip('a\n  b\tc', 10)).toBe('a b c')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
    expect(keep(piece('token=', 'abcdef ', 'x'.repeat(200)), 20)).toBe('token=[masked] xxxx…')
  })

  test('firstLine skips blank lines', () => {
    expect(firstLine('\n\n  error: no such file \nmore')).toBe('error: no such file')
    expect(firstLine('')).toBe('')
  })

  test('paths are named home-relative, by folder', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt')
    expect(basename('/a/b/')).toBe('b')
    expect(homeRelative('/Users/me/.claude/x', '/Users/me')).toBe('~/.claude/x')
    expect(homeRelative('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
    expect(homeRelative('/tmp/x', null)).toBe('/tmp/x')
    expect(dirCategory('/Users/me/.claude/recall/index.db', '/Users/me')).toBe('~/.claude/recall')
    expect(dirCategory('notes/today.md', '/Users/me')).toBe('./notes')
    expect(dirCategory('today.md', '/Users/me')).toBe('.')
    expect(dirCategory('/x.txt', '/Users/me')).toBe('/')
  })

  test('a command is named by its program and first argument that is no flag', () => {
    expect(commandKey(['gh', 'pr', 'view', '219', '--json', 'state'])).toBe('gh pr')
    expect(commandKey(['/usr/bin/python3', '-u', '/Users/me/mods/recall/engine/recall.py', 'search'])).toBe('python3 recall.py')
    expect(commandKey(['ps', '-axo', 'rss=,comm='])).toBe('ps rss=,comm=')
    expect(commandKey(['df', '-k'])).toBe('df')
  })

  test('ages, durations and counts read short', () => {
    expect(ageText(2_000)).toBe('now')
    expect(ageText(40_000)).toBe('40s')
    expect(ageText(12 * 60_000)).toBe('12m')
    expect(ageText(3 * 3_600_000)).toBe('3h')
    expect(ageText(3 * 86_400_000)).toBe('3d')
    expect(msText(0.4)).toBe('<1 ms')
    expect(msText(840)).toBe('840 ms')
    expect(msText(2_430)).toBe('2.4 s')
    expect(msText(42_000)).toBe('42 s')
    expect(msText(186_000)).toBe('3.1 min')
    expect(countText(1234567)).toBe('1,234,567')
    expect(countText(999)).toBe('999')
  })
})
