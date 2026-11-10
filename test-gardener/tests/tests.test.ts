import { expect, test } from 'claude-code/testing'

import type { GardenerSettings } from '../types'
import {
  assembleAudit,
  auditSuggestion,
  auditText,
  bandText,
  countBranchTests,
  coversModule,
  extractTests,
  findDuplicates,
  hashOf,
  importsOf,
  isBigBranch,
  isTestFile,
  languageOf,
  moduleName,
  moduleOf,
  neighbourhood,
  neighbourhoodText,
  normalizeBody,
  parseRipwireClones,
  primaryModule,
  relative,
  similarity,
  writeNote,
} from '../hooks/tests'
import type { Duplicate, TestFileInfo, TestUnit } from '../hooks/tests'

const SETTINGS: GardenerSettings = { nearDuplicate: 0.6, maxTestsPerFile: 40, bigBranchTests: 25, bigBranchLines: 800, modelReview: false }

const PY = [
  'import pytest',
  'from meshkit.mesh_build import build',
  '',
  '',
  '@pytest.mark.parametrize("cells", [1, 2])',
  'def test_build_cells(cells):',
  '    assert build(cells)["cells"] == cells',
  '',
  '',
  'class TestResume:',
  '    @pytest.mark.skip(reason="slow")',
  '    def test_resume_path(self):',
  '        assert True',
  '',
  '    async def test_resume_async(self):',
  '        assert resume("a", 1)["checkpoint"] == 1',
  '',
  '',
  'def helper():',
  '    return 1',
].join('\n')

const TS = [
  "import { total } from '../total'",
  "import { describe, expect, it, test } from 'vitest'",
  '',
  "describe('total', () => {",
  "  it('sums line items', () => {",
  '    expect(total([1, 2])).toBe(3)',
  '  })',
  '',
  "  it.skip('applies tax', () => {",
  '    expect(total([1], { tax: 0.2 })).toBe(1.2)',
  '  })',
  '',
  "  test.each([[1], [2]])('handles %s', (n) => {",
  '    expect(total([n])).toBe(n)',
  '  })',
  '})',
  '',
  'const limit = (n: number) => n // `limit(` is not `it(`',
].join('\n')

const GO = [
  'package mesh',
  '',
  'import "testing"',
  '',
  'func TestBuild(t *testing.T) {',
  '\tif build(2) != 4 {',
  '\t\tt.Fatal("bad")',
  '\t}',
  '}',
  '',
  'func TestResume(t *testing.T) {',
  '\tt.Skip("flaky")',
  '}',
  '',
  'func helper() {}',
  '',
  'func (s *Suite) TestSuiteThing() {',
  '\ts.Equal(1, 1)',
  '}',
].join('\n')

const RB = [
  "require 'rails_helper'",
  "require_relative '../lib/mesh_build'",
  '',
  'RSpec.describe MeshBuild do',
  "  it 'builds cells' do",
  '    expect(described_class.build(2)).to eq(4)',
  '  end',
  '',
  "  xit 'resumes' do",
  "    expect(described_class.resume('a')).to eq('a')",
  '  end',
  '',
  '  it "skips later" do',
  "    skip 'not yet'",
  '    expect(1).to eq(1)',
  '  end',
  'end',
].join('\n')

const RS = [
  'use meshkit::build::build;',
  '',
  '#[test]',
  'fn builds_cells() {',
  '    assert_eq!(build(2), 4);',
  '}',
  '',
  '#[test]',
  '#[ignore]',
  'fn resumes_slowly() {',
  '    assert!(true);',
  '}',
  '',
  'fn helper() -> u32 { 1 }',
].join('\n')

/** The test the example note is about, and its near-copy with one more assertion. */
const RESUME = [
  'def test_build_resume():',
  '    mesh = build(8)',
  '    state = resume("runs/mesh.ckpt", checkpoint=3)',
  '    assert state["path"] == "runs/mesh.ckpt"',
  '    assert state["checkpoint"] == 3',
  '    assert mesh["faces"] == 16',
].join('\n')
const RESUME_TWICE = [
  'def test_build_resume_twice():',
  '    mesh = build(8)',
  '    state = resume("runs/mesh.ckpt", checkpoint=3)',
  '    assert state["path"] == "runs/mesh.ckpt"',
  '    assert state["checkpoint"] == 3',
  '    assert mesh["faces"] == 16',
  '    assert isinstance(mesh, dict)',
].join('\n')

