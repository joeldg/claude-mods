import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  CLAUDE_MD,
  DIGEST_DAYS,
  DOCS,
  GUIDE,
  MODEL,
  NOW,
  PARAGRAPH,
  README,
  ROLLUP,
  ROOT,
  RUNBOOK,
  SURFACES,
  docs,
  mountPane,
  pane,
  start,
  world,
} from './world'

const SLOW = { timeoutMs: 30_000 }
const TOOL = 'mcp__docs-gardener__docs_check'

/**
 * `$.tool.call` typed loosely for the tests: the engine lays a per-tool union over every connected MCP tool, and with
 * hundreds connected tsc gives up on it (TS2589). The tests only read deny, isError, text, result and context.
 */
type ToolInput = { tool: string; [key: string]: unknown }
type ToolOutcome = { deny?: string; isError?: boolean; text?: string; result?: string; context?: string[] }
const callTool = ($: Engine, input: ToolInput): Promise<ToolOutcome> =>
  ($.tool.call as unknown as (input: ToolInput) => Promise<ToolOutcome>)(input)

const README_NOTE =
  'docs-gardener: README.md references scripts/build_data.sh, which no longer exists (line 3); runs make lint, which the Makefile has no target for (line 4); names load_widgets, which is not found in the code (line 5); the "Known issues" paragraph duplicates docs/runbook.md:7; 1 TODO is older than 30 days.'

/** README without its "Known issues" section. */
const README_WITHOUT_DUPLICATE = README.replace(`## Known issues\n\n${README.split('\n')[8]}\n\n`, '')
/** README without the duplicate and without the stale TODO. */
const README_GARDENED = README_WITHOUT_DUPLICATE.replace('- TODO: document the retry policy\n', '')
const OLD_DESIGN_NEW = '# Old design\n\nThe loader in `src/config.py` reads the widgets table lazily.\n'
const ROLLUP_TEXT = '# Digests, 2026-10-01 to 2026-10-12\n\nNothing notable all fortnight.'

const PLANS = {
  'README.md': JSON.stringify([
    { section: 'Known issues', verdict: 'duplicate', reason: 'kept once in docs/runbook.md', replacement: null },
    { section: '14-14', verdict: 'stray', reason: 'a 45-day-old TODO', replacement: null },
    { section: 'Tasks', verdict: 'current', reason: 'still open', replacement: null },
  ]),
  'docs/old-design.md': JSON.stringify([
    { section: 'Old design', verdict: 'update', reason: 'the loader is lazy now', replacement: OLD_DESIGN_NEW },
  ]),
  'docs/digests/': JSON.stringify([{ section: 'ROLLUP', verdict: 'rollup', reason: 'a fortnight of quiet digests', replacement: ROLLUP_TEXT }]),
}

const AUDIT_STARTED =
  `Docs audit of all docs: 19 docs checked, 9 findings in 6 files. Asking ${MODEL} about 6 files… ` +
  'The pane shows the plan as it arrives; Apply and Skip decide each item.'

test('a Write of a doc in scope gets a context note with what the checks found; the write itself stands', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  const ran = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(ran.deny).toBeUndefined()
  expect(ran.context).toEqual([README_NOTE])
  expect(w.files.get('README.md')).toBe(README)
  // The identifiers were looked up once, whole-word, outside markdown.
  expect(w.ran.filter(line => line.startsWith('rg --no-filename -o -w'))).toHaveLength(1)
  expect(w.ran).toContain(`git blame --line-porcelain -- ${ROOT}/README.md`)
})

test('an Edit is checked on the file as it stands after the edit', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  const ran = await callTool($, {
    tool: 'Edit',
    file_path: `${ROOT}/docs/guide.md`,
    old_string: 'Back to',
    new_string: 'Run `scripts/gone.sh`, then back to',
  })
  expect(ran.context).toEqual(['docs-gardener: docs/guide.md references scripts/gone.sh, which no longer exists (line 3).'])
  expect(w.files.get('docs/guide.md')).toBe(GUIDE.replace('Back to', 'Run `scripts/gone.sh`, then back to'))
})

