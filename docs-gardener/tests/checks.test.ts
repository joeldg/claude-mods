import { expect, test } from 'claude-code/testing'

import {
  MAX_LOOKUPS,
  datedSeries,
  deadReferences,
  duplicateParagraphs,
  findReferences,
  finishedPlan,
  linkTargets,
  makeTargets,
  orphanCandidates,
  orphanFinding,
  oversized,
  paragraphs,
  parseBlame,
  staleMarkers,
} from '../hooks/checks'
import type { Doc } from '../hooks/checks'
import { DAY, DIGEST_DAYS, NOW, PARAGRAPH, README, RUNBOOK } from './world'

const readme: Doc = { file: 'README.md', text: README }
const runbook: Doc = { file: 'docs/runbook.md', text: RUNBOOK }

/** Lookups over a small repo: what exists, what the code names, the Makefile's targets. */
const lookups = (exists: string[], inCode: string[], targets: string[] | null, calls: string[] = []) => ({
  exists: async (rel: string) => {
    calls.push(`exists ${rel}`)
    return exists.includes(rel)
  },
  inCode: async (ident: string) => {
    calls.push(`code ${ident}`)
    return inCode.includes(ident)
  },
  makeTargets: targets === null ? null : new Set(targets),
})

test('findReferences: paths, make targets and identifiers out of inline code, fenced code skipped', async () => {
  const text = [
    'Run `scripts/build.sh` or `./scripts/run.sh`, read `docs/guide.md#setup` and `src/a.ts:12`.',
    'Use `make deploy` and `make lint`; call `parse_config`, `loadWidgets` and `MAX_RETRIES`.',
    'Not references: `foo`, `short`, `README`, `https://example.com/x.md`, `--flag`, `1.2.3`, `v1.2`, `e.g.`, `i.e`,',
    '`obj.method()`, `{name}.md`, `*.md`, `$HOME/x`, `@scope/pkg`, `example.com`, `a b/c`, `/servers`, `/guard pause 15m`.',
    '```',
    'inside `fenced/code.sh` nothing counts',
    '```',
    'Again `scripts/build.sh` (a repeat).',
  ].join('\n')
  expect(findReferences(text)).toEqual([
    { kind: 'path', token: 'scripts/build.sh', line: 1 },
    { kind: 'path', token: './scripts/run.sh', line: 1 },
    { kind: 'path', token: 'docs/guide.md', line: 1 },
    { kind: 'path', token: 'src/a.ts', line: 1 },
    { kind: 'make', token: 'deploy', line: 2 },
    { kind: 'make', token: 'lint', line: 2 },
    { kind: 'identifier', token: 'parse_config', line: 2 },
    { kind: 'identifier', token: 'loadWidgets', line: 2 },
    { kind: 'identifier', token: 'MAX_RETRIES', line: 2 },
  ])
})

test('dead-reference: a missing path, a missing make target and an identifier the code does not have', async () => {
  const calls: string[] = []
  const found = await deadReferences(readme, lookups(['scripts', 'scripts/run_tests.sh', 'Makefile'], ['parse_config'], ['deploy', 'test'], calls))
  expect(found).toEqual([
    {
      file: 'README.md',
      line: 3,
      kind: 'dead-reference',
      text: 'references scripts/build_data.sh, which no longer exists',
      suggestion: 'Point it at the current path or remove the reference.',
    },
    {
      file: 'README.md',
      line: 4,
      kind: 'dead-reference',
      text: 'runs make lint, which the Makefile has no target for',
      suggestion: 'Name a current make target or remove it.',
    },
    {
      file: 'README.md',
      line: 5,
      kind: 'dead-reference',
      text: 'names load_widgets, which is not found in the code',
      suggestion: 'Rename it to what the code calls it now, or remove it.',
    },
  ])
  expect(calls).toContain('exists scripts/build_data.sh')
  expect(calls).toContain('code load_widgets')
})

test('dead-reference: a path is tried from the root and from the doc folder; no Makefile fails every make target', async () => {
  const doc: Doc = { file: 'docs/guide.md', text: 'Tests: `../scripts/run_tests.sh`, data in `data/` and `make deploy`.\n' }
  const found = await deadReferences(doc, lookups(['scripts/run_tests.sh', 'docs/data'], [], null))
  expect(found).toEqual([
    {
      file: 'docs/guide.md',
      line: 1,
      kind: 'dead-reference',
      text: 'runs make deploy, which the Makefile has no target for',
      suggestion: 'Name a current make target or remove it.',
    },
  ])
})

