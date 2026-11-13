import { expect, test } from 'claude-code/testing'

import type { DocsFinding, DocsPlanItem } from '../types'
import {
  MAX_PROMPT_CHARS,
  applyPlanItem,
  buildPlanPrompt,
  buildRollupPrompt,
  contextNote,
  describeFindings,
  parseArgs,
  parsePlan,
  rollupPath,
  sectionRange,
} from '../hooks/plan'
import { NOW, README } from './world'

const FACTS = { repo: 'widgets', defaultBranch: 'main', folders: ['docs', 'scripts', 'src'], commits: ['Add import v2', 'Fix the loader'] }

const DEAD: DocsFinding = {
  file: 'README.md',
  line: 3,
  kind: 'dead-reference',
  text: 'references scripts/build_data.sh, which no longer exists',
  suggestion: 'Point it at the current path or remove the reference.',
}
const DUP: DocsFinding = {
  file: 'README.md',
  line: 9,
  kind: 'duplicate-paragraph',
  text: 'the "Known issues" paragraph duplicates docs/runbook.md:7',
  suggestion: 'Keep one copy and link to it from the other.',
}
const STALE: DocsFinding = {
  file: 'README.md',
  line: 14,
  kind: 'stale-marker',
  text: 'TODO open for 45 days: - TODO: document the retry policy',
  suggestion: 'Do it and record the outcome, or drop the line.',
}

const item = (section: string, verdict: DocsPlanItem['verdict'], replacement: string | null = null, anchor: string | null = null): DocsPlanItem => ({
  section,
  verdict,
  reason: 'because',
  replacement,
  anchor,
})

const LINES = README.split('\n')

test('parseArgs reads the /garden forms', async () => {
  expect(parseArgs('')).toEqual({ kind: 'help' })
  expect(parseArgs('help')).toEqual({ kind: 'help' })
  expect(parseArgs('audit')).toEqual({ kind: 'audit', path: null, isChanged: false, isApply: false })
  expect(parseArgs('audit --changed --apply')).toEqual({ kind: 'audit', path: null, isChanged: true, isApply: true })
  expect(parseArgs('audit docs/ --apply')).toEqual({ kind: 'audit', path: 'docs/', isChanged: false, isApply: true })
  expect(parseArgs('audit --bogus')).toMatchObject({ kind: 'usage' })
  expect(parseArgs('audit a b')).toMatchObject({ kind: 'usage' })
  expect(parseArgs('show')).toEqual({ kind: 'show' })
  expect(parseArgs('check README.md')).toEqual({ kind: 'check', path: 'README.md' })
  expect(parseArgs('check')).toMatchObject({ kind: 'usage' })
  expect(parseArgs('prune')).toMatchObject({ kind: 'usage' })
})

test('sectionRange finds a heading section, a line range, a single line and the whole file', async () => {
  expect(sectionRange(LINES, 'Known issues')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, '## known issues')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, '"Known issues"')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, 'Tasks')).toEqual({ start: 10, end: 13 })
  expect(sectionRange(LINES, 'Widgets')).toEqual({ start: 0, end: 13 })
  expect(sectionRange(LINES, '7-9')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, 'L7-L9')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, 'lines 7 to 9')).toEqual({ start: 6, end: 8 })
  expect(sectionRange(LINES, '14')).toEqual({ start: 13, end: 13 })
  expect(sectionRange(LINES, 'line 14')).toEqual({ start: 13, end: 13 })
  expect(sectionRange(LINES, '9-99')).toEqual({ start: 8, end: 13 })
  expect(sectionRange(LINES, 'whole file')).toEqual({ start: 0, end: 13 })
  expect(sectionRange(LINES, 'Nowhere')).toBeNull()
  expect(sectionRange(LINES, '0-3')).toBeNull()
  // A nested heading's section ends at the next heading of its level or above.
  const nested = ['# A', 'a', '## B', 'b', '### C', 'c', '## D', 'd', '# E'].map(line => line)
  expect(sectionRange(nested, 'B')).toEqual({ start: 2, end: 5 })
  expect(sectionRange(nested, 'C')).toEqual({ start: 4, end: 5 })
  expect(sectionRange(nested, 'A')).toEqual({ start: 0, end: 7 })
})