test('a clean doc, a doc out of scope and a file that is not markdown get no note', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  const clean = await callTool($, { tool: 'Write', file_path: `${ROOT}/CLAUDE.md`, content: CLAUDE_MD })
  expect(clean.context ?? []).toEqual([])
  const vendored = await callTool($, { tool: 'Write', file_path: `${ROOT}/node_modules/pkg/README.md`, content: 'See `scripts/missing.sh`.\n' })
  expect(vendored.context ?? []).toEqual([])
  const code = await callTool($, { tool: 'Write', file_path: `${ROOT}/src/x.py`, content: '# `scripts/missing.sh`\n' })
  expect(code.context ?? []).toEqual([])
  expect(w.writes).toEqual([])
  // Only the clean doc was checked at all: one listing of the docs, and nothing to look up in it.
  expect(w.ran.filter(line => line.startsWith('rg --files'))).toHaveLength(1)
  expect(w.ran.filter(line => line.startsWith('rg --no-filename') || line.startsWith('git blame'))).toEqual([])
})

test('the write-time check keeps a corpus cache: unchanged docs are not read again, changed ones once', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  const docsRead = () => w.reads.filter(path => path.endsWith('.md'))
  const listings = () => w.ran.filter(line => line.startsWith('rg --files')).length
  // The first write reads every other doc in scope once.
  const first = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(first.context).toEqual([README_NOTE])
  expect(docsRead().sort()).toEqual(Object.keys(DOCS).filter(path => path !== 'README.md').sort())
  expect(listings()).toBe(1)
  // The second write reads none of them: their mtimes are what the cache saw.
  w.reads.length = 0
  const second = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(second.context).toEqual([README_NOTE])
  expect(docsRead()).toEqual([])
  expect(listings()).toBe(1)
  // A doc edited elsewhere is read again once its mtime changed, and the note follows it.
  w.files.set('docs/runbook.md', RUNBOOK.replace(PARAGRAPH, 'The runbook paragraph was rewritten.'))
  w.mtimes['docs/runbook.md'] = NOW + 5_000
  w.reads.length = 0
  const third = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(docsRead()).toEqual(['docs/runbook.md'])
  expect(third.context).toEqual([README_NOTE.replace('; the "Known issues" paragraph duplicates docs/runbook.md:7', '')])
  // A write updates the doc's own entry: README without the paragraph, then the runbook duplicates nothing.
  await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README_WITHOUT_DUPLICATE })
  w.reads.length = 0
  const runbook = await callTool($, { tool: 'Write', file_path: `${ROOT}/docs/runbook.md`, content: RUNBOOK })
  expect(docsRead()).toEqual([])
  expect(runbook.context ?? []).toEqual([])
  // After ten minutes the docs are listed again, and a doc added meanwhile is read and seen.
  w.files.set('docs/new.md', `# New\n\n${PARAGRAPH}\n`)
  w.reads.length = 0
  await w.clock.advance(10 * 60_000)
  const fourth = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(listings()).toBe(2)
  expect(docsRead()).toEqual(['docs/new.md'])
  expect(fourth.context?.[0]).toContain('the "Known issues" paragraph duplicates docs/new.md:3')
})

test('writeTimeChecks off: writes are left alone', { ...SLOW, options: { writeTimeChecks: false } }, async ($, on) => {
  const w = world(on)
  await start($)
  const ran = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(ran.context ?? []).toEqual([])
  expect(w.ran).toEqual([])
})

