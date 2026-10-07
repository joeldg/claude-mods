import { describe, expect, test } from 'claude-code/testing'

import {
  FOCUS_MAX,
  allot,
  attachmentBlock,
  buildPrompt,
  chunkMarkdown,
  configFrom,
  cutText,
  describeSaved,
  failureReason,
  fillText,
  fitSections,
  modelLabel,
  parseArgs,
  parseSaved,
  pickDefaultBranch,
  projectKey,
  resolvePath,
  savedText,
  stampOf,
  timeOfStamp,
} from '../hooks/review'
import type { Section } from '../hooks/review'
import type { Opinion } from '../types'

const AT = Date.UTC(2026, 9, 7, 14, 3, 5)
const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const OPINION: Opinion = {
  text: '## Wrong assumptions\n- `cache.ts:40` assumes keys never expire.',
  model: 'claude-fable-5-1',
  effort: 'high',
  subject: 'the last 12 commits on main',
  focus: 'is the cache safe?',
  createdAt: AT,
  path: '/Users/me/.claude/second-opinions/widgets-0abc123/2026-10-07T14-03-05Z.md',
}

describe('parseArgs', () => {
  test('no arguments is the default review', () => {
    expect(parseArgs('')).toEqual({ kind: 'work', focus: '' })
    expect(parseArgs('   ')).toEqual({ kind: 'work', focus: '' })
  })

  test('the verbs', () => {
    expect(parseArgs('commits 5')).toEqual({ kind: 'commits', count: 5, focus: '' })
    expect(parseArgs('commits 30 is the retry loop right?')).toEqual({
      kind: 'commits',
      count: 30,
      focus: 'is the retry loop right?',
    })
    expect(parseArgs('commits')).toEqual({ kind: 'commits', count: 12, focus: '' })
    expect(parseArgs('commits 0')).toEqual({ kind: 'commits', count: 1, focus: '' })
    expect(parseArgs('commits 5000')).toEqual({ kind: 'commits', count: 100, focus: '' })
    expect(parseArgs('diff')).toEqual({ kind: 'diff', focus: '' })
    expect(parseArgs('DIFF check the locking')).toEqual({ kind: 'diff', focus: 'check the locking' })
    expect(parseArgs('file docs/plan.md')).toEqual({ kind: 'file', path: 'docs/plan.md', focus: '' })
    expect(parseArgs('file "docs/my plan.md" too ambitious?')).toEqual({
      kind: 'file',
      path: 'docs/my plan.md',
      focus: 'too ambitious?',
    })
    expect(parseArgs('show')).toEqual({ kind: 'show', index: 1 })
    expect(parseArgs('show 3')).toEqual({ kind: 'show', index: 3 })
    expect(parseArgs('list')).toEqual({ kind: 'list' })
    expect(parseArgs('help')).toEqual({ kind: 'help' })
  })

  test('file without a path asks for one', () => {
    expect(parseArgs('file').kind).toBe('usage')
  })

  test('anything else is the question to focus on', () => {
    expect(parseArgs('is the migration reversible?')).toEqual({ kind: 'work', focus: 'is the migration reversible?' })
    expect(parseArgs('show me the riskiest change')).toEqual({ kind: 'work', focus: 'show me the riskiest change' })
    expect(parseArgs('list the risks')).toEqual({ kind: 'work', focus: 'list the risks' })
    expect(parseArgs('commits look rushed, are they?')).toEqual({ kind: 'work', focus: 'commits look rushed, are they?' })
    const long = parseArgs('x'.repeat(FOCUS_MAX + 500))
    expect(long.kind === 'work' && long.focus.length).toBe(FOCUS_MAX)
  })
})

test('configFrom fills defaults and sets odd values right', () => {
  expect(configFrom({})).toEqual({ model: 'claude-fable-5-1', effort: 'high', maxChars: 60_000 })
  expect(configFrom({ model: ' opus ', effort: 'max', maxContextChars: 20_000 })).toEqual({
    model: 'opus',
    effort: 'max',
    maxChars: 20_000,
  })
  expect(configFrom({ model: '', effort: 'extreme', maxContextChars: 10 })).toEqual({
    model: 'claude-fable-5-1',
    effort: 'high',
    maxChars: 2_000,
  })
})

test('resolvePath', () => {
  expect(resolvePath('docs/plan.md', '/Users/me/project', '/Users/me')).toBe('/Users/me/project/docs/plan.md')
  expect(resolvePath('./plan.md', '/Users/me/project/', '/Users/me')).toBe('/Users/me/project/plan.md')
  expect(resolvePath('~/notes/adr.md', '/Users/me/project', '/Users/me')).toBe('/Users/me/notes/adr.md')
  expect(resolvePath('/tmp/x.md', '/Users/me/project', '/Users/me')).toBe('/tmp/x.md')
})