const pyUnit = (text: string): TestUnit => {
  const [first] = extractTests('tests/test_x.py', text)
  if (!first) {
    throw new Error('no test in the snippet')
  }
  return first
}

const INFOS: TestFileInfo[] = [
  {
    path: '/home/dev/meshkit/tests/test_meshes.py',
    mtimeMs: 1,
    module: 'meshes',
    imports: ['pytest', 'mesh_build', 'build', 'resume'],
    tests: Array.from({ length: 19 }, (_, i) => ({ name: i === 0 ? 'test_build_resume' : `test_mesh_${i}`, line: i * 5 + 4, isParametrized: false, isSkipped: false })),
  },
  {
    path: '/home/dev/meshkit/tests/test_mesh_build_resume.py',
    mtimeMs: 1,
    module: 'mesh_build_resume',
    imports: ['mesh_build'],
    tests: Array.from({ length: 6 }, (_, i) => ({ name: `test_resume_${i}`, line: i * 5 + 4, isParametrized: false, isSkipped: false })),
  },
  {
    path: '/home/dev/meshkit/tests/test_faces.py',
    mtimeMs: 1,
    module: 'faces',
    imports: ['mesh_faces'],
    tests: [{ name: 'test_faces', line: 4, isParametrized: false, isSkipped: false }],
  },
]

test('a test file is told from a source file per language', async () => {
  for (const path of [
    'tests/test_mesh.py',
    'pkg/mesh_test.py',
    'tests/unit/helpers.py',
    'test/x.py',
    '/abs/project/tests/test_mesh.py',
    'src/a.test.ts',
    'src/a.spec.jsx',
    'src/__tests__/a.ts',
    'pkg/mesh_test.go',
    'spec/models/user_spec.rb',
    'tests/build.rs',
  ]) {
    expect(isTestFile(path)).toBe(true)
  }
  for (const path of [
    'src/mesh.py',
    'tests/conftest.py',
    'tests/__init__.py',
    'src/a.ts',
    'src/testing.ts',
    'src/latest.js',
    'src/contest.py',
    'attest_utils.py',
    'testing/foo.py',
    'pkg/mesh.go',
    'app/models/user.rb',
    'src/lib.rs',
    'tests/data.json',
    'tests/README.md',
    'tests',
  ]) {
    expect(isTestFile(path)).toBe(false)
  }
  expect(languageOf('a/b.tsx')).toBe('js')
  expect(languageOf('a/b.mjs')).toBe('js')
  expect(languageOf('a/b.rb')).toBe('ruby')
  expect(languageOf('a/b.txt')).toBeNull()
})

test('the module under test comes from the file name', async () => {
  expect(moduleOf('tests/test_mesh_build.py')).toBe('mesh_build')
  expect(moduleOf('pkg/mesh_test.py')).toBe('mesh')
  expect(moduleOf('tests/helpers.py')).toBe('helpers')
  expect(moduleOf('tests/conftest.py')).toBeNull()
  expect(moduleOf('src/cart/total.test.ts')).toBe('total')
  expect(moduleOf('src/cart/Total.spec.tsx')).toBe('total')
  expect(moduleOf('src/__tests__/total.ts')).toBe('total')
  expect(moduleOf('src/cart/__tests__/index.test.ts')).toBe('cart')
  expect(moduleOf('pkg/mesh_test.go')).toBe('mesh')
  expect(moduleOf('spec/models/user_spec.rb')).toBe('user')
  expect(moduleOf('tests/build.rs')).toBe('build')
  expect(moduleOf('src/mesh.py')).toBeNull()
  expect(moduleName('src/cart/total.ts')).toBe('total')
  expect(moduleName('meshkit.mesh_build')).toBe('mesh_build')
  expect(moduleName('pkg.io')).toBe('io')
  expect(moduleName('Mesh.py')).toBe('mesh')
})