test('the docs_check tool is registered in front, allowed without asking, and lists the findings for a file or folder', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.commands).toEqual(['garden'])
  expect(w.tools).toHaveLength(1)
  expect(w.tools[0]).toMatchObject({ name: 'docs_check', isDeferred: false, inputSchema: { type: 'object', required: ['path'] } })
  expect(w.tools[0]?.description).toMatch(/before editing/i)
  expect(await $.tool.check({ tool: TOOL, input: { path: 'README.md' } })).toMatchObject({ decision: 'allow' })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
  w.denied = [TOOL]
  expect(await $.tool.check({ tool: TOOL, input: { path: 'README.md' } })).toMatchObject({ decision: 'deny', reason: 'denied in settings' })

  const file = await callTool($, { tool: TOOL, path: 'README.md' })
  expect(file.result).toBe(
    [
      'docs-gardener: 4 findings in README.md',
      '  L3 dead-reference: references scripts/build_data.sh, which no longer exists — Point it at the current path or remove the reference.',
      '  L4 dead-reference: runs make lint, which the Makefile has no target for — Name a current make target or remove it.',
      '  L5 dead-reference: names load_widgets, which is not found in the code — Rename it to what the code calls it now, or remove it.',
      '  L14 stale-marker: TODO open for 45 days: - TODO: document the retry policy — Do it and record the outcome, or drop the line.',
    ].join('\n'),
  )
  const folder = String((await callTool($, { tool: TOOL, path: `${ROOT}/docs` })).result)
  expect(folder.split('\n')[0]).toBe('docs-gardener: 5 findings in docs/')
  expect(folder).toContain('docs/runbook.md\n  L7 duplicate-paragraph: the "Known issues" paragraph duplicates README.md:9')
  expect(folder).toContain('docs/old-design.md\n  orphan: no doc links to it; untouched for 95 days while src/config.py changed')
  expect(folder).toContain('docs/plans/2026-09-plan.md\n  L2 finished-plan: a finished plan (status: done) — git mv docs/plans/2026-09-plan.md docs/archive/2026-09-plan.md')
  expect(folder).toContain('docs/digests/\n  dated-series: 12 dated files, 2026-10-01 to 2026-10-12 — Roll them up into docs/digests/ROLLUP-2026-42.md and keep the dailies.')
  expect(folder).toContain('docs/big.md\n  oversized: 450 lines, over the 400-line limit')
  expect((await callTool($, { tool: TOOL, path: 'CLAUDE.md' })).result).toBe('docs-gardener: nothing to fix in CLAUDE.md.')
  expect((await callTool($, { tool: TOOL, path: 'docs/nope.md' })).result).toBe('docs-gardener: docs/nope.md is not a markdown file or folder in scope.')
  expect((await callTool($, { tool: TOOL, path: 'node_modules/pkg/README.md' })).result).toBe(
    'docs-gardener: node_modules/pkg/README.md is not a markdown file or folder in scope.',
  )
  expect(w.completes).toEqual([])
})

