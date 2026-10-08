import { describe, expect, test } from 'claude-code/testing'

import { asHit } from '../hooks/format'
import {
  MAX_TERMS,
  askQuery,
  extractRefs,
  fileTerm,
  isStrongHit,
  relatedLine,
  relatedQuery,
  termsIn,
  undismissed,
} from '../hooks/refs'

const hit = (fields: Record<string, unknown>) =>
  asHit({
    ref: 'd1',
    session: 's1',
    projectName: 'widgets',
    title: 'Ship the retry fix',
    ts: Date.UTC(2026, 8, 25, 10),
    kind: 'prompt',
    source: 'claude',
    snippet: '',
    score: 5,
    extra: {},
    ...fields,
  })

describe('extractRefs', () => {
  test('PR and issue numbers, in the order they come', () => {
    expect(extractRefs('is #214 ready to merge?')).toEqual(['#214'])
    expect(extractRefs('PR 214 and pull request #12 and issue 7')).toEqual(['#214', '#12', '#7'])
    expect(extractRefs('see https://github.com/acme/widgets/pull/214 for context')).toEqual(['#214'])
    expect(extractRefs('(#214) and #214 again')).toEqual(['#214'])
  })

  test('ticket ids, but not standards', () => {
    expect(extractRefs('ABC-123 is blocked by OPS-7')).toEqual(['ABC-123', 'OPS-7'])
    expect(extractRefs('UTF-8 and SHA-256 and ISO-8601 and x-ABC-1')).toEqual([])
  })

  test('file paths and names with a known extension', () => {
    expect(extractRefs('the bug is in src/upload/retry.ts, see retry.ts')).toEqual(['retry.ts'])
    expect(extractRefs('look at src/index.ts and lib/utils.py')).toEqual(['src/index.ts', 'lib/utils.py'])
    expect(extractRefs('open ~/notes/nas-backup.md.')).toEqual(['nas-backup.md'])
    expect(fileTerm('package.json')).toBeNull()
    expect(fileTerm('node.js')).toBeNull()
    expect(fileTerm('./a/b/README.md')).toBe('b/README.md')
  })

  test('backticked identifiers and quoted phrases', () => {
    expect(extractRefs('run `parseArgs` and `modal deploy` then `ls`')).toEqual(['parseArgs', 'modal deploy'])
    expect(extractRefs('we said "merged 213, go ahead" and “ship it Friday”')).toEqual(['merged 213, go ahead', 'ship it Friday'])
  })

  test('common words, prose numbers, versions, URLs and pasted code are not references', () => {
    expect(extractRefs('can you fix the tests and add a file?')).toEqual([])
    expect(extractRefs('"the" and "it is" and `true` and `null`')).toEqual([])
    expect(extractRefs('#1 priority: e.g. v1.2.3 at page#123 or &#123; next.js package.json')).toEqual([])
    expect(extractRefs('see https://example.com/a/b.html')).toEqual([])
    expect(extractRefs('```\nconst x = "pasted thing"\nload("config.yaml")\n```\nonly #99 here')).toEqual(['#99'])
  })

  test('at most four, the strongest first', () => {
    expect(extractRefs('"quoted words here" `someIdent` retry.ts ABC-1 #11 #22 #33')).toEqual(['#11', '#22', '#33', 'ABC-1'])
    expect(extractRefs('#11 #22 #33 #44 #55')).toHaveLength(MAX_TERMS)
  })
})

describe('the related search', () => {
  test('dismissed terms stay out; the query ORs phrases', () => {
    expect(undismissed(['#214', 'retry.ts'], ['#214'])).toEqual(['retry.ts'])
    expect(undismissed(['ABC-1'], ['abc-1'])).toEqual([])
    expect(relatedQuery(['#214', 'say "hi"'])).toBe('"#214" OR "say hi"')
  })

  test('a strong hit names the number, or every word of the term', () => {
    expect(isStrongHit(['#214'], hit({ kind: 'pr', snippet: 'PR [[#214]]: Retry uploads', extra: { number: 214 } }))).toBe(true)
    expect(isStrongHit(['#214'], hit({ snippet: 'merged 213, go ahead with [[#214]]' }))).toBe(true)
    expect(isStrongHit(['#214'], hit({ snippet: 'see PR 214 for that' }))).toBe(true)
    expect(isStrongHit(['#214'], hit({ snippet: 'the error is on line [[214]]' }))).toBe(false)
    expect(isStrongHit(['#214'], hit({ snippet: 'merged #214', score: 0.05 }))).toBe(false)
    expect(isStrongHit(['retry.ts'], hit({ snippet: 'edited src/[[retry]].[[ts]]' }))).toBe(true)
    expect(isStrongHit(['retry.ts'], hit({ snippet: 'retry later', title: '' }))).toBe(false)
    expect(termsIn(['#214', 'ABC-9'], [hit({ snippet: 'about #214' })])).toEqual(['#214'])
  })

  test('the band line', () => {
    const hits = [hit({ snippet: 'merged 213, go ahead with [[#214]]' }), hit({ ref: 'd2' })]
    expect(relatedLine(['#214'], hits, 3)).toEqual({
      lead: 'Past sessions mention #214: Sep 25',
      quote: ' "merged 213, go ahead with #214"',
      more: ' (+2 more)',
    })
    expect(relatedLine(['#214'], hits.slice(0, 1), 1).more).toBe('')
  })
})

describe('askQuery', () => {
  test('a question becomes its telling words, OR’d', () => {
    expect(askQuery('what did we decide about retries in the upload worker?')).toBe('retries OR upload OR worker')
    expect(askQuery('where did we put the NAS file "backup plan" for #214?')).toBe('"#214" OR "backup plan" OR nas')
    expect(askQuery('what did we do?')).toBe('what did we do?')
  })
})
