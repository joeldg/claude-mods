import { expect, mock, test } from 'claude-code/testing'

/**
 * `$.tool.call` typed loosely for the tests: the engine lays a per-tool union over every connected MCP tool, and with
 * hundreds connected tsc gives up on it (TS2589). The tests only read deny, isError, text, result and context.
 */
type ToolInput = { tool: string; [key: string]: unknown }
type ToolOutcome = { deny?: string; isError?: boolean; text?: string; result?: string; context?: string[] }
const callTool = ($: Engine, input: ToolInput): Promise<ToolOutcome> =>
  ($.tool.call as unknown as (input: ToolInput) => Promise<ToolOutcome>)(input)
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/dev'
const PY_ROOT = '/home/dev/meshkit'
const TS_ROOT = '/home/dev/webshop'
const LEDGER_ROOT = '/home/dev/ledger'
const TOOL = 'mcp__test-gardener__tests_neighbourhood'
/** The PATH folder the probe finds rg in, when it is there. */
const BIN = '/usr/local/bin'
const LS_FILES = 'git ls-files --cached --others --exclude-standard'
const FOR_EACH_REF = 'git for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master'

const BAND = {
  isCollapsed: false, hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}
const TURN = { answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }

type Ran = { argv: string; cwd: string | undefined }
type Tool = { name: string; description: string; isDeferred?: boolean }