test('the first message carries a three-line note about gardened docs', SLOW, async ($, on) => {
  world(on)
  const out = await $.prompt.context({ blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-12." }] })
  expect(out.blocks.map(block => block.name)).toEqual(['currentDate', 'docsGardener'])
  const text = out.blocks[1]?.text ?? ''
  expect(text.split('\n')).toHaveLength(3)
  expect(text).toContain('docs_check')
  expect(text).toContain('/garden audit')
  expect(text).toMatch(/notes file/)
})

test('/garden audit: the checks, then a plan per flagged file, shown in the pane with Apply and Skip', SLOW, async ($, on) => {
  const w = world(on)
  Object.assign(w.plans, PLANS)
  await start($)
  const text = await docs($, 'audit')
  expect(text).toBe(AUDIT_STARTED)
  // The command answered before the model was asked; the pane is open already.
  expect(w.completes).toHaveLength(0)
  expect(w.opened).toEqual([{ id: 'docs-gardener', title: 'Docs audit' }])
  let shown = await pane($)
  expect(shown.lines).toContain(`  asking ${MODEL}…`)

  await w.clock.settle()
  expect(w.completes.map(call => call.model)).toEqual(Array.from({ length: 6 }, () => MODEL))
  const prompt = w.completes[0]?.prompt ?? ''
  expect(prompt).toContain('File: README.md')
  expect(prompt).toContain('Repository: widgets')
  expect(prompt).toContain('Default branch: main')
  expect(prompt).toContain('Top-level folders: docs, scripts, src')
  expect(prompt).toContain('- Add import v2')
  expect(prompt).toContain('line 3: dead-reference: references scripts/build_data.sh, which no longer exists')
  expect(prompt).toContain('3| Build the data with `scripts/build_data.sh`')
  const subjects = w.completes.map(call => /^(?:File|Folder): (.+)$/m.exec(String(call.prompt))?.[1])
  expect(subjects).toEqual(['README.md', 'docs/big.md', 'docs/digests/', 'docs/old-design.md', 'docs/plans/2026-09-plan.md', 'docs/runbook.md'])
  expect(w.toasts).toEqual([`Docs audit ready: 4 changes proposed in 3 files · /garden show`])

  for (const surface of SURFACES) {
    shown = await pane($, surface)
    expect(shown.lines[0]).toMatch(/^Docs audit · all docs · 19 docs, 9 findings/)
    expect(shown.lines).toContain('README.md · 4 findings')
    expect(shown.lines).toContain('  L3 dead-reference: references scripts/build_data.sh, which no longer exists')
    expect(shown.lines).toContain('  L14 stale-marker: TODO open for 45 days: - TODO: document the retry policy')
    expect(shown.lines).toContain('  duplicate · Known issues: kept once in docs/runbook.md')
    expect(shown.lines).toContain('  stray · 14-14: a 45-day-old TODO')
    expect(shown.lines).toContain('  current · Tasks: still open')
    expect(shown.lines).toContain('docs/digests/ · 1 finding')
    expect(shown.lines).toContain('  dated-series: 12 dated files, 2026-10-01 to 2026-10-12')
    expect(shown.lines).toContain('  rollup · ROLLUP: a fortnight of quiet digests')
    expect(shown.lines).toContain('  The dailies stay in place; Apply writes the roll-up beside them.')
    expect(shown.lines).toContain('docs/old-design.md · 1 finding')
    expect(shown.lines).toContain('  orphan: no doc links to it; untouched for 95 days while src/config.py changed')
    expect(shown.lines).toContain('  update · Old design: the loader is lazy now')
    expect(shown.lines).toContain('docs/plans/2026-09-plan.md · 1 finding')
    expect(shown.lines).toContain('  L2 finished-plan: a finished plan (status: done)')
    expect(shown.lines).toContain('  nothing to change')
    expect(shown.buttons).toEqual(
      expect.arrayContaining([
        { key: 'close', label: 'Close' },
        { key: 'apply-all-0', label: 'Apply all' },
        { key: 'apply-0-0', label: 'Apply' },
        { key: 'skip-0-0', label: 'Skip' },
        { key: 'apply-0-1', label: 'Apply' },
        { key: 'skip-0-1', label: 'Skip' },
        { key: 'apply-2-0', label: 'Apply' },
        { key: 'apply-3-0', label: 'Apply' },
      ]),
    )
    // A "current" verdict has nothing to apply; a file with no items has no Apply all.
    expect(shown.buttons.find(button => button.key === 'apply-0-2')).toBeUndefined()
    expect(shown.buttons.find(button => button.key === 'apply-all-1')).toBeUndefined()
  }

  const ui = await mountPane($, 'terminal')
  // Apply removes exactly the duplicated section.
  await ui.press({ key: 'apply-0-0' })
  expect(w.files.get('README.md')).toBe(README_WITHOUT_DUPLICATE)
  expect(w.writes).toEqual(['README.md'])
  expect((await ui.find({ type: 'Text', text: /removed lines 7-9/ }))?.text).toBe('  ✓ removed lines 7-9')
  expect(w.debug).toContain(`docs-gardener: applied README.md\n@@ README.md:7-9 (duplicate)\n-## Known issues\n-\n-${README.split('\n')[8]}`)
  // Skip leaves the file alone.
  await ui.press({ key: 'skip-0-1' })
  expect(w.files.get('README.md')).toBe(README_WITHOUT_DUPLICATE)
  expect(w.writes).toEqual(['README.md'])
  expect((await ui.find({ type: 'Text', text: /skipped/ }))?.text).toBe('  skipped')
  expect(await ui.find({ type: 'Button', key: 'apply-0-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'apply-all-0' })).toBeUndefined()
  // An update rewrites the section in place.
  await ui.press({ key: 'apply-3-0' })
  expect(w.files.get('docs/old-design.md')).toBe(OLD_DESIGN_NEW)
  expect((await ui.find({ type: 'Text', text: /rewrote/ }))?.text).toBe('  ✓ rewrote lines 1-3')
  // The roll-up is written beside the dailies, which stay.
  await ui.press({ key: 'apply-2-0' })
  expect(w.files.get(ROLLUP)).toBe(`${ROLLUP_TEXT}\n`)
  for (const day of DIGEST_DAYS) {
    expect(w.files.has(`docs/digests/${day}.md`)).toBe(true)
  }
  expect((await ui.find({ type: 'Text', text: /wrote docs/ }))?.text).toBe(`  ✓ wrote ${ROLLUP}`)
  expect(w.writes).toEqual(['README.md', 'docs/old-design.md', ROLLUP])
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['docs-gardener'])
  await ui.unmount()

  expect(await docs($, 'show')).toBe('Showing the docs audit of all docs.')
  expect(w.opened).toHaveLength(2)
})

test('Apply all applies every pending item of one file, bottom first, so the ranges hold', SLOW, async ($, on) => {
  const w = world(on)
  Object.assign(w.plans, PLANS)
  await start($)
  await docs($, 'audit')
  await w.clock.settle()
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'apply-all-0' })
  expect(w.files.get('README.md')).toBe(README_GARDENED)
  expect(w.writes).toEqual(['README.md', 'README.md'])
  expect((await ui.findAll({ type: 'Button' })).filter(button => (button.key ?? '').startsWith('apply-0-'))).toEqual([])
  await ui.unmount()
})

test('--apply applies every item as it arrives, without the pane, and reports what it did', SLOW, async ($, on) => {
  const w = world(on)
  Object.assign(w.plans, PLANS)
  await start($)
  const text = await docs($, 'audit --apply')
  expect(text).toBe(
    `Docs audit of all docs: 19 docs checked, 9 findings in 6 files. Asking ${MODEL} about 6 files… ` +
      'Every item is applied as it arrives; the diffs go to the debug log.',
  )
  await w.clock.settle()
  expect(w.opened).toEqual([])
  expect(w.files.get('README.md')).toBe(README_GARDENED)
  expect(w.files.get('docs/old-design.md')).toBe(OLD_DESIGN_NEW)
  expect(w.files.get(ROLLUP)).toBe(`${ROLLUP_TEXT}\n`)
  // Each item is one read and one write, so a file with two items is written twice.
  expect([...w.writes].sort()).toEqual(['README.md', 'README.md', ROLLUP, 'docs/old-design.md'].sort())
  expect(w.toasts).toEqual(['Docs audit applied 4 changes in 3 files'])
  expect(w.logs).toEqual([
    `docs-gardener: /garden audit --apply applied 4 changes in 3 files (README.md ×2, ${ROLLUP}, docs/old-design.md); the diffs are in the debug log.`,
  ])
  expect(w.debug.filter(line => line.startsWith('docs-gardener: applied '))).toHaveLength(4)
})

test('malformed model output is ignored item by item; a reply with no plan is said so', SLOW, async ($, on) => {
  const w = world(on)
  w.plans['README.md'] = [
    'Here you go:',
    '```json',
    JSON.stringify([
      { section: 'Known issues', verdict: 'duplicate', reason: 'kept once in docs/runbook.md', replacement: null },
      { nonsense: 1 },
      { section: 'Nowhere', verdict: 'delete', reason: 'x', replacement: null },
      { section: 'Tasks', verdict: 'bogus', reason: 'x', replacement: null },
      'a string',
      null,
    ]),
    '```',
  ].join('\n')
  w.plans['docs/big.md'] = 'I cannot help with that.'
  await start($)
  await docs($, 'audit')
  await w.clock.settle()
  const shown = await pane($)
  expect(shown.lines).toContain('  duplicate · Known issues: kept once in docs/runbook.md')
  expect(shown.lines.filter(line => line.includes('Nowhere') || line.includes('bogus'))).toEqual([])
  expect(shown.lines).toContain('  the reply held no usable plan')
  expect(shown.buttons.filter(button => (button.key ?? '').startsWith('apply-0-'))).toEqual([{ key: 'apply-0-0', label: 'Apply' }])
  expect(w.toasts).toEqual([`Docs audit ready: 1 change proposed in 1 file · /garden show`])
})

test('a failed model call is shown per file and the audit still finishes', SLOW, async ($, on) => {
  const w = world(on)
  w.reply = 'fail'
  await start($)
  await docs($, 'audit')
  await w.clock.settle()
  const shown = await pane($)
  expect(shown.lines).toContain('  model call failed: the API answered HTTP 529 (overloaded)')
  expect(w.toasts).toEqual(['Docs audit ready: nothing to change (6 model calls failed) · /garden show'])
  expect(shown.buttons.filter(button => (button.key ?? '').startsWith('apply'))).toEqual([])
})

test('nothing flagged: the model is never asked', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await docs($, 'audit CLAUDE.md')).toBe('Docs audit of CLAUDE.md: 1 doc checked, nothing to fix; the model was not asked.')
  await w.clock.settle()
  expect(w.completes).toEqual([])
  expect(w.opened).toEqual([])
  expect(await docs($, 'show')).toBe('No docs audit yet. /garden audit runs one.')
})