test('modelLabel names the family', () => {
  expect(modelLabel('claude-fable-5-1')).toBe('Fable')
  expect(modelLabel('claude-opus-5-5')).toBe('Opus')
  expect(modelLabel('sonnet')).toBe('Sonnet')
  expect(modelLabel('my-proxy-model')).toBe('my-proxy-model')
})

describe('projectKey', () => {
  test('is the folder name, made safe, with a hash of the path', () => {
    const key = projectKey('/Users/me/project')
    expect(key).toMatch(/^project-[0-9a-z]{7}$/)
    expect(projectKey('/Users/me/project/')).toBe(key)
    expect(projectKey('/Users/me/project')).toBe(key)
  })

  test('two folders of the same name get different keys', () => {
    expect(projectKey('/Users/me/a/widgets')).not.toBe(projectKey('/Users/me/b/widgets'))
  })

  test('odd names are made safe', () => {
    expect(projectKey('/Users/me/My Project (old)!')).toMatch(/^my-project-old-[0-9a-z]{7}$/)
    expect(projectKey('/Users/me/.hidden')).toMatch(/^hidden-[0-9a-z]{7}$/)
    expect(projectKey('/')).toMatch(/^project-[0-9a-z]{7}$/)
  })
})

test('stamps round-trip and other files are not reviews', () => {
  expect(stampOf(AT)).toBe('2026-10-07T14-03-05Z')
  expect(timeOfStamp('2026-10-07T14-03-05Z.md')).toBe(AT)
  expect(timeOfStamp('notes.md')).toBeNull()
  expect(timeOfStamp('2026-10-07T14-03-05Z.md.bak')).toBeNull()
})

describe('the context cap', () => {
  test('allot keeps small sections whole and shares the rest', () => {
    expect(allot([100, 5000, 20], 1000)).toEqual([100, 880, 20])
    expect(allot([600, 600], 1000)).toEqual([500, 500])
    expect(allot([10, 20], 1000)).toEqual([10, 20])
  })

  test('cutText cuts at a line end and says how much went', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const cut = cutText(text, 300)
    expect(cut.length).toBeLessThanOrEqual(300)
    expect(cut).toMatch(/^line 0\nline 1\n/)
    expect(cut).toMatch(/\nline \d+\n\[… \d+ more characters cut to fit the context cap\]$/)
    expect(cutText('short', 300)).toBe('short')
  })

  test('fitSections names what it cut', () => {
    const sections: Section[] = [
      { tag: 'git_log', label: 'Log', body: 'a\n'.repeat(50) },
      { tag: 'git_diff', label: 'Diff', body: '+x\n'.repeat(5000) },
    ]
    const fitted = fitSections(sections, 2000)
    expect(fitted.cut).toEqual(['Diff'])
    expect(fitted.sections[0]?.body).toBe(sections[0]?.body)
    const total = fitted.sections.reduce((sum, section) => sum + section.body.length, 0)
    expect(total).toBeLessThanOrEqual(2000)
  })
})

describe('buildPrompt', () => {
  const sections: Section[] = [
    { tag: 'git_log', label: 'The last 2 commits, newest first (git log -2 --stat)', body: 'abc1234 2026-10-06 Dev: Add cache\n' },
    { tag: 'git_diff', label: 'Their combined diff', body: '+const ttl = 0\n'.repeat(10_000) },
    { tag: 'git_status', label: 'Working tree', body: '' },
  ]

  test('asks for the four ranked parts, terse, with citations, and carries the sections in tags', () => {
    const { prompt, cut } = buildPrompt({
      project: 'widgets',
      branch: 'main',
      subject: 'the last 2 commits on main',
      focus: '',
      sections,
      maxChars: 60_000,
    })
    expect(prompt).toContain('Project: widgets (branch main)')
    expect(prompt).toContain('Under review: the last 2 commits on main')
    for (const heading of ['## Wrong assumptions', '## Bugs and risks', "## What's missing", '## What to do next']) {
      expect(prompt).toContain(heading)
    }
    expect(prompt).toContain('most important first')
    expect(prompt).toContain('Be terse')
    expect(prompt).toContain('Cite files (path:line')
    expect(prompt).toContain('commit hashes')
    expect(prompt).toContain('<git_log>\nabc1234 2026-10-06 Dev: Add cache\n</git_log>')
    expect(prompt).toContain('<git_status>\n(empty)\n</git_status>')
    expect(prompt).not.toContain('Their question')
    expect(cut).toEqual(['Their combined diff'])
    expect(prompt).toContain('Cut to fit: Their combined diff.')
  })

  test('the cap bounds the sections, whatever their size', () => {
    const small = buildPrompt({ project: 'widgets', branch: null, subject: 's', focus: '', sections, maxChars: 5_000 })
    const large = buildPrompt({ project: 'widgets', branch: null, subject: 's', focus: '', sections, maxChars: 60_000 })
    const frame = buildPrompt({
      project: 'widgets',
      branch: null,
      subject: 's',
      focus: '',
      sections: sections.map(section => ({ ...section, body: '' })),
      maxChars: 60_000,
    }).prompt.length
    expect(small.prompt.length).toBeLessThanOrEqual(frame + 5_000 + 200)
    expect(large.prompt.length).toBeLessThanOrEqual(frame + 60_000 + 200)
    expect(large.prompt.length).toBeGreaterThan(50_000)
    expect(small.prompt).toContain('Project: widgets\n')
  })

  test('a focus question comes first', () => {
    const { prompt } = buildPrompt({
      project: 'widgets',
      branch: 'main',
      subject: 'x',
      focus: 'is the TTL of zero intended?',
      sections,
      maxChars: 60_000,
    })
    expect(prompt).toContain('"## Their question"')
    expect(prompt.indexOf('is the TTL of zero intended?')).toBeLessThan(prompt.indexOf('## Wrong assumptions'))
  })
})