type World = {
  /** Every file on disk, by absolute path. */
  files: Map<string, string>
  mtimes: Map<string, number>
  stamp: number
  reads: string[]
  writes: string[]
  ran: Ran[]
  tools: Tool[]
  commands: string[]
  suggested: string[]
  logs: string[]
  /** What `git rev-parse --show-toplevel` answers; null: not a repository. */
  gitRoot: string | null
  /** rg is on PATH; false: the probe finds none, and rg is never to be started. */
  rg: boolean
  /** rg, found on PATH, starts; false: spawning it fails (a folder that is not there gives the same ENOENT). */
  rgStarts: boolean
  /** git ls-files answers; false: it cannot start. */
  lsFiles: boolean
  /** What `$.session.cwd()` answers now. */
  cwd: string
  branch: string
  diff: string
  /** What `git for-each-ref` prints over origin/HEAD and its stand-ins, as `refLines` spells it. */
  refs: string
  /** What `ripwire --clones` prints; null: the command cannot start. */
  ripwire: string | null
  /** Another plugin's band beneath this one; null: the engine's empty band. */
  otherBand: string | null
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** for-each-ref's rows, one per line in git's order: `<refname>\t<symref target, or nothing>`. */
const refLines = (...rows: string[]): string => rows.map(row => `${row}\n`).join('')

/** Answers the host beneath the plugin: HOME, the files, rg, git and ripwire, the tools written through, the band beneath. */
const world = (on: On, cwd: string): World => {
  const w: World = {
    files: new Map(),
    mtimes: new Map(),
    stamp: 1000,
    reads: [],
    writes: [],
    ran: [],
    tools: [],
    commands: [],
    suggested: [],
    logs: [],
    gitRoot: cwd,
    rg: true,
    rgStarts: true,
    lsFiles: true,
    cwd,
    branch: 'feature/mesh-resume',
    diff: '',
    refs: refLines('refs/heads/main\t', 'refs/remotes/origin/HEAD\trefs/remotes/origin/main', 'refs/remotes/origin/main\t'),
    ripwire: null,
    otherBand: null,
  }
  const put = (path: string, text: string) => {
    w.files.set(path, text)
    w.mtimes.set(path, ++w.stamp)
  }
  mock.env(on, { HOME, PATH: `${BIN}:/usr/bin` })
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('prompt.suggest', (_$, e) => {
    w.suggested.push(e.text)
    return { isShown: true }
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    w.tools.push({ name: e.name, description: e.description, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__test-gardener__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    w.reads.push(e.path)
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file, ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    put(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === `${BIN}/rg` ? w.rg : w.files.has(e.path) }))
  on('fs.stat', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined
      ? { deny: `ENOENT: no such file, ${e.path}` }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: w.mtimes.get(e.path) ?? 0, isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const dir = e.path.replace(/\/+$/, '')
    const names = new Map<string, { kind: 'file' | 'dir'; size: number; mtimeMs: number }>()
    for (const [path, text] of w.files) {
      if (!path.startsWith(`${dir}/`)) {
        continue
      }
      const rest = path.slice(dir.length + 1)
      const cut = rest.indexOf('/')
      if (cut < 0) {
        names.set(rest, { kind: 'file', size: text.length, mtimeMs: w.mtimes.get(path) ?? 0 })
      } else {
        names.set(rest.slice(0, cut), { kind: 'dir', size: 0, mtimeMs: 0 })
      }
    }
    if (names.size === 0) {
      return { deny: `ENOENT: no such directory, ${e.path}` }
    }
    return { value: [...names].map(([name, entry]) => ({ name, ...entry, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const at = e.init?.cwd ?? w.cwd
    w.ran.push({ argv, cwd: at })
    const answer = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    // rg and git list the same files, relative to where they run.
    const listing = () => {
      const base = at.replace(/\/+$/, '')
      return answer([...w.files.keys()].filter(path => path.startsWith(`${base}/`)).map(path => path.slice(base.length + 1)).sort().join('\n') + '\n')
    }
    if (e.argv[0] === 'rg') {
      return w.rg && w.rgStarts ? listing() : { deny: 'spawn rg ENOENT' }
    }
    if (e.argv[0] === 'ripwire') {
      return w.ripwire === null ? { deny: 'spawn ripwire ENOENT' } : answer(w.ripwire)
    }
    if (e.argv[0] === 'git') {
      if (argv === 'git rev-parse --show-toplevel') {
        const inside = w.gitRoot !== null && (at === w.gitRoot || at.startsWith(`${w.gitRoot}/`))
        return inside ? answer(`${w.gitRoot}\n`) : answer('', 128, 'fatal: not a git repository (or any of the parent directories): .git\n')
      }
      if (argv === LS_FILES) {
        return w.lsFiles ? listing() : { deny: 'git ls-files: still running after 20000ms' }
      }
      if (argv === FOR_EACH_REF) {
        return answer(w.refs)
      }
      if (argv === 'git branch --show-current') {
        return answer(`${w.branch}\n`)
      }
      if (argv.startsWith('git diff -U0 ')) {
        return answer(w.diff)
      }
    }
    return answer('', 1, `unexpected command: ${argv}`)
  })
  // The engine's own band, drawn when the plugin passes: empty; or another plugin's band beneath.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return w.otherBand === null ? <Box /> : <Text>{w.otherBand}</Text>
  })
  // The Write and Edit tools beneath the plugin: they change the files and answer as the engine's do.
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    const path = e.file_path.startsWith('/') ? e.file_path : `${cwd}/${e.file_path}`
    const original = w.files.get(path) ?? null
    put(path, e.content)
    return {
      result: { type: original === null ? ('create' as const) : ('update' as const), filePath: path, content: e.content, structuredPatch: [], originalFile: original },
      text: `File written: ${path}`,
    }
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    const path = e.file_path.startsWith('/') ? e.file_path : `${cwd}/${e.file_path}`
    const original = w.files.get(path) ?? ''
    put(path, original.replace(e.old_string, e.new_string))
    return {
      result: { filePath: path, oldString: e.old_string, newString: e.new_string, originalFile: original, structuredPatch: [], userModified: false, replaceAll: false },
      text: `Edited ${path}`,
    }
  })
  return w
}

const seed = (w: World, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    w.files.set(path, text)
    w.mtimes.set(path, ++w.stamp)
  }
}

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const begin = ($: Engine, cwd: string) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

type Node = string | { type?: string; children?: Node[] }

/** The text a band draws, nested spans joined, Buttons left out: '' when only the engine's empty band shows. */
const shown = (node: Node): string =>
  typeof node === 'string' ? node : node.type === 'Button' ? '' : (node.children ?? []).map(shown).join('')

const pyTest = (name: string, lines: readonly string[]): string => [`def ${name}():`, ...lines.map(line => `    ${line}`)].join('\n')

const MESH_BODIES: readonly (readonly string[])[] = [
  ['mesh = build(N)', 'assert mesh["cells"] == N'],
  ['with pytest.raises(ValueError):', '    build(-N)'],
  ['assert build(N)["faces"] == N * 2'],
  ['state = resume("runs/N.ckpt", checkpoint=N)', 'assert state["checkpoint"] == N'],
  ['assert resume("runs/N.ckpt", checkpoint=0)["path"].endswith(".ckpt")'],
  ['cells = [build(i)["cells"] for i in range(N)]', 'assert cells == list(range(N))'],
]
const FACE_BODIES: readonly (readonly string[])[] = [
  ['assert area(N, N) == N * N'],
  ['assert perimeter(N, 2) == 2 * (N + 2)'],
  ['face = {"w": N, "h": 3}', 'assert area(face["w"], face["h"]) == N * 3'],
  ['assert perimeter(N, N) > area(1, 1)'],
]
const varied = (prefix: string, bodies: readonly (readonly string[])[], count: number): string[] =>
  Array.from({ length: count }, (_, i) => pyTest(`${prefix}_${i}`, (bodies[i % bodies.length] ?? []).map(line => line.replace(/\bN\b/g, String(i + 1)))))

const RESUME_BODY = [
  'mesh = build(8)',
  'state = resume("runs/mesh.ckpt", checkpoint=3)',
  'assert state["path"] == "runs/mesh.ckpt"',
  'assert state["checkpoint"] == 3',
  'assert mesh["faces"] == 16',
]

/** A Python project: a module covered by two test files, and a third file at the size guideline. */
const PY_FILES: Record<string, string> = {
  [`${PY_ROOT}/meshkit/__init__.py`]: '',
  [`${PY_ROOT}/meshkit/mesh_build.py`]: 'def build(cells):\n    return {"cells": cells, "faces": cells * 2}\n\n\ndef resume(path, checkpoint):\n    return {"path": path, "checkpoint": checkpoint}\n',
  [`${PY_ROOT}/meshkit/mesh_faces.py`]: 'def area(w, h):\n    return w * h\n\n\ndef perimeter(w, h):\n    return 2 * (w + h)\n',
  [`${PY_ROOT}/tests/conftest.py`]: 'import pytest\n',
  [`${PY_ROOT}/tests/test_meshes.py`]:
    ['import pytest', '', 'from meshkit.mesh_build import build, resume', '', '', pyTest('test_build_resume', RESUME_BODY), ...varied('test_mesh', MESH_BODIES, 18)].join('\n\n\n') + '\n',
  [`${PY_ROOT}/tests/test_mesh_build_resume.py`]:
    [
      'from meshkit import mesh_build',
      '',
      '',
      ...varied(
        'test_resume',
        [
          ['assert mesh_build.resume("a/N.ckpt", checkpoint=N)["checkpoint"] == N'],
          ['state = mesh_build.resume("b/N.ckpt", checkpoint=1)', 'assert state["path"].startswith("b/")'],
          ['assert mesh_build.resume("", checkpoint=N) is not None'],
        ],
        6,
      ),
    ].join('\n\n\n') + '\n',
  [`${PY_ROOT}/tests/test_mesh_faces.py`]:
    ['import pytest', '', 'from meshkit.mesh_faces import area, perimeter', '', '', ...varied('test_face', FACE_BODIES, 40)].join('\n\n\n') + '\n\n\n# more tests below\n',
}

const RESUME_TWICE = [
  'from meshkit.mesh_build import build, resume',
  '',
  '',
  pyTest('test_build_resume_twice', [...RESUME_BODY, 'assert isinstance(mesh, dict)']),
  '',
].join('\n')
/** The note RESUME_TWICE earns as a new file in the Python project. */
const TWICE_NOTE =
  'test-gardener: tests/test_meshes.py already covers mesh_build with 19 tests (also tests/test_mesh_build_resume.py, 6). ' +
  'New test test_build_resume_twice is a near-duplicate of test_build_resume in tests/test_meshes.py (0.85) — parametrize them.'

/** A TypeScript project: one module covered by two test files, another with none. */
const TS_FILES: Record<string, string> = {
  [`${TS_ROOT}/package.json`]: '{ "name": "webshop" }\n',
  [`${TS_ROOT}/src/cart/total.ts`]: 'export const total = (items: { price: number; qty: number }[], opts?: { tax?: number }) => items.reduce((sum, i) => sum + i.price * i.qty, 0) * (1 + (opts?.tax ?? 0))\n',
  [`${TS_ROOT}/src/cart/discount.ts`]: 'export const discount = (price: number, rate: number) => Math.max(0, price * (1 - rate))\n',
  [`${TS_ROOT}/src/cart/total.test.ts`]: [
    "import { describe, expect, it } from 'vitest'",
    '',
    "import { total } from './total'",
    '',
    "describe('total', () => {",
    "  it('sums line items', () => {",
    '    expect(total([{ price: 2, qty: 1 }, { price: 3, qty: 2 }])).toBe(8)',
    '  })',
    '',
    "  it('applies tax', () => {",
    '    expect(total([{ price: 10, qty: 1 }], { tax: 0.2 })).toBe(12)',
    '  })',
    '',
    "  it('ignores empty carts', () => {",
    '    expect(total([])).toBe(0)',
    '  })',
    '})',
    '',
  ].join('\n'),
  [`${TS_ROOT}/src/cart/__tests__/rounding.test.ts`]: [
    "import { expect, it } from 'vitest'",
    '',
    "import { total } from '../total'",
    '',
    "it('rounds to cents', () => {",
    '  expect(total([{ price: 0.1, qty: 3 }])).toBeCloseTo(0.3)',
    '})',
    '',
  ].join('\n'),
}

const DISCOUNT_TEST = [
  "import { expect, it } from 'vitest'",
  '',
  "import { discount } from './discount'",
  '',
  "it('takes a percentage off', () => {",
  '  expect(discount(100, 0.25)).toBe(75)',
  '})',
  '',
  "it('rejects a negative rate', () => {",
  '  expect(() => discount(10, -1)).toThrow(RangeError)',
  '})',
  '',
].join('\n')
/** What tests_neighbourhood answers for `total` in the TypeScript project. */
const TOTAL_COVERED =
  'test-gardener: total is covered by src/cart/total.test.ts (3 tests: sums line items, applies tax, ignores empty carts) and src/cart/__tests__/rounding.test.ts (1 test: rounds to cents).\n' +
  'Extend one of these or parametrize an existing test rather than starting another file; past 40 tests a file is split by concern.'

const debit = ['def test_post_debit():', '    ledger = Ledger()', '    ledger.post("cash", 100, "debit")', '    assert ledger.balance("cash") == 100', '    assert ledger.entries == 1'].join('\n')
const credit = debit.replace('test_post_debit', 'test_post_credit').replace('"cash", 100, "debit"', '"cash", 250, "credit"').replace('== 100', '== 250')
const zero = ['def test_balance_zero():', '    ledger = Ledger()', '    assert ledger.balance("cash") == 0', '    assert ledger.entries == 0', '    assert not ledger.closed'].join('\n')
const slow = ['@pytest.mark.skip(reason="slow")', 'def test_slow_import():', '    assert import_all()'].join('\n')
const rollover = debit.replace('test_post_debit', 'test_rollover_debit')
const rolloverBalance = zero.replace('test_balance_zero', 'test_rollover_balance').replace('    assert not ledger.closed', '    assert not ledger.closed\n    assert ledger.rollover() is None')

/** A Python project with everything an audit lists: a cross-file clone, a near-copy, a parametrize pair, a skip, an orphan, an oversized file. */
const LEDGER_FILES: Record<string, string> = {
  [`${LEDGER_ROOT}/ledger/__init__.py`]: '',
  [`${LEDGER_ROOT}/ledger/posting.py`]: 'class Ledger:\n    pass\n',
  [`${LEDGER_ROOT}/ledger/report.py`]: 'def section_0():\n    return 0\n',
  [`${LEDGER_ROOT}/tests/helpers.py`]: 'def make_ledger():\n    return None\n',
  [`${LEDGER_ROOT}/tests/test_posting.py`]: ['import pytest', '', 'from ledger.posting import Ledger', '', '', debit, credit, zero, slow].join('\n\n\n') + '\n',
  [`${LEDGER_ROOT}/tests/test_posting_rollover.py`]: ['from ledger.posting import Ledger', '', '', rollover, rolloverBalance].join('\n\n\n') + '\n',
  [`${LEDGER_ROOT}/tests/test_legacy_export.py`]: 'import json\n\n\ndef test_export():\n    assert json.dumps({}) == "{}"\n',
  [`${LEDGER_ROOT}/tests/test_report.py`]:
    ['from ledger import report', '', '', ...Array.from({ length: 41 }, (_, i) => `def test_report_${i}():\n    assert report.section_${i}() == ${i}`)].join('\n\n\n') + '\n',
}

const RIPWIRE_OUT =
  '<!-- ripwire clones: function bodies with similar normalized token streams -->' +
  `<clones groups="2" type3="1" total="3" root="${LEDGER_ROOT}/tests">` +
  '<group type="2" gid="1" tokens="55" n="2"><f n="test_post_debit" p="test_posting.py:7"/><f n="test_rollover_debit" p="test_posting_rollover.py:5"/></group>' +
  '<group type="2" gid="2" tokens="55" n="2"><f n="test_post_debit" p="test_posting.py:7"/><f n="test_post_credit" p="test_posting.py:14"/></group>' +
  '<group type="3" gid="0" tokens="60" n="2" similarity="0.84"><f n="test_balance_zero" p="test_posting.py:21"/><f n="test_rollover_balance" p="test_posting_rollover.py:12"/></group>' +
  '</clones>'

const AUDIT_RIPWIRE = [
  'test-gardener audit: 4 test files · 48 tests · clones via ripwire',
  'Clones (≥ 0.9):',
  '- tests/test_posting.py::test_post_debit ≈ tests/test_posting_rollover.py::test_rollover_debit (1.00)',
  'Near-duplicates (≥ 0.6):',
  '- tests/test_posting.py::test_balance_zero ≈ tests/test_posting_rollover.py::test_rollover_balance (0.84)',
  'Parametrize candidates (same body, literals differ):',
  '- tests/test_posting.py: test_post_debit, test_post_credit',
  'Files over 40 tests:',
  '- tests/test_report.py (41)',
  'Skipped or xfail tests: 1 — tests/test_posting.py::test_slow_import',
  'Tests whose module no longer exists:',
  '- tests/test_legacy_export.py (legacy_export)',
].join('\n')

/** A branch diff adding `tests` test functions and `lines` lines to one test file. */
const branchDiff = (tests: number, lines: number): string => {
  const body: string[] = []
  for (let i = 0; i < tests; i++) {
    body.push(`+def test_branch_${i}():`, '+    assert True')
  }
  while (body.length < lines) {
    body.push('+')
  }
  return ['diff --git a/tests/test_branch.py b/tests/test_branch.py', 'new file mode 100644', '--- /dev/null', '+++ b/tests/test_branch.py', `@@ -0,0 +1,${lines} @@`, ...body].join('\n') + '\n'
}

const gitDiffs = (w: World): Ran[] => w.ran.filter(one => one.argv.startsWith('git diff'))

test('a new test file for a module other files cover, with a near-copy of a test, gets the note after the write', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  await begin($, PY_ROOT)

  const path = `${PY_ROOT}/tests/test_mesh_build_twice.py`
  const ran = await callTool($, { tool: 'Write', file_path: path, content: RESUME_TWICE })
  expect(w.files.get(path)).toBe(RESUME_TWICE)
  expect(ran.deny).toBeUndefined()
  expect(ran.context).toEqual([TWICE_NOTE])
  // The scan is kept across sessions, by path and mtime, under the home folder.
  expect(w.writes).toEqual([`${HOME}/.claude/test-gardener/${w.writes[0]?.split('/').pop()}`])
  expect(w.writes[0]).toMatch(/\/[0-9a-f]{8}\.json$/)
  expect(w.ran.map(one => one.argv).filter(argv => argv.startsWith('rg '))).toHaveLength(1)
  expect(w.ran.find(one => one.argv.startsWith('rg '))?.cwd).toBe(PY_ROOT)
})