test('a clean project: nothing flagged across the scope, no model call', SLOW, async ($, on) => {
  const w = world(on, { clean: true })
  await start($)
  expect(await docs($, 'audit')).toBe('Docs audit of all docs: 2 docs checked, nothing to fix; the model was not asked.')
  await w.clock.settle()
  expect(w.completes).toEqual([])
})

test('maxModelFiles caps the model pass at the files with the most findings', { ...SLOW, options: { maxModelFiles: 2 } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await docs($, 'audit')).toBe(
    `Docs audit of all docs: 19 docs checked, 9 findings in 6 files. Asking ${MODEL} about 2 files (4 more keep their findings only; maxModelFiles is 2)… ` +
      'The pane shows the plan as it arrives; Apply and Skip decide each item.',
  )
  await w.clock.settle()
  const subjects = w.completes.map(call => /^(?:File|Folder): (.+)$/m.exec(String(call.prompt))?.[1])
  expect(subjects).toEqual(['README.md', 'docs/big.md'])
  const shown = await pane($)
  expect(shown.lines.filter(line => line === '  not sent to the model: over the 2-file cap (maxModelFiles)')).toHaveLength(4)
})

test('--changed audits the docs changed on the branch, flagged or not', SLOW, async ($, on) => {
  const w = world(on)
  w.branchFiles = ['README.md', 'src/config.py']
  w.dirtyFiles = ['docs/guide.md']
  await start($)
  expect(await docs($, 'audit --changed')).toBe(
    `Docs audit of the docs changed on feature/docs against origin/main: 2 docs checked, 4 findings in 1 file. Asking ${MODEL} about 2 files… ` +
      'The pane shows the plan as it arrives; Apply and Skip decide each item.',
  )
  await w.clock.settle()
  const subjects = w.completes.map(call => /^(?:File|Folder): (.+)$/m.exec(String(call.prompt))?.[1])
  expect(subjects).toEqual(['README.md', 'docs/guide.md'])
  const shown = await pane($)
  expect(shown.lines).toContain('docs/guide.md · changed, no findings')
})