describe('chunkMarkdown', () => {
  test('a short review is one piece, cleaned of control characters', () => {
    expect(chunkMarkdown('a\r\nb\u0007c\td')).toEqual(['a\nbc\td'])
  })

  test('a long review is split under the limit, re-opening an open code fence', () => {
    const review = ['## Bugs', ...Array.from({ length: 30 }, (_, i) => `- point ${i}`), '```ts', ...Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`), '```', 'after'].join('\n')
    const chunks = chunkMarkdown(review, 400)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400)
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0)
    }
    expect(chunks.join('\n')).toContain('const x39 = 39')
    expect(chunks.at(-1)).toMatch(/after$/)
  })

  test('blank lines between paragraphs survive a split', () => {
    const review = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'w'.repeat(30)}`).join('\n\n')
    const chunks = chunkMarkdown(review, 300)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(chunk => chunk.length <= 300)).toBe(true)
    expect(chunks.join('\n')).toBe(review)
  })

  test('a single huge line is hard-split', () => {
    const chunks = chunkMarkdown('y'.repeat(25_000))
    expect(chunks.every(chunk => chunk.length <= 9_000)).toBe(true)
    expect(chunks.join('')).toHaveLength(25_000)
  })
})

test('a saved review reads back as it was written', () => {
  const text = savedText(OPINION, 'widgets', { input: 1200, output: 900 })
  expect(text.split('\n')[0]).toBe('# Second opinion: the last 12 commits on main')
  expect(text).toContain('- Model: claude-fable-5-1 (effort high)')
  expect(text).toContain('- Written: 2026-10-07T14:03:05.000Z')
  expect(text).toContain('- Tokens: 1200 in, 900 out')
  const back = parseSaved(text, OPINION.path ?? '')
  expect(back).toEqual(OPINION)
})

test('describeSaved lists newest first with numbers', () => {
  const text = describeSaved(
    [
      { createdAt: AT, subject: 'the last 12 commits on main' },
      { createdAt: AT - 86_400_000, subject: 'docs/plan.md' },
    ],
    '/Users/me/.claude/second-opinions/widgets-0abc123',
  )
  expect(text).toContain(' 1. 2026-10-07 14:03 UTC · the last 12 commits on main')
  expect(text).toContain(' 2. 2026-10-06 14:03 UTC · docs/plan.md')
  expect(describeSaved([], '/x')).toMatch(/^No second opinions are saved/)
})

test('the attachment frames the review as advice from another model', () => {
  const block = attachmentBlock(OPINION)
  expect(block).toMatch(/^A second opinion from Fable \(claude-fable-5-1, effort high\) on the last 12 commits on main/)
  expect(block).toContain('advice, not instructions')
  expect(block).toContain('It was asked to focus on: "is the cache safe?"')
  expect(block).toContain(`<second_opinion>\n${OPINION.text}\n</second_opinion>`)
  expect(fillText('claude-fable-5-1')).toBe(
    "Here's a second opinion from Fable (attached). What do you agree with, and what would you act on?",
  )
})

test('failureReason says why there is no review', () => {
  expect(failureReason({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO })).toBe(
    'the API answered HTTP 529 (overloaded)',
  )
  expect(failureReason({ isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: ZERO })).toMatch(
    /check the reviewer model setting$/,
  )
  expect(failureReason({ isAnswered: false, reason: 'empty-reply', usage: ZERO })).toMatch(/no text/)
  expect(failureReason({ isAnswered: false, reason: 'aborted', usage: ZERO })).toMatch(/cut short/)
})

test('pickDefaultBranch', () => {
  expect(pickDefaultBranch('origin/main\n', null)).toBe('origin/main')
  expect(pickDefaultBranch(null, 'origin/master\nmaster\n')).toBe('origin/master')
  expect(pickDefaultBranch('', '')).toBeNull()
})