test('python tests are extracted with their line, parametrize and skip marks', async () => {
  const units = extractTests('tests/test_mesh.py', PY)
  expect(units.map(u => u.name)).toEqual(['test_build_cells', 'test_resume_path', 'test_resume_async'])
  expect(units.map(u => u.line)).toEqual([6, 12, 15])
  expect(units.map(u => u.isParametrized)).toEqual([true, false, false])
  expect(units.map(u => u.isSkipped)).toEqual([false, true, false])
  expect(units[0]?.body).toBe('def test_build_cells(cells):\n    assert build(cells)["cells"] == cells')
  expect(units[2]?.body).toBe('    async def test_resume_async(self):\n        assert resume("a", 1)["checkpoint"] == 1')
  expect(importsOf('tests/test_mesh.py', PY)).toEqual(['pytest', 'mesh_build', 'build'])
  expect(importsOf('tests/test_mesh.py', 'from . import mesh_build\nfrom .faces import area as a, perimeter\nimport os, sys')).toEqual([
    'mesh_build',
    'faces',
    'area',
    'perimeter',
    'os',
    'sys',
  ])
})

test('js and ts tests are extracted by title; `limit(` is not `it(`', async () => {
  const units = extractTests('src/cart/total.test.ts', TS)
  expect(units.map(u => u.name)).toEqual(['sums line items', 'applies tax', 'handles %s'])
  expect(units.map(u => u.line)).toEqual([5, 9, 13])
  expect(units.map(u => u.isSkipped)).toEqual([false, true, false])
  expect(units.map(u => u.isParametrized)).toEqual([false, false, true])
  expect(units[0]?.body).toBe("it('sums line items', () => {\n    expect(total([1, 2])).toBe(3)\n  })")
  expect(importsOf('src/cart/total.test.ts', TS)).toEqual(['total'])
  expect(importsOf('src/a.test.ts', "const x = require('../lib/index')\njest.mock('@/services/mailer')\nimport z from 'zod'")).toEqual(['lib', 'mailer'])
  expect(extractTests('src/a.test.ts', "test(`adds ${n}`, () => {})").map(u => u.name)).toEqual(['test@1'])
  // A test call inside a string literal (a fixture holding test source) is not a test.
  expect(extractTests('src/a.test.ts', 'const sample = "it(\'inner\', () => {})"\nit(\'outer\', () => {\n  expect(sample).toBeTruthy()\n})').map(u => u.name)).toEqual(['outer'])
})

test('go, ruby and rust tests are extracted with skips and imports', async () => {
  const go = extractTests('pkg/mesh_test.go', GO)
  expect(go.map(u => u.name)).toEqual(['TestBuild', 'TestResume', 'TestSuiteThing'])
  expect(go.map(u => u.isSkipped)).toEqual([false, true, false])
  expect(go[0]?.body).toBe('func TestBuild(t *testing.T) {\n\tif build(2) != 4 {\n\t\tt.Fatal("bad")\n\t}\n}')
  expect(importsOf('pkg/mesh_test.go', GO)).toEqual([])

  const rb = extractTests('spec/mesh_build_spec.rb', RB)
  expect(rb.map(u => u.name)).toEqual(['builds cells', 'resumes', 'skips later'])
  expect(rb.map(u => u.isSkipped)).toEqual([false, true, true])
  expect(rb[0]?.body).toBe("  it 'builds cells' do\n    expect(described_class.build(2)).to eq(4)\n  end")
  expect(importsOf('spec/mesh_build_spec.rb', RB)).toEqual(['mesh_build'])

  const rs = extractTests('tests/build.rs', RS)
  expect(rs.map(u => u.name)).toEqual(['builds_cells', 'resumes_slowly'])
  expect(rs.map(u => u.isSkipped)).toEqual([false, true])
  expect(rs.map(u => u.line)).toEqual([4, 10])
  expect(importsOf('tests/build.rs', RS)).toEqual(['meshkit', 'build'])
})