test('the test that takes a file past the guideline gets the size note, and nothing else', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  await begin($, PY_ROOT)

  const ran = await callTool($, {
    tool: 'Edit',
    file_path: 'tests/test_mesh_faces.py',
    old_string: '# more tests below',
    new_string: pyTest('test_face_area_negative', ['with pytest.raises(ValueError):', '    area(-1, -1)']),
  })
  expect(w.files.get(`${PY_ROOT}/tests/test_mesh_faces.py`)).toContain('def test_face_area_negative():')
  expect(ran.context).toEqual([
    'test-gardener: This file now has 41 tests (guideline 40): split by concern or extend an existing file instead of starting another.',
  ])
})

test('a clean write says nothing: a fresh module, then an edit that copies nothing; the scan reads only what changed', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, TS_ROOT)
  seed(w, TS_FILES)
  w.gitRoot = null
  await begin($, TS_ROOT)

  const fresh = await callTool($, { tool: 'Write', file_path: `${TS_ROOT}/src/cart/discount.test.ts`, content: DISCOUNT_TEST })
  expect(fresh.context).toBeUndefined()
  expect(fresh.deny).toBeUndefined()
  expect(w.files.get(`${TS_ROOT}/src/cart/discount.test.ts`)).toBe(DISCOUNT_TEST)
  const rounding = `${TS_ROOT}/src/cart/__tests__/rounding.test.ts`
  const discount = `${TS_ROOT}/src/cart/discount.test.ts`
  const total = `${TS_ROOT}/src/cart/total.test.ts`
  // The written file's text is at hand; the two others are read once each for the scan.
  expect(w.reads.filter(path => path === discount)).toHaveLength(0)
  expect(w.reads.filter(path => path === rounding)).toHaveLength(1)
  expect(w.reads.filter(path => path === total)).toHaveLength(1)

  const edited = await callTool($, {
    tool: 'Edit',
    file_path: `${TS_ROOT}/src/cart/total.test.ts`,
    old_string: "  it('ignores empty carts', () => {\n    expect(total([])).toBe(0)\n  })",
    new_string:
      "  it('ignores empty carts', () => {\n    expect(total([])).toBe(0)\n  })\n\n  it('rejects a negative quantity', () => {\n    const cart = [{ price: 1, qty: -1 }]\n    expect(() => total(cart)).toThrow(RangeError)\n  })",
  })
  expect(edited.context).toBeUndefined()
  expect(w.files.get(`${TS_ROOT}/src/cart/total.test.ts`)).toContain('rejects a negative quantity')
  // The edited file is read for its text (the scan reuses it); discount.test.ts is unchanged, so the cache stands for it;
  // rounding.test.ts is read once more for its bodies, as the neighbour the new test is compared against.
  expect(w.reads.filter(path => path === discount)).toHaveLength(0)
  expect(w.reads.filter(path => path === total)).toHaveLength(2)
  expect(w.reads.filter(path => path === rounding)).toHaveLength(2)
  expect(w.ran.filter(one => one.argv.startsWith('rg '))).toHaveLength(2)
})