test('dead-reference: a bare file name or a path into a folder not here is never dead; a missing file under a folder here is', async () => {
  const doc: Doc = {
    file: 'docs/guide.md',
    text: 'Keep `package.json` and `.claude/launch.json`; run `scripts/x.sh`, `../scripts/y.sh`, `./z.sh` and `/servers`.\n',
  }
  const calls: string[] = []
  const found = await deadReferences(doc, lookups(['scripts', 'docs', 'scripts/run_tests.sh'], [], null, calls))
  expect(found.map(one => `${one.line} ${one.text}`)).toEqual([
    '1 references scripts/x.sh, which no longer exists',
    '1 references ../scripts/y.sh, which no longer exists',
    '1 references ./z.sh, which no longer exists',
  ])
  // A bare name is never looked up; a folder is, and `.claude/` not being here clears its file.
  expect(calls.filter(call => call.includes('package.json'))).toEqual([])
  expect(calls).toContain('exists .claude')
})

test('dead-reference: at most 40 lookups per file, the first ones', async () => {
  const idents = Array.from({ length: 45 }, (_, i) => `missing_ident_${i}`)
  const doc: Doc = { file: 'a.md', text: idents.map(ident => `\`${ident}\``).join(' ') }
  const calls: string[] = []
  const found = await deadReferences(doc, lookups([], [], ['x'], calls))
  expect(MAX_LOOKUPS).toBe(40)
  expect(calls).toHaveLength(40)
  expect(found).toHaveLength(40)
  expect(found.at(-1)?.text).toBe('names missing_ident_39, which is not found in the code')
})

test('makeTargets reads a Makefile', async () => {
  expect([...makeTargets('deploy:\n\techo deploy\n\n.PHONY: deploy test\ntest lint: deps\n\techo test\nVAR := 1\n')]).toEqual([
    'deploy',
    'test',
    'lint',
  ])
})

test('parseBlame: the commit time per line, null for a line not committed yet', async () => {
  const porcelain = [
    `${'a'.repeat(40)} 1 1 1`,
    'author Dev',
    'author-time 1700000000',
    'summary x',
    '\t# Title',
    `${'0'.repeat(40)} 2 2 1`,
    'author Not Committed Yet',
    'author-time 1760000000',
    'summary y',
    '\tnew line',
  ].join('\n')
  const ages = parseBlame(porcelain)
  expect(ages.get(1)).toBe(1_700_000_000_000)
  expect(ages.get(2)).toBeNull()
})

test('stale-marker: a TODO older than staleDays, not a fresh unchecked item nor an uncommitted FIXME', async () => {
  const doc: Doc = { file: 'README.md', text: ['- [ ] fresh item', '- TODO: document the retry policy', 'FIXME: new', 'TBD', ''].join('\n') }
  const committedAt = (line: number) => (line === 1 ? NOW - 3 * DAY : line === 2 ? NOW - 45 * DAY : line === 3 ? null : NOW - 400 * DAY)
  expect(staleMarkers(doc, committedAt, NOW, 30)).toEqual([
    {
      file: 'README.md',
      line: 2,
      kind: 'stale-marker',
      text: 'TODO open for 45 days: - TODO: document the retry policy',
      suggestion: 'Do it and record the outcome, or drop the line.',
    },
    { file: 'README.md', line: 4, kind: 'stale-marker', text: 'TBD open for 400 days: TBD', suggestion: 'Do it and record the outcome, or drop the line.' },
  ])
  expect(staleMarkers(doc, () => NOW - 45 * DAY, NOW, 30).map(found => found.text)).toEqual([
    'unchecked item open for 45 days: - [ ] fresh item',
    'TODO open for 45 days: - TODO: document the retry policy',
    'FIXME open for 45 days: FIXME: new',
    'TBD open for 45 days: TBD',
  ])
})

test('paragraphs carry their heading and lines; duplicates of 200+ characters are flagged in the later file', async () => {
  const found = paragraphs(README)
  expect(found.map(one => [one.start, one.end, one.heading])).toEqual([
    [3, 5, 'Widgets'],
    [9, 9, 'Known issues'],
    [13, 14, 'Tasks'],
  ])
  expect(duplicateParagraphs([readme, runbook])).toEqual([
    {
      file: 'docs/runbook.md',
      line: 7,
      kind: 'duplicate-paragraph',
      text: 'the "Known issues" paragraph duplicates README.md:9',
      suggestion: 'Keep one copy and link to it from the other.',
    },
  ])
  // For one file (a write): its duplicates against the others, whichever file comes first.
  expect(duplicateParagraphs([readme, runbook], 'README.md').map(one => `${one.file}:${one.line} ${one.text}`)).toEqual([
    'README.md:9 the "Known issues" paragraph duplicates docs/runbook.md:7',
  ])
  // Short shared text is not a duplicate; formatting differences are.
  const a: Doc = { file: 'a.md', text: 'Short shared line.\n' }
  const b: Doc = { file: 'b.md', text: 'Short shared line.\n' }
  expect(duplicateParagraphs([a, b])).toEqual([])
  const c: Doc = { file: 'c.md', text: `${PARAGRAPH.replace('importer', '**importer**')}\n` }
  const d: Doc = { file: 'd.md', text: `${PARAGRAPH.replace(/ /g, '  ')}\n` }
  expect(duplicateParagraphs([c, d]).map(one => one.text)).toEqual(['the paragraph at line 1 duplicates c.md:1'])
})