test('bodies normalise to tokens with literals as placeholders and the test name as NAME', async () => {
  const tokens = normalizeBody('def test_a():\n    # a comment\n    x = f"v{n}" + \'s\'  # trailing\n    assert x == 0x1f and y != 1_000.5', 'python', 'test_a')
  expect(tokens).toEqual(['def', 'NAME', '(', ')', ':', 'x', '=', 'STR', '+', 'STR', 'assert', 'x', '==', 'NUM', 'and', 'y', '!=', 'NUM'])
  expect(normalizeBody("it('t', () => { /* c */ const s = `a${b}`; expect(s).toBe('x') // c\n})", 'js')).toEqual([
    'it', '(', 'STR', ',', '(', ')', '=>', '{', 'const', 's', '=', 'STR', ';', 'expect', '(', 's', ')', '.', 'toBe', '(', 'STR', ')', '}', ')',
  ])
  // Long bodies are cut at 400 tokens so a dump file stays cheap to compare.
  expect(normalizeBody(Array.from({ length: 300 }, (_, i) => `a${i} = ${i}`).join('\n'), 'python')).toHaveLength(400)
})

test('shingle similarity: identical 1, a near-copy with one more assertion 0.85, literals-only 1, unrelated low', async () => {
  const a = pyUnit(RESUME)
  const b = pyUnit(RESUME_TWICE)
  expect(similarity(a, a, 'python')).toBe(1)
  // 35 shingles shared of 41: the repeated `assert state [ STR ] ==` windows collapse in the set.
  expect(Number(similarity(a, b, 'python').toFixed(3))).toBe(0.854)
  const literals = pyUnit(RESUME.replace('test_build_resume', 'test_build_resume_big').replace('build(8)', 'build(64)').replace('== 16', '== 128'))
  expect(similarity(a, literals, 'python')).toBe(1)
  const other = pyUnit('def test_other():\n    with pytest.raises(ValueError):\n        parse_header(b"")\n')
  expect(similarity(a, other, 'python')).toBeLessThan(0.1)
})

test('duplicates are classified: clone, near, and parametrize within one file', async () => {
  const resume = pyUnit(RESUME)
  const twice = pyUnit(RESUME_TWICE)
  const big = pyUnit(RESUME.replace('test_build_resume', 'test_build_resume_big').replace('build(8)', 'build(64)').replace('== 16', '== 128'))
  const renamed = pyUnit(RESUME.replace('test_build_resume', 'test_resume_again'))
  const other = pyUnit('def test_other():\n    with pytest.raises(ValueError):\n        parse_header(b"")\n')
  const fresh = [
    { file: 'tests/test_new.py', unit: twice },
    { file: 'tests/test_new.py', unit: big },
    { file: 'tests/test_new.py', unit: other },
  ]
  const pool = [
    { file: 'tests/test_meshes.py', unit: resume },
    { file: 'tests/test_meshes.py', unit: renamed },
  ]
  const found = findDuplicates(fresh, pool, 'python', 0.6)
  expect(found.map(d => [d.a.name, d.b.name, d.kind, Number(d.similarity.toFixed(2))])).toEqual([
    ['test_build_resume_big', 'test_build_resume', 'clone', 1],
    ['test_build_resume_big', 'test_resume_again', 'clone', 1],
    ['test_build_resume_twice', 'test_build_resume', 'near', 0.85],
    ['test_build_resume_twice', 'test_resume_again', 'near', 0.85],
    ['test_build_resume_twice', 'test_build_resume_big', 'near', 0.85],
  ])
  // Two tests of one file whose bodies differ only in literals are a parametrize candidate, not a clone.
  const same = findDuplicates([{ file: 'tests/test_new.py', unit: big }], [{ file: 'tests/test_new.py', unit: resume }], 'python', 0.6)
  expect(same).toEqual([{ a: { file: 'tests/test_new.py', name: 'test_build_resume_big' }, b: { file: 'tests/test_new.py', name: 'test_build_resume' }, similarity: 1, kind: 'parametrize' }])
  // A pair under the threshold is not reported, and a test never pairs with itself.
  expect(findDuplicates(fresh, pool, 'python', 0.9).map(d => d.kind)).toEqual(['clone', 'clone'])
})