test('a write outside the test files passes through untouched, with no scan', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, TS_ROOT)
  seed(w, TS_FILES)
  await begin($, TS_ROOT)

  const ran = await callTool($, { tool: 'Write', file_path: `${TS_ROOT}/src/cart/total.ts`, content: 'export const total = () => 0\n' })
  expect(ran.context).toBeUndefined()
  expect(ran.text).toBe(`File written: ${TS_ROOT}/src/cart/total.ts`)
  expect(w.files.get(`${TS_ROOT}/src/cart/total.ts`)).toBe('export const total = () => 0\n')
  expect(w.ran.filter(one => one.argv.startsWith('rg '))).toHaveLength(0)
})

test('the tests_neighbourhood tool sits in the prompt, needs no permission, and answers by module or by path', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, TS_ROOT)
  seed(w, TS_FILES)
  await begin($, TS_ROOT)
  await clock.settle()

  expect(w.commands).toEqual(['tests'])
  expect(w.tools.map(tool => [tool.name, tool.isDeferred])).toEqual([['tests_neighbourhood', false]])
  expect(w.tools[0]?.description).toMatch(/before (adding|writing) tests/i)
  expect(await $.tool.check({ tool: TOOL, input: { module: 'total' } })).toMatchObject({ decision: 'allow' })

  expect(String((await callTool($, { tool: TOOL, module: 'total' })).result)).toBe(TOTAL_COVERED)
  expect(String((await callTool($, { tool: TOOL, path: 'src/cart/total.ts' })).result)).toBe(TOTAL_COVERED)
  expect(String((await callTool($, { tool: TOOL, path: `${TS_ROOT}/src/cart/__tests__/rounding.test.ts` })).result)).toBe(TOTAL_COVERED)
  expect(String((await callTool($, { tool: TOOL, module: 'discount' })).result)).toBe(
    'test-gardener: no test file names or imports discount yet. 2 test files live under src/cart/; a new one there keeps the layout.',
  )
  expect(String((await callTool($, { tool: TOOL })).result)).toBe(
    'test-gardener: pass `module` (the module under test, e.g. mesh_build) or `path` (a source file or a test file).',
  )
})