test('--changed on the default branch takes the last 7 days of commits and the working tree', SLOW, async ($, on) => {
  const w = world(on)
  w.branch = 'main'
  w.recentFiles = ['docs/runbook.md', 'src/config.py']
  w.untracked = ['docs/notes.md']
  w.files.set('docs/notes.md', '# Notes\n\nSee `scripts/missing.sh`.\n')
  await start($)
  expect(await docs($, 'audit --changed')).toBe(
    `Docs audit of the docs changed in the last 7 days on main: 2 docs checked, 2 findings in 2 files. Asking ${MODEL} about 2 files… ` +
      'The pane shows the plan as it arrives; Apply and Skip decide each item.',
  )
  await w.clock.settle()
  const subjects = w.completes.map(call => /^(?:File|Folder): (.+)$/m.exec(String(call.prompt))?.[1])
  expect(subjects).toEqual(['docs/notes.md', 'docs/runbook.md'])
})

test('an audit already running is not started twice; /garden check and /garden help answer at once', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await docs($, 'audit')
  expect(await docs($, 'audit')).toBe(`docs-gardener: an audit is already running (${MODEL} is answering); /garden show opens it.`)
  await w.clock.settle()
  expect(await docs($, 'check README.md')).toMatch(/^docs-gardener: 4 findings in README\.md\n/)
  expect(await docs($, 'help')).toMatch(/^Usage: \/garden audit \[path\|--changed\] \[--apply\]/)
  expect(await docs($, 'prune')).toMatch(/Usage:/)
  expect(w.completes).toHaveLength(6)
})