test('the neighbourhood of a module is the test files naming it or importing it', async () => {
  expect(coversModule({ module: 'meshes', imports: ['mesh_build'] }, 'mesh_build')).toBe(true)
  expect(coversModule({ module: 'mesh_build_resume', imports: [] }, 'mesh_build')).toBe(true)
  expect(coversModule({ module: 'mesh', imports: [] }, 'mesh_build')).toBe(true)
  expect(coversModule({ module: 'meshes', imports: ['faces'] }, 'mesh_build')).toBe(false)
  expect(coversModule({ module: null, imports: ['Mesh_Build'] }, 'mesh_build')).toBe(true)
  const near = neighbourhood('mesh_build', INFOS, '/home/dev/meshkit/tests/test_mesh_build_twice.py')
  expect(near.map(n => [n.path, n.count])).toEqual([
    ['/home/dev/meshkit/tests/test_meshes.py', 19],
    ['/home/dev/meshkit/tests/test_mesh_build_resume.py', 6],
  ])
  expect(near[0]?.names.slice(0, 2)).toEqual(['test_build_resume', 'test_mesh_1'])
  expect(neighbourhood('mesh_build', INFOS, '/home/dev/meshkit/tests/test_meshes.py').map(n => n.path)).toEqual(['/home/dev/meshkit/tests/test_mesh_build_resume.py'])
  // The module a new file is about: the first candidate (file name, then imports) another test file covers.
  expect(primaryModule(['mesh_build_twice', 'meshkit', 'mesh_build', 'build'], INFOS, '/home/dev/meshkit/tests/test_mesh_build_twice.py')).toBe('mesh_build')
  expect(primaryModule(['discount', 'money'], INFOS)).toBe('discount')
  expect(primaryModule([], INFOS)).toBeNull()
})

test('the note after a write: coverage, the near-duplicate, the size; nothing for a clean write', async () => {
  const neighbours = [
    { path: 'tests/test_meshes.py', count: 19, names: ['test_build_resume'] },
    { path: 'tests/test_mesh_build_resume.py', count: 6, names: ['test_resume_0'] },
  ]
  const near: Duplicate = {
    a: { file: 'tests/test_mesh_build_twice.py', name: 'test_build_resume_twice' },
    b: { file: 'tests/test_meshes.py', name: 'test_build_resume' },
    similarity: 0.8537,
    kind: 'near',
  }
  expect(writeNote({ file: 'tests/test_mesh_build_twice.py', module: 'mesh_build', isNew: true, count: 1, neighbours, duplicates: [near] }, SETTINGS)).toBe(
    'test-gardener: tests/test_meshes.py already covers mesh_build with 19 tests (also tests/test_mesh_build_resume.py, 6). ' +
      'New test test_build_resume_twice is a near-duplicate of test_build_resume in tests/test_meshes.py (0.85) — parametrize them.',
  )
  expect(writeNote({ file: 'tests/test_mesh_faces.py', module: 'mesh_faces', isNew: false, count: 41, neighbours: [], duplicates: [] }, SETTINGS)).toBe(
    'test-gardener: This file now has 41 tests (guideline 40): split by concern or extend an existing file instead of starting another.',
  )
  // A new file for a module other files already cover, with nothing copied: the coverage alone, with the nudge.
  expect(writeNote({ file: 'tests/test_mesh_build_more.py', module: 'mesh_build', isNew: true, count: 2, neighbours, duplicates: [] }, SETTINGS)).toBe(
    'test-gardener: tests/test_meshes.py already covers mesh_build with 19 tests (also tests/test_mesh_build_resume.py, 6). Extend one of them rather than starting another file.',
  )
  // An edit of an existing file that copies nothing and stays under the guideline says nothing, neighbours or not.
  expect(writeNote({ file: 'tests/test_meshes.py', module: 'mesh_build', isNew: false, count: 20, neighbours: [neighbours[1]!], duplicates: [] }, SETTINGS)).toBeNull()
  expect(writeNote({ file: 'src/cart/discount.test.ts', module: 'discount', isNew: true, count: 2, neighbours: [], duplicates: [] }, SETTINGS)).toBeNull()
  // Same-file clone and parametrize wording; three duplicates at most, the rest counted.
  const same = (name: string, other: string, similarity: number, kind: Duplicate['kind']): Duplicate => ({
    a: { file: 'tests/test_meshes.py', name },
    b: { file: 'tests/test_meshes.py', name: other },
    similarity,
    kind,
  })
  expect(
    writeNote(
      {
        file: 'tests/test_meshes.py',
        module: 'mesh_build',
        isNew: false,
        count: 24,
        neighbours: [],
        duplicates: [same('test_a2', 'test_a', 1, 'parametrize'), same('test_b2', 'test_b', 0.951, 'clone'), same('test_c2', 'test_c', 0.7, 'near'), same('test_d2', 'test_d', 0.65, 'near')],
      },
      SETTINGS,
    ),
  ).toBe(
    'test-gardener: New test test_a2 differs from test_a only in literals — parametrize them. ' +
      'New test test_b2 is a clone of test_b (0.95) — keep one of them, or parametrize. ' +
      'New test test_c2 is a near-duplicate of test_c (0.70) — parametrize them. And 1 more near-duplicate.',
  )
})