test('linkTargets resolves relative links from the doc folder and drops external ones', async () => {
  const doc: Doc = {
    file: 'docs/runbook.md',
    text: 'See [guide](guide.md), [top](../README.md#install), [site](https://example.com/a.md), [here](#local), [abs](/docs/b.md "title").',
  }
  expect(linkTargets(doc)).toEqual(['docs/guide.md', 'README.md', 'docs/b.md'])
})

test('orphan: an unlinked doc, untouched past orphanDays while a path it references changed', async () => {
  const guide: Doc = { file: 'docs/guide.md', text: 'Back to the [README](../README.md).\n' }
  const old: Doc = { file: 'docs/old-design.md', text: 'The loader in `src/config.py` reads the table.\n' }
  const claude: Doc = { file: 'CLAUDE.md', text: 'Rules.\n' }
  const noRefs: Doc = { file: 'docs/free.md', text: 'No references at all.\n' }
  const candidates = orphanCandidates([runbook, guide, old, claude, noRefs, readme])
  // README and CLAUDE.md are entry docs; the guide is linked; free.md references nothing.
  expect(candidates).toEqual([
    { file: 'docs/runbook.md', refs: ['docs/guide.md'] },
    { file: 'docs/old-design.md', refs: ['src/config.py', 'docs/src/config.py'] },
  ])
  const candidate = candidates[1]
  if (!candidate) {
    throw new Error('no candidate')
  }
  expect(orphanFinding(candidate, NOW - 95 * DAY, ['src/config.py'], NOW, 60)).toEqual({
    file: 'docs/old-design.md',
    line: 0,
    kind: 'orphan',
    text: 'no doc links to it; untouched for 95 days while src/config.py changed',
    suggestion: 'Link it from a current doc and bring it up to date, or move it to docs/archive/.',
  })
  expect(orphanFinding(candidate, NOW - 10 * DAY, ['src/config.py'], NOW, 60)).toBeNull()
  expect(orphanFinding(candidate, NOW - 95 * DAY, [], NOW, 60)).toBeNull()
  expect(orphanFinding(candidate, null, ['src/config.py'], NOW, 60)).toBeNull()
  expect(orphanFinding(candidate, NOW - 95 * DAY, ['a', 'b', 'c'], NOW, 60)?.text).toBe(
    'no doc links to it; untouched for 95 days while a, b and 1 more changed',
  )
})

test('dated-series: a folder with more than seriesRollupAt dated files is offered a roll-up', async () => {
  const files = [...DIGEST_DAYS.map(day => `docs/digests/${day}.md`), 'docs/digests/README.md', 'notes/2026-10-01.md', 'README.md']
  expect(datedSeries(files, 10, NOW)).toEqual([
    {
      file: 'docs/digests/',
      line: 0,
      kind: 'dated-series',
      text: '12 dated files, 2026-10-01 to 2026-10-12',
      suggestion: 'Roll them up into docs/digests/ROLLUP-2026-42.md and keep the dailies.',
    },
  ])
  expect(datedSeries(files, 12, NOW)).toEqual([])
  expect(datedSeries(['2026-10-01.md', '2026-10-02.md'], 1, NOW)[0]?.file).toBe('./')
})

test('oversized and finished-plan', async () => {
  const big: Doc = { file: 'docs/big.md', text: `${Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n')}\n` }
  expect(oversized(big, 400)).toEqual({
    file: 'docs/big.md',
    line: 0,
    kind: 'oversized',
    text: '450 lines, over the 400-line limit',
    suggestion: 'Split it by topic, or move the reference material into a doc of its own.',
  })
  expect(oversized(big, 450)).toBeNull()

  const plan: Doc = { file: 'docs/plans/2026-09-plan.md', text: '---\nstatus: Done\n---\n# Plan\n' }
  expect(finishedPlan(plan)).toEqual({
    file: 'docs/plans/2026-09-plan.md',
    line: 2,
    kind: 'finished-plan',
    text: 'a finished plan (status: Done)',
    suggestion: 'git mv docs/plans/2026-09-plan.md docs/archive/2026-09-plan.md',
  })
  const outcome: Doc = { file: 'docs/plan-b.md', text: '# Plan B\n\n## Outcome\n\nShipped.\n' }
  expect(finishedPlan(outcome)).toMatchObject({ line: 3, text: 'a finished plan (an "Outcome" section)' })
  expect(finishedPlan({ file: 'docs/plan-c.md', text: '---\nstatus: in progress\n---\n' })).toBeNull()
  expect(finishedPlan({ file: 'docs/archive/old.md', text: '---\nstatus: done\n---\n' })).toBeNull()
})