test('the first message carries the gardening block, three lines at most', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on, TS_ROOT)
  const out = await $.prompt.context({ blocks: [{ name: 'currentDate', text: "Today's date is 2026-11-09." }] })
  expect(out.blocks.map(block => block.name)).toEqual(['currentDate', 'testGardener'])
  const text = out.blocks[1]?.text ?? ''
  expect(text.split('\n')).toHaveLength(3)
  expect(text).toContain('tests_neighbourhood')
  expect(text).toContain('/tests audit')
  expect(text).toContain('40 tests')
  // Asked again after a compaction, the block is replaced, not doubled.
  const again = await $.prompt.context({ blocks: out.blocks })
  expect(again.blocks.map(block => block.name)).toEqual(['currentDate', 'testGardener'])
})

test("/tests audit merges ripwire's clones with the mod's own findings and suggests the consolidations", async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, LEDGER_ROOT)
  seed(w, LEDGER_FILES)
  w.ripwire = RIPWIRE_OUT
  await begin($, LEDGER_ROOT)

  const out = await $.command.run(typed('tests', 'audit'))
  expect(out.text).toBe(AUDIT_RIPWIRE)
  expect(w.ran.map(one => one.argv)).toContain(`ripwire ${LEDGER_ROOT}/tests --clones`)
  expect(w.suggested).toEqual([
    'Run the test suite first, then consolidate per /tests audit: merge the clone tests/test_posting.py::test_post_debit ≈ tests/test_posting_rollover.py::test_rollover_debit, ' +
      'parametrize test_post_debit and test_post_credit in tests/test_posting.py, split tests/test_report.py (41 tests) by concern; run the suite again and confirm it stays green.',
  ])
})