test('parsePlan keeps the well-formed items and anchors each to its first line', async () => {
  const reply = [
    'Sure, here is the plan:',
    '```json',
    JSON.stringify([
      { section: 'Known issues', verdict: 'duplicate', reason: 'kept once in docs/runbook.md', replacement: null },
      { section: '14-14', verdict: 'stray', reason: 'a 45-day-old TODO', replacement: null },
      { section: 'Tasks', verdict: 'current', reason: 'still open', replacement: null },
      { nonsense: 1 },
      { section: 'Nowhere', verdict: 'delete', reason: 'x', replacement: null },
      { section: 'Tasks', verdict: 'bogus', reason: 'x', replacement: null },
      { section: 'Known issues', verdict: 'update', reason: 'a second item for the same section', replacement: 'x' },
      { section: 'Widgets', verdict: 'update', reason: 'an update with nothing to put', replacement: null },
      { section: 'Widgets', verdict: 'rollup', reason: 'not for a doc', replacement: 'x' },
      'a string',
      null,
    ]),
    '```',
    'Done.',
  ].join('\n')
  const plan = parsePlan(reply, LINES, false)
  expect(plan.isPlan).toBe(true)
  expect(plan.items).toEqual([
    { section: 'Known issues', verdict: 'duplicate', reason: 'kept once in docs/runbook.md', replacement: null, anchor: '## Known issues' },
    { section: '14-14', verdict: 'stray', reason: 'a 45-day-old TODO', replacement: null, anchor: '- TODO: document the retry policy' },
    { section: 'Tasks', verdict: 'current', reason: 'still open', replacement: null, anchor: '## Tasks' },
  ])
  expect(parsePlan('not json at all', LINES, false)).toEqual({ isPlan: false, items: [] })
  expect(parsePlan('{"section": "Tasks"}', LINES, false)).toEqual({ isPlan: false, items: [] })
  expect(parsePlan('[]', LINES, false)).toEqual({ isPlan: true, items: [] })
  // A series takes a roll-up (or nothing), never a section edit.
  const series = parsePlan(
    JSON.stringify([
      { section: 'ROLLUP', verdict: 'rollup', reason: '12 dailies', replacement: '# Digests\n\nAll quiet.' },
      { section: 'Digest', verdict: 'delete', reason: 'no', replacement: null },
    ]),
    [],
    true,
  )
  expect(series.items).toEqual([{ section: 'ROLLUP', verdict: 'rollup', reason: '12 dailies', replacement: '# Digests\n\nAll quiet.', anchor: null }])
})

test('applyPlanItem deletes a heading section and closes the gap', async () => {
  const out = applyPlanItem('README.md', README, item('Known issues', 'duplicate', null, '## Known issues'))
  if ('error' in out) {
    throw new Error(out.error)
  }
  expect(out.text).toBe(
    [
      '# Widgets',
      '',
      'Build the data with `scripts/build_data.sh`, then run `scripts/run_tests.sh`.',
      'Deploy with `make deploy`; lint with `make lint`.',
      'The loader calls `parse_config` and then `load_widgets` for each entry.',
      '',
      '## Tasks',
      '',
      '- [ ] Move the fixtures next to the tests',
      '- TODO: document the retry policy',
      '',
    ].join('\n'),
  )
  expect(out.diff).toBe(['@@ README.md:7-9 (duplicate)', '-## Known issues', '-', `-${README.split('\n')[8]}`].join('\n'))
})

test('applyPlanItem rewrites a section in place, keeping the heading when the replacement has none', async () => {
  const text = '# Old design\n\nThe loader in `src/config.py` reads the widgets table once at start.\n'
  const whole = applyPlanItem('docs/old-design.md', text, item('Old design', 'update', '# Old design\n\nThe loader reads the table lazily.\n'))
  expect('text' in whole && whole.text).toBe('# Old design\n\nThe loader reads the table lazily.\n')
  const body = applyPlanItem('docs/old-design.md', text, item('Old design', 'update', 'The loader reads the table lazily.'))
  expect('text' in body && body.text).toBe('# Old design\nThe loader reads the table lazily.\n')
  const range = applyPlanItem('docs/old-design.md', text, item('3-3', 'update', 'Lazily.', 'The loader in `src/config.py` reads the widgets table once at start.'))
  expect('text' in range && range.text).toBe('# Old design\n\nLazily.\n')
  expect('diff' in range && range.diff).toBe('@@ docs/old-design.md:3-3 (update)\n-The loader in `src/config.py` reads the widgets table once at start.\n+Lazily.')
})

test('applyPlanItem finds a line range again by its anchor once earlier edits moved it, and refuses what it cannot find', async () => {
  const deleted = applyPlanItem('README.md', README, item('Known issues', 'delete', null, '## Known issues'))
  const moved = 'text' in deleted ? deleted.text : ''
  const stray = applyPlanItem('README.md', moved, item('14-14', 'stray', null, '- TODO: document the retry policy'))
  expect('text' in stray && stray.text.includes('TODO')).toBe(false)
  expect('text' in stray && stray.text.endsWith('- [ ] Move the fixtures next to the tests\n')).toBe(true)
  expect(applyPlanItem('README.md', moved, item('14-14', 'stray', null, 'a line that is gone'))).toEqual({
    error: 'line 14 no longer reads "a line that is gone", and no line does',
  })
  expect(applyPlanItem('README.md', moved, item('Nowhere', 'delete'))).toEqual({ error: 'the section "Nowhere" was not found' })
  expect(applyPlanItem('README.md', moved, item('Tasks', 'update', null))).toEqual({ error: 'an update with no replacement text' })
})