test('the neighbourhood report for the tool, with and without covering files', async () => {
  const files = [
    { path: 'src/cart/total.test.ts', count: 3, names: ['sums line items', 'applies tax', 'ignores empty carts'] },
    { path: 'src/cart/__tests__/rounding.test.ts', count: 1, names: ['rounds to cents'] },
  ]
  expect(neighbourhoodText('total', files, SETTINGS, null)).toBe(
    'test-gardener: total is covered by src/cart/total.test.ts (3 tests: sums line items, applies tax, ignores empty carts) and src/cart/__tests__/rounding.test.ts (1 test: rounds to cents).\n' +
      'Extend one of these or parametrize an existing test rather than starting another file; past 40 tests a file is split by concern.',
  )
  const many = [{ path: 'tests/test_meshes.py', count: 19, names: Array.from({ length: 19 }, (_, i) => `test_m${i}`) }]
  expect(neighbourhoodText('mesh_build', many, SETTINGS, null).split('\n')[0]).toBe(
    'test-gardener: mesh_build is covered by tests/test_meshes.py (19 tests: test_m0, test_m1, test_m2, test_m3, test_m4, test_m5, test_m6, test_m7 and 11 more).',
  )
  expect(neighbourhoodText('discount', [], SETTINGS, { count: 2, dir: 'src/cart' })).toBe(
    'test-gardener: no test file names or imports discount yet. 2 test files live under src/cart/; a new one there keeps the layout.',
  )
  expect(neighbourhoodText('discount', [], SETTINGS, null)).toBe('test-gardener: no test file names or imports discount yet.')
})

test('a branch diff is counted in tests and lines of test files only; the band text', async () => {
  const diff = [
    'diff --git a/src/mesh.py b/src/mesh.py',
    '--- a/src/mesh.py',
    '+++ b/src/mesh.py',
    '@@ -0,0 +1,2 @@',
    '+def build(n):',
    '+    return n',
    'diff --git a/tests/test_new.py b/tests/test_new.py',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/tests/test_new.py',
    '@@ -0,0 +1,6 @@',
    '+def test_new_one():',
    '+    assert 1',
    '+',
    '+',
    '+async def test_new_two():',
    '+    assert 2',
    'diff --git a/src/__tests__/sum.test.ts b/src/__tests__/sum.test.ts',
    '--- /dev/null',
    '+++ b/src/__tests__/sum.test.ts',
    '@@ -0,0 +1,2 @@',
    "+it('adds', () => {});",
    "+test.each([1])('subs %s', () => {});",
    '+const sample = "it(\'nested\', () => {})"',
    '-removed line',
  ].join('\n')
  expect(countBranchTests(diff)).toEqual({ tests: 4, lines: 9 })
  expect(countBranchTests('')).toEqual({ tests: 0, lines: 0 })
  expect(bandText({ tests: 38, lines: 1204 })).toBe('38 tests · +1,204 lines of tests on this branch → /tests audit')
  expect(bandText({ tests: 1, lines: 12 })).toBe('1 test · +12 lines of tests on this branch → /tests audit')
  expect(isBigBranch({ tests: 26, lines: 10 }, SETTINGS)).toBe(true)
  expect(isBigBranch({ tests: 3, lines: 801 }, SETTINGS)).toBe(true)
  expect(isBigBranch({ tests: 25, lines: 800 }, SETTINGS)).toBe(false)
})