test('a doc git does not track is not blamed: its TODOs and unchecked items count as fresh; a tracked doc is blamed as before', SLOW, async ($, on) => {
  const w = world(on)
  const handoff = '# Handoff\n\n- TODO: write the labelling guide\n- [ ] check the counts\n'
  w.files.set('labelling/HANDOFF.md', handoff)
  w.untracked = ['labelling/HANDOFF.md']
  await start($)
  const written = await callTool($, { tool: 'Write', file_path: `${ROOT}/labelling/HANDOFF.md`, content: handoff })
  expect(written.context ?? []).toEqual([])
  expect((await callTool($, { tool: TOOL, path: 'labelling/HANDOFF.md' })).result).toBe('docs-gardener: nothing to fix in labelling/HANDOFF.md.')
  expect(w.ran.filter(line => line.startsWith('git blame'))).toEqual([])
  expect(w.debug).toEqual([])
  const readme = await callTool($, { tool: TOOL, path: 'README.md' })
  expect(String(readme.result)).toContain('L14 stale-marker: TODO open for 45 days')
  expect(w.ran.filter(line => line.startsWith('git blame'))).toEqual([`git blame --line-porcelain -- ${ROOT}/README.md`])
  // Which docs git tracks is asked once per write (kept with the corpus cache) and once per check, one call each.
  expect(w.ran.filter(line => line.startsWith('git ls-files -z -- '))).toHaveLength(3)
})

test('a blame that fails counts as no history: the markers are fresh, and the debug log hears of it once a session', SLOW, async ($, on) => {
  const w = world(on)
  w.blameFails = ['README.md']
  await start($)
  const checked = await callTool($, { tool: TOOL, path: 'README.md' })
  expect(String(checked.result)).toMatch(/^docs-gardener: 3 findings in README\.md\n/)
  expect(String(checked.result)).not.toContain('stale-marker')
  const written = await callTool($, { tool: 'Write', file_path: `${ROOT}/README.md`, content: README })
  expect(written.context).toEqual([README_NOTE.replace('; 1 TODO is older than 30 days', '')])
  expect(w.ran.filter(line => line.startsWith('git blame'))).toHaveLength(2)
  expect(w.debug).toEqual([
    "docs-gardener: git blame could not read README.md (fatal: no such path 'README.md' in HEAD); its markers count as fresh (later blame failures this session are not logged)",
  ])
})

test('slash commands, bare file names and names anywhere in the code are not dead references; a missing file under a folder here is', SLOW, async ($, on) => {
  const w = world(on)
  w.files.set(
    '.claude-plugin/plugin.json',
    ['{', '  "name": "guard",', '  "userConfig": {', '    "subagentEffort": { "type": "string" },', '    "toastScope": { "type": "string" },', '    "stallReminderMinutes": { "type": "number" }', '  }', '}', ''].join('\n'),
  )
  w.files.set('hooks/register.ts', ["const TOOL = 'machine_status'", "const dirs = $.env.get('CLAUDE_CODE_PLUGIN_DIRS')", ''].join('\n'))
  w.files.set(
    'docs/guard.md',
    [
      '# Guard',
      '',
      'Run `/servers`, `/guard pause 15m` or `/mods report 7d`; the tool is `machine_status`.',
      'Settings: `subagentEffort`, `toastScope` and `stallReminderMinutes`; set `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`.',
      'Other projects keep a `package.json`, a `lock.json` or a `.claude/launch.json`.',
      'Then run `scripts/x.sh`.',
      '',
    ].join('\n'),
  )
  await start($)
  expect((await callTool($, { tool: TOOL, path: 'docs/guard.md' })).result).toBe(
    ['docs-gardener: 1 finding in docs/guard.md', '  L6 dead-reference: references scripts/x.sh, which no longer exists — Point it at the current path or remove the reference.'].join('\n'),
  )
  // One rg over every file but markdown, hidden folders included, printing every match rather than the first per file.
  const lookups = w.ran.filter(line => line.startsWith('rg --no-filename'))
  expect(lookups).toHaveLength(1)
  expect(lookups[0]).toContain(' --hidden ')
  expect(lookups[0]).not.toContain(' -m 1 ')
})