test('/tests audit without ripwire runs the own pairwise pass over files of the same module; /tests alone shows the usage', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, LEDGER_ROOT)
  seed(w, LEDGER_FILES)
  await begin($, LEDGER_ROOT)

  const out = await $.command.run(typed('tests', 'audit'))
  expect(out.text).toBe(
    [
      'test-gardener audit: 4 test files · 48 tests · own pairwise pass',
      'Clones (≥ 0.9):',
      '- tests/test_posting.py::test_post_debit ≈ tests/test_posting_rollover.py::test_rollover_debit (1.00)',
      '- tests/test_posting.py::test_post_credit ≈ tests/test_posting_rollover.py::test_rollover_debit (1.00)',
      'Near-duplicates (≥ 0.6):',
      '- tests/test_posting.py::test_balance_zero ≈ tests/test_posting_rollover.py::test_rollover_balance (0.76)',
      'Parametrize candidates (same body, literals differ):',
      '- tests/test_posting.py: test_post_debit, test_post_credit',
      'Files over 40 tests:',
      '- tests/test_report.py (41)',
      'Skipped or xfail tests: 1 — tests/test_posting.py::test_slow_import',
      'Tests whose module no longer exists:',
      '- tests/test_legacy_export.py (legacy_export)',
    ].join('\n'),
  )
  expect(w.suggested).toHaveLength(1)
  // A subtree narrows the audit.
  const scoped = await $.command.run(typed('tests', 'audit tests/test_legacy_export.py'))
  expect(scoped.text).toBe(
    'test-gardener audit of tests/test_legacy_export.py: 1 test file · 1 test · own pairwise pass\n' +
      'Tests whose module no longer exists:\n- tests/test_legacy_export.py (legacy_export)',
  )
  expect((await $.command.run(typed('tests', ''))).text).toBe('Usage: /tests audit [path] — the consolidation report: clones, near-duplicates, parametrize candidates, files over 40 tests, skips, tests whose module is gone.')
  expect((await $.command.run(typed('tests', 'prune'))).text).toMatch(/^Usage: \/tests audit \[path\]/)
})

test('the band shows a branch heavy with tests on terminal and desktop, stacks over another band, and Hide hides it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.diff = branchDiff(38, 1204)
  await begin($, PY_ROOT)
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(1)
  expect(gitDiffs(w)[0]?.argv).toMatch(/^git diff -U0 origin\/main\.\.\.HEAD -- :\(glob\)\*\*\/test_\*\.py /)

  const LINE = '38 tests · +1,204 lines of tests on this branch → /tests audit'
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test-gardener', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await ui.drawn()) as Node)).toBe(LINE)
    expect(await ui.find({ type: 'Button' })).toBeDefined()
    await ui.unmount()
  }
  w.otherBand = 'main ↑1 · 3 changed'
  const stacked = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await stacked.drawn()) as Node)).toBe(`${LINE}main ↑1 · 3 changed`)
  await stacked.press({ key: 'hide' })
  expect(shown((await stacked.drawn()) as Node)).toBe('main ↑1 · 3 changed')
  await stacked.unmount()
  // A survey holding the band is left alone.
  const survey = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(shown((await survey.drawn()) as Node)).toBe('main ↑1 · 3 changed')
})

test('the band stays silent under the thresholds, on the default branch, and outside a git repository', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.diff = branchDiff(25, 800)
  await begin($, PY_ROOT)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toBe('')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
  expect(gitDiffs(w)).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })

  // On the default branch there is nothing to diff.
  w.branch = 'main'
  await begin($, PY_ROOT)
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
})

test('outside a git repository nothing is run but the root check', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, TS_ROOT)
  seed(w, TS_FILES)
  w.gitRoot = null
  w.diff = branchDiff(40, 900)
  await begin($, TS_ROOT)
  await clock.settle()
  expect(w.ran.map(one => one.argv).filter(argv => argv.startsWith('git '))).toEqual(['git rev-parse --show-toplevel'])
  const ui = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toBe('')
})