test("ripwire's clone groups become pairs on test files, relative to its root", async () => {
  const out =
    '<!-- ripwire clones: function bodies with similar normalized token streams -->' +
    '<clones groups="2" type3="1" total="3" root="tests">' +
    '<group type="2" gid="1" tokens="55" n="3"><f n="test_post_debit" p="test_posting.py:7"/><f n="test_rollover_debit" p="test_posting_rollover.py:5"/><f n="test_post_debit_eur" p="test_posting.py:20-30"/></group>' +
    '<group type="2" gid="2" tokens="40" n="2"><f n="money" p="../ledger/money.py:3"/><f n="money" p="../ledger/posting.py:9"/></group>' +
    '<group type="3" gid="0" tokens="60" n="2" similarity="0.84"><f n="test_balance_zero" p="test_posting.py:12"/><f n="test_rollover_balance" p="test_posting_rollover.py:11"/></group>' +
    '</clones>'
  expect(parseRipwireClones(out, '/home/dev/ledger', 0.6)).toEqual([
    { a: { file: '/home/dev/ledger/tests/test_posting.py', name: 'test_post_debit' }, b: { file: '/home/dev/ledger/tests/test_posting_rollover.py', name: 'test_rollover_debit' }, similarity: 1, kind: 'clone' },
    { a: { file: '/home/dev/ledger/tests/test_posting.py', name: 'test_post_debit' }, b: { file: '/home/dev/ledger/tests/test_posting.py', name: 'test_post_debit_eur' }, similarity: 1, kind: 'clone' },
    { a: { file: '/home/dev/ledger/tests/test_posting.py', name: 'test_balance_zero' }, b: { file: '/home/dev/ledger/tests/test_posting_rollover.py', name: 'test_rollover_balance' }, similarity: 0.84, kind: 'near' },
  ])
  expect(parseRipwireClones('<clones groups="0" total="0" root="/abs/tests"></clones>', '/home/dev', 0.6)).toEqual([])
})