test('the roll-up path and the context note', async () => {
  expect(rollupPath('docs/digests/', NOW)).toBe('docs/digests/ROLLUP-2026-42.md')
  expect(rollupPath('./', NOW)).toBe('ROLLUP-2026-42.md')
  expect(contextNote('README.md', [DEAD, DUP, STALE], 30)).toBe(
    'docs-gardener: README.md references scripts/build_data.sh, which no longer exists (line 3); the "Known issues" paragraph duplicates docs/runbook.md:7; 1 TODO is older than 30 days.',
  )
  expect(contextNote('README.md', [STALE, { ...STALE, line: 15, text: 'FIXME open for 40 days: FIXME' }, { ...STALE, line: 16 }], 30)).toBe(
    'docs-gardener: README.md 3 stale markers are older than 30 days.',
  )
  expect(contextNote('README.md', [STALE, { ...STALE, line: 16 }], 30)).toBe('docs-gardener: README.md 2 TODOs are older than 30 days.')
  expect(contextNote('README.md', [], 30)).toBeNull()
  // Whole-file findings are not for the write-time note.
  expect(contextNote('docs/big.md', [{ file: 'docs/big.md', line: 0, kind: 'oversized', text: '450 lines', suggestion: 'x' }], 30)).toBeNull()
  const many = Array.from({ length: 9 }, (_, i) => ({ ...DEAD, line: i + 1, text: `references missing_${i}.sh, which no longer exists` }))
  expect(contextNote('README.md', many, 30)?.endsWith('; and 3 more.')).toBe(true)
})

test('describeFindings groups by file for a folder and lists plainly for one file', async () => {
  expect(describeFindings([], 'README.md')).toBe('docs-gardener: nothing to fix in README.md.')
  expect(describeFindings([DEAD, STALE], 'README.md')).toBe(
    [
      'docs-gardener: 2 findings in README.md',
      '  L3 dead-reference: references scripts/build_data.sh, which no longer exists — Point it at the current path or remove the reference.',
      '  L14 stale-marker: TODO open for 45 days: - TODO: document the retry policy — Do it and record the outcome, or drop the line.',
    ].join('\n'),
  )
  const series: DocsFinding = { file: 'docs/digests/', line: 0, kind: 'dated-series', text: '12 dated files, a to b', suggestion: 'Roll them up.' }
  expect(describeFindings([DEAD, series], 'docs/')).toBe(
    [
      'docs-gardener: 2 findings in docs/',
      'README.md',
      '  L3 dead-reference: references scripts/build_data.sh, which no longer exists — Point it at the current path or remove the reference.',
      'docs/digests/',
      '  dated-series: 12 dated files, a to b — Roll them up.',
    ].join('\n'),
  )
})

test('the prompts carry the fact sheet, the findings and the numbered file, and ask for JSON', async () => {
  const prompt = buildPlanPrompt('README.md', README, [DEAD, STALE], FACTS)
  expect(prompt).toContain('File: README.md')
  expect(prompt).toContain('Repository: widgets')
  expect(prompt).toContain('Default branch: main')
  expect(prompt).toContain('Top-level folders: docs, scripts, src')
  expect(prompt).toContain('- Add import v2')
  expect(prompt).toContain('line 3: dead-reference: references scripts/build_data.sh, which no longer exists')
  expect(prompt).toContain('line 14: stale-marker: TODO open for 45 days')
  expect(prompt).toContain('3| Build the data with `scripts/build_data.sh`')
  expect(prompt).toContain('docs/archive/')
  expect(prompt).toContain('"verdict": "current|update|stray|duplicate|delete"')
  expect(prompt).toMatch(/JSON array only/)
  const long = buildPlanPrompt('a.md', 'x'.repeat(MAX_PROMPT_CHARS + 5_000), [], FACTS)
  expect(long.length).toBeLessThan(MAX_PROMPT_CHARS + 3_000)
  expect(long).toContain('characters cut')
  const rollup = buildRollupPrompt('docs/digests/', [{ file: 'docs/digests/2026-10-01.md', text: '# Digest\n\nQuiet.\n' }], FACTS, 'docs/digests/ROLLUP-2026-42.md')
  expect(rollup).toContain('Folder: docs/digests/')
  expect(rollup).toContain('docs/digests/ROLLUP-2026-42.md')
  expect(rollup).toContain('"verdict": "rollup"')
  expect(rollup).toContain('--- docs/digests/2026-10-01.md ---')
})