test('the branch count refreshes after a turn at most every two minutes; a lowered threshold shows the band', { options: { bigBranchTests: 3 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.diff = branchDiff(4, 30)
  await begin($, PY_ROOT)
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(1)

  await $.turn.complete(TURN)
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(1)
  await clock.advance(2 * 60_000)
  await $.turn.complete(TURN)
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(2)
  // A subagent's turn is not a refresh.
  await clock.advance(2 * 60_000)
  await $.turn.complete({ ...TURN, agentId: 'agent_1' })
  await clock.settle()
  expect(gitDiffs(w)).toHaveLength(2)

  const ui = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(shown((await ui.drawn()) as Node)).toBe('4 tests · +30 lines of tests on this branch → /tests audit')
})

test('without rg on PATH it is never started: the files come from git ls-files, said once in the debug log', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.rg = false
  await begin($, PY_ROOT)

  const ran = await callTool($, { tool: 'Write', file_path: `${PY_ROOT}/tests/test_mesh_build_twice.py`, content: RESUME_TWICE })
  expect(ran.context).toEqual([TWICE_NOTE])
  // A second listing, for the tool: the probe is not repeated, nor the log line.
  expect(String((await callTool($, { tool: TOOL, module: 'mesh_faces' })).result)).toMatch(/^test-gardener: mesh_faces is covered by tests\/test_mesh_faces\.py/)
  const argvs = w.ran.map(one => one.argv)
  expect(argvs.filter(argv => argv.startsWith('rg '))).toHaveLength(0)
  expect(argvs.filter(argv => argv === LS_FILES)).toEqual([LS_FILES, LS_FILES])
  expect(w.ran.find(one => one.argv === LS_FILES)?.cwd).toBe(PY_ROOT)
  expect(w.logs.filter(line => line.includes('rg'))).toEqual(['test-gardener: rg is not on PATH; files are listed with git ls-files'])
})

test('without rg and outside git the files come from a walk of the tree, hidden and vendored folders left out', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, TS_ROOT)
  seed(w, TS_FILES)
  // Test files a walk must not pick up: under node_modules and under a hidden folder.
  seed(w, {
    [`${TS_ROOT}/node_modules/cart-kit/total.test.js`]: "import { total } from '../../src/cart/total'\n\nit('is vendored', () => {})\n",
    [`${TS_ROOT}/.cache/total.test.ts`]: "import { total } from '../src/cart/total'\n\nit('is hidden', () => {})\n",
  })
  w.rg = false
  w.gitRoot = null
  await begin($, TS_ROOT)
  await clock.settle()

  expect(String((await callTool($, { tool: TOOL, module: 'total' })).result)).toBe(TOTAL_COVERED)
  expect(w.ran.map(one => one.argv)).toEqual(['git rev-parse --show-toplevel'])
  expect(w.logs.filter(line => line.includes('rg'))).toEqual(['test-gardener: rg is not on PATH; files are listed with a directory walk'])
})

test('the default branch comes from one for-each-ref read: origin/HEAD, else origin/main, origin/master, main, master; none: nothing to diff', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.diff = branchDiff(38, 1204)
  const cases: [string[], string | null][] = [
    [['refs/heads/main\t', 'refs/remotes/origin/HEAD\trefs/remotes/origin/develop', 'refs/remotes/origin/main\t'], 'origin/develop'],
    [['refs/heads/master\t', 'refs/remotes/origin/main\t', 'refs/remotes/origin/master\t'], 'origin/main'],
    [['refs/heads/master\t', 'refs/remotes/origin/master\t'], 'origin/master'],
    [['refs/heads/main\t', 'refs/heads/master\t'], 'main'],
    [['refs/heads/master\t'], 'master'],
    [[], null],
  ]
  for (const [rows, base] of cases) {
    w.refs = refLines(...rows)
    const before = gitDiffs(w).length
    await begin($, PY_ROOT)
    await clock.settle()
    if (base === null) {
      // A repository with neither main nor master: the checked-out branch stands in, so there is nothing to diff and no band.
      expect(gitDiffs(w)).toHaveLength(before)
      const ui = await $.ui.mount({ plugin: 'test-gardener', surface: 'terminal', component: 'AbovePrompt', props: BAND })
      expect(shown((await ui.drawn()) as Node)).toBe('')
      await ui.unmount()
    } else {
      expect(gitDiffs(w)).toHaveLength(before + 1)
      expect(gitDiffs(w).at(-1)?.argv.startsWith(`git diff -U0 ${base}...HEAD -- `)).toBe(true)
    }
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  }
  const gits = w.ran.map(one => one.argv).filter(argv => argv.startsWith('git '))
  expect(gits.filter(argv => argv === FOR_EACH_REF)).toHaveLength(cases.length)
  expect(gits.some(argv => argv.includes('symbolic-ref') || argv.includes('rev-parse --verify'))).toBe(false)
})