test('the audit is assembled from the files: own pass or ripwire pairs folded with parametrize groups, sizes, skips, orphans', async () => {
  const debit = ['def test_post_debit():', '    ledger = Ledger()', '    ledger.post("cash", 100, "debit")', '    assert ledger.balance("cash") == 100', '    assert ledger.entries == 1'].join('\n')
  const credit = debit.replace('test_post_debit', 'test_post_credit').replace('"cash", 100, "debit"', '"cash", 250, "credit"').replace('== 100', '== 250')
  const zero = ['def test_balance_zero():', '    ledger = Ledger()', '    assert ledger.balance("cash") == 0', '    assert ledger.entries == 0', '    assert not ledger.closed'].join('\n')
  const slow = ['@pytest.mark.skip(reason="slow")', 'def test_slow_import():', '    assert import_all()'].join('\n')
  const rollover = debit.replace('test_post_debit', 'test_rollover_debit')
  const rolloverBalance = zero.replace('test_balance_zero', 'test_rollover_balance').replace('    assert not ledger.closed', '    assert not ledger.closed\n    assert ledger.rollover() is None')
  const files = [
    { path: 'tests/test_posting.py', module: 'posting', imports: ['pytest', 'posting', 'Ledger'], units: extractTests('tests/test_posting.py', [debit, credit, zero, slow].join('\n\n\n')) },
    { path: 'tests/test_posting_rollover.py', module: 'posting_rollover', imports: ['posting'], units: extractTests('tests/test_posting_rollover.py', [rollover, rolloverBalance].join('\n\n\n')) },
    { path: 'tests/test_legacy_export.py', module: 'legacy_export', imports: ['json'], units: extractTests('tests/test_legacy_export.py', 'def test_export():\n    assert json.dumps({}) == "{}"') },
    {
      path: 'tests/test_report.py',
      module: 'report',
      imports: ['report'],
      units: extractTests('tests/test_report.py', Array.from({ length: 41 }, (_, i) => `def test_report_${i}():\n    assert report.section_${i}() == ${i}`).join('\n\n\n')),
    },
    { path: 'tests/helpers.py', module: 'helpers', imports: [], units: [] },
  ]
  const projectFiles = ['ledger/__init__.py', 'ledger/posting.py', 'ledger/report.py', 'tests/test_posting.py', 'tests/test_posting_rollover.py', 'tests/test_legacy_export.py', 'tests/test_report.py', 'tests/helpers.py']
  const own = assembleAudit({ scope: '', files, ripwire: null, projectFiles }, SETTINGS)
  expect(own.fileCount).toBe(4)
  expect(own.testCount).toBe(48)
  expect(own.source).toBe('own')
  expect(own.duplicates.map(d => [d.a.file, d.a.name, d.b.file, d.b.name, d.kind, Number(d.similarity.toFixed(2))])).toEqual([
    ['tests/test_posting.py', 'test_post_debit', 'tests/test_posting_rollover.py', 'test_rollover_debit', 'clone', 1],
    ['tests/test_posting.py', 'test_post_credit', 'tests/test_posting_rollover.py', 'test_rollover_debit', 'clone', 1],
    ['tests/test_posting.py', 'test_balance_zero', 'tests/test_posting_rollover.py', 'test_rollover_balance', 'near', 0.76],
  ])
  expect(own.parametrize).toEqual([{ file: 'tests/test_posting.py', names: ['test_post_debit', 'test_post_credit'] }])
  expect(own.oversized).toEqual([{ file: 'tests/test_report.py', count: 41 }])
  expect(own.skipped).toEqual([{ file: 'tests/test_posting.py', name: 'test_slow_import' }])
  expect(own.orphans).toEqual([{ file: 'tests/test_legacy_export.py', module: 'legacy_export' }])

  // With ripwire's pairs, its similarities stand, a pair inside a parametrize group is folded, and nothing is compared across files here.
  const ripwire: Duplicate[] = [
    { a: { file: 'tests/test_posting.py', name: 'test_post_debit' }, b: { file: 'tests/test_posting_rollover.py', name: 'test_rollover_debit' }, similarity: 1, kind: 'clone' },
    { a: { file: 'tests/test_posting.py', name: 'test_post_debit' }, b: { file: 'tests/test_posting.py', name: 'test_post_credit' }, similarity: 1, kind: 'clone' },
    { a: { file: 'tests/test_posting.py', name: 'test_balance_zero' }, b: { file: 'tests/test_posting_rollover.py', name: 'test_rollover_balance' }, similarity: 0.84, kind: 'near' },
  ]
  const merged = assembleAudit({ scope: '', files, ripwire, projectFiles }, SETTINGS)
  expect(merged.source).toBe('ripwire')
  expect(merged.duplicates.map(d => [d.a.name, d.b.name, d.kind, d.similarity])).toEqual([
    ['test_post_debit', 'test_rollover_debit', 'clone', 1],
    ['test_balance_zero', 'test_rollover_balance', 'near', 0.84],
  ])
  expect(merged.parametrize).toEqual(own.parametrize)
  expect(auditText(merged, SETTINGS)).toBe(
    [
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
    ].join('\n'),
  )
  expect(auditSuggestion(merged)).toBe(
    'Run the test suite first, then consolidate per /tests audit: merge the clone tests/test_posting.py::test_post_debit ≈ tests/test_posting_rollover.py::test_rollover_debit, ' +
      'parametrize test_post_debit and test_post_credit in tests/test_posting.py, split tests/test_report.py (41 tests) by concern; run the suite again and confirm it stays green.',
  )
  const clean = assembleAudit({ scope: 'tests/unit', files: [files[2]!], ripwire: null, projectFiles: null }, SETTINGS)
  expect(auditText(clean, SETTINGS)).toBe(
    'test-gardener audit of tests/unit: 1 test file · 1 test · own pairwise pass\nNothing to consolidate: no clones, near-duplicates, parametrize candidates, oversized files, skips or orphaned tests.',
  )
  expect(auditSuggestion(clean)).toBeNull()
})

test('paths and hashes', async () => {
  expect(relative('/home/dev/meshkit', '/home/dev/meshkit/tests/test_a.py')).toBe('tests/test_a.py')
  expect(relative('/home/dev/meshkit/', '/home/dev/meshkit/tests/test_a.py')).toBe('tests/test_a.py')
  expect(relative('/home/dev/meshkit', '/other/tests/test_a.py')).toBe('/other/tests/test_a.py')
  expect(hashOf('/home/dev/meshkit')).toMatch(/^[0-9a-f]{8}$/)
  expect(hashOf('/home/dev/meshkit')).toBe(hashOf('/home/dev/meshkit'))
  expect(hashOf('/home/dev/meshkit')).not.toBe(hashOf('/home/dev/webshop'))
})