test('a session in the home folder scans nothing: the tool says so, a test file written there gets no note, no listing runs', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, HOME)
  w.gitRoot = null
  seed(w, { [`${HOME}/notes/tests/test_notes.py`]: 'def test_notes():\n    assert True\n' })
  await begin($, HOME)
  await clock.settle()

  expect(String((await callTool($, { tool: TOOL, module: 'checks' })).result)).toBe(
    'test-gardener: this session runs in your home folder, not a project, so no test files are scanned; start Claude in the project folder and ask again.',
  )
  const ran = await callTool($, { tool: 'Write', file_path: `${HOME}/notes/tests/test_more.py`, content: 'def test_notes():\n    assert True\n' })
  expect(ran.context).toBeUndefined()
  expect(w.ran.map(one => one.argv)).toEqual(['git rev-parse --show-toplevel'])
  expect(w.logs).toEqual([])
})

test('a test under tests/ importing ../hooks/<module> is reported as covering hooks/<module>.ts, by relative or absolute path or by name', async ($, on) => {
  mock.clock(on, { now: 0 })
  const MOD_ROOT = '/home/dev/gardener'
  const w = world(on, MOD_ROOT)
  seed(w, {
    [`${MOD_ROOT}/hooks/checks.ts`]: 'export const check = (doc: string): number => doc.length\n',
    [`${MOD_ROOT}/hooks/register.tsx`]: 'export const register = () => undefined\n',
    [`${MOD_ROOT}/tests/checks.test.ts`]: [
      "import { expect, test } from 'claude-code/testing'",
      '',
      "import { check } from '../hooks/checks'",
      "import type { Doc } from '../hooks/checks'",
      '',
      "test('validates a doc', async () => {",
      "  expect(check('# Title')).toBe(7)",
      '})',
      '',
      "test('reports a dead link', async () => {",
      "  expect(check('')).toBe(0)",
      '})',
      '',
    ].join('\n'),
    [`${MOD_ROOT}/tests/register.test.tsx`]: ["import { test } from 'claude-code/testing'", '', "import { register } from '../hooks/register'", '', "test('registers', async () => {", '  register()', '})', ''].join('\n'),
  })
  await begin($, MOD_ROOT)

  const covered =
    'test-gardener: checks is covered by tests/checks.test.ts (2 tests: validates a doc, reports a dead link).\n' +
    'Extend one of these or parametrize an existing test rather than starting another file; past 40 tests a file is split by concern.'
  expect(String((await callTool($, { tool: TOOL, path: 'hooks/checks.ts' })).result)).toBe(covered)
  expect(String((await callTool($, { tool: TOOL, path: `${MOD_ROOT}/hooks/checks.ts` })).result)).toBe(covered)
  expect(String((await callTool($, { tool: TOOL, module: 'checks' })).result)).toBe(covered)
  expect(String((await callTool($, { tool: TOOL, path: 'hooks/register.tsx' })).result)).toMatch(/^test-gardener: register is covered by tests\/register\.test\.tsx \(1 test: registers\)\./)
})

test('the root is asked again when the session folder changes: a start outside the project does not hold for the session', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  // In a session's first second the engine has answered another folder: every probe then said "not a git repository".
  w.cwd = '/nowhere'
  await begin($, '/nowhere')
  await clock.settle()
  expect(w.ran.map(one => one.argv)).toEqual(['git rev-parse --show-toplevel'])

  w.cwd = PY_ROOT
  const out = await $.command.run(typed('tests', 'audit'))
  expect(out.text).toMatch(/^test-gardener audit: \d+ test files · \d+ tests · own pairwise pass/)
  expect(w.ran.filter(one => one.argv === 'git rev-parse --show-toplevel').map(one => one.cwd)).toEqual(['/nowhere', PY_ROOT])
  expect(w.ran.find(one => one.argv.startsWith('rg --files'))?.cwd).toBe(PY_ROOT)
})

test('rg that cannot start gives way to git ls-files; when git cannot list either, the audit and the tool say so; a project without tests is told apart from a listing that failed', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on, PY_ROOT)
  seed(w, PY_FILES)
  w.rgStarts = false
  await begin($, PY_ROOT)

  const out = await $.command.run(typed('tests', 'audit'))
  expect(out.text).toMatch(/^test-gardener audit: \d+ test files · \d+ tests/)
  expect(w.ran.filter(one => one.argv === LS_FILES).length).toBeGreaterThan(0)
  expect(w.logs.some(line => /rg did not run: .*ENOENT/.test(line))).toBe(true)

  // Neither lister: no answer of "0 test files" that would pass for a project without tests.
  w.lsFiles = false
  const failed = `the files under ${PY_ROOT} could not be listed (rg could not start; git ls-files could not start)`
  expect((await $.command.run(typed('tests', 'audit'))).text).toBe(`test-gardener: ${failed}; nothing was audited.`)
  expect(String((await callTool($, { tool: TOOL, module: 'mesh_faces' })).result)).toBe(`test-gardener: ${failed}, so nothing is known about its tests.`)

  // No test files at all, listed fine: said plainly, with what listed the files.
  w.lsFiles = true
  for (const path of [...w.files.keys()]) {
    if (path.startsWith(`${PY_ROOT}/tests/`)) {
      w.files.delete(path)
      w.mtimes.delete(path)
    }
  }
  const left = [...w.files.keys()].filter(path => path.startsWith(`${PY_ROOT}/`)).length
  expect((await $.command.run(typed('tests', 'audit'))).text).toBe(`test-gardener audit: no test files under the project among the ${left} files git ls-files listed.`)
})
