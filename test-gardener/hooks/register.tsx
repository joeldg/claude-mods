import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ToolSpec } from 'claude-code'

import type { BranchTests, GardenerSettings } from '../types'
import {
  DEFAULT_BRANCH_REFS,
  assembleAudit,
  auditSuggestion,
  auditText,
  bandText,
  commonDirectory,
  countBranchTests,
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
  parseRipwireClones,
  pickDefaultBranch,
  primaryModule,
  relative,
  resolvePath,
  writeNote,
} from './tests'
import type { AuditFile, BranchCount, Duplicate, FileTest, TestFileInfo, TestSummary, TestUnit } from './tests'

type Engine = EngineInterface

const branch = atom({ plugin: 'test-gardener', key: 'branch' } as const, null)
const isHidden = atom({ plugin: 'test-gardener', key: 'isHidden' } as const, false)

/** The tool Claude asks before writing tests, as the engine names it. */
const TOOL = 'mcp__test-gardener__tests_neighbourhood'
const NEIGHBOURHOOD_TOOL: ToolSpec = {
  name: 'tests_neighbourhood',
  description:
    'Which test files already cover a module and what they test, so a new test extends or parametrizes an existing file instead of starting another. ' +
    'Call it before adding tests: pass `module` (the module under test, e.g. mesh_build) or `path` (a source file or a test file). Reads the project only; no model call.',
  inputSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', description: 'The module under test, as a bare name (mesh_build) or a dotted path (meshkit.mesh_build).' },
      path: { type: 'string', description: 'A source file or a test file, relative to the project or absolute; its module is read from the name and the imports.' },
    },
    additionalProperties: false,
  },
  isDeferred: false,
}
/** The name the gardening block renders under in the first message's context. */
const BLOCK = 'testGardener'
const CACHE_VERSION = 1
/** How often the branch count is refreshed after a turn at most. */
const REFRESH_MS = 2 * 60_000
const RG_TIMEOUT_MS = 20_000
const GIT_TIMEOUT_MS = 20_000
const RIPWIRE_TIMEOUT_MS = 120_000
/** How many directory entries a walk of the tree reads at most, when neither rg nor git lists the files. */
const WALK_CAP = 50_000
/** Folders a walk leaves out, besides hidden ones. */
const SKIPPED_DIRS = ['node_modules', 'third_party', 'vendor', 'venv', 'site-packages', 'dist', 'build', 'target', '__pycache__']
/** How many neighbour files' tests a new test is compared against. */
const NEIGHBOUR_FILES = 6
/** The test files per language, as rg and git globs. */
const TEST_GLOBS = ['**/test_*.py', '**/*_test.py', '**/tests/**', '**/test/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*_test.go', '**/*_spec.rb']
const ZERO: BranchCount = { tests: 0, lines: 0 }
const DEFAULTS: GardenerSettings = { nearDuplicate: 0.6, maxTestsPerFile: 40, bigBranchTests: 25, bigBranchLines: 800, modelReview: false }

/** A test file as the scan cache keeps it, by path and mtime. */
type CacheEntry = { mtimeMs: number; module: string | null; imports: string[]; tests: TestSummary[] }
type Cache = { version: number; files: Record<string, CacheEntry> }
type Scan = { infos: TestFileInfo[]; before: CacheEntry | undefined }
type Ran = { ok: boolean; out: string; err: string }
/** The session's own, made in `register`: hooks close over it, helpers take it. */
type Memory = {
  settings: GardenerSettings
  /** The project root (the git top level, else the session's folder); undefined until asked. */
  root: string | undefined
  isRepo: boolean
  /** The root is the home folder itself, outside any repository: no project, nothing scanned. */
  isHome: boolean
  refreshing: Promise<void> | null
  /** Whether rg can start, probed on the first listing; null until then. */
  rg: Promise<boolean> | null
}

/** The tool's and the audit's answer in a session whose folder is the home folder itself. */
const HOME_TEXT = 'test-gardener: this session runs in your home folder, not a project, so no test files are scanned; start Claude in the project folder and ask again.'

const usage = (settings: GardenerSettings): string =>
  `Usage: /tests audit [path] — the consolidation report: clones, near-duplicates, parametrize candidates, files over ${settings.maxTestsPerFile} tests, skips, tests whose module is gone.`

const contextText = (settings: GardenerSettings): string =>
  [
    "Tests in this project are gardened: before adding tests, call tests_neighbourhood with the module under test (or the test file's path) to see which test files already cover it and what they test.",
    `Prefer extending or parametrizing an existing test over adding a near-copy or starting a new file; a file past ${settings.maxTestsPerFile} tests is split by concern.`,
    '/tests audit lists the clones, near-duplicates, parametrize candidates and oversized files to consolidate; it never edits tests itself.',
  ].join('\n')

/** A number option: finite and at least `least`, else the default. */
const numberOption = (value: unknown, fallback: number, least: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= least ? value : fallback

const dirnameOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

const summary = (unit: TestUnit): TestSummary => ({ name: unit.name, line: unit.line, isParametrized: unit.isParametrized, isSkipped: unit.isSkipped })

/** The `originalFile` a Write or Edit result carries: the text before, null for a new file, undefined when unknown. */
const originalFileOf = (result: unknown): string | null | undefined => {
  if (typeof result !== 'object' || result === null || !('originalFile' in result)) {
    return undefined
  }
  const original = (result as { originalFile: unknown }).originalFile
  return typeof original === 'string' ? original : original === null ? null : undefined
}

/** True for what the engine draws when no plugin draws the band, or an empty Box. */
function isBlankTree(tree: RenderElement): boolean {
  if (tree.type === 'engine') {
    return true
  }
  return tree.type === 'Box' && (tree.children ?? []).length === 0
}

async function debug($: Engine, line: string) {
  try {
    $.ui.log(`test-gardener: ${line}`, { to: 'debug' })
  } catch {
    // The debug log is best effort.
  }
}

/** Runs a command in `cwd`; null when it cannot start or outlasts its timeout (logged). */
async function run($: Engine, argv: readonly string[], cwd: string, timeoutMs: number): Promise<Ran | null> {
  try {
    const out = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: out.exitCode === 0, out: out.stdout, err: out.stderr }
  } catch (error) {
    await debug($, `${argv[0] ?? 'command'} did not run: ${String(error)}`)
    return null
  }
}

/** The project root: the git top level, else the session's folder; asked once, with whether it is the home folder itself. */
async function projectRoot($: Engine, m: Memory): Promise<string> {
  if (m.root !== undefined) {
    return m.root
  }
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd, GIT_TIMEOUT_MS)
  const root = top?.ok ? top.out.trim().replace(/\/+$/, '') : ''
  m.isRepo = root !== ''
  m.root = root === '' ? cwd : root
  // The home folder itself, outside any repository, is no project: a listing there runs for minutes and finds the world.
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  m.isHome = !m.isRepo && home !== '' && m.root === home
  return m.root
}

/**
 * Whether `exe` can start: a bare name checked against each `PATH` folder. With no `PATH` to read it is assumed
 * present, so the listing is still tried. Checking first spares a process that can only fail (rg is not on PATH in
 * every desktop session).
 */
async function canStart($: Engine, exe: string): Promise<boolean> {
  try {
    const folders = ((await $.env.get('PATH')) ?? '').split(':').filter(Boolean)
    if (folders.length === 0) {
      return true
    }
    for (const folder of folders) {
      if (await $.fs.exists(`${folder.replace(/\/+$/, '')}/${exe}`)) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** Whether rg can start, probed once per session; the stand-in is logged once when it cannot. */
function hasRg($: Engine, m: Memory): Promise<boolean> {
  m.rg ??= (async () => {
    const found = await canStart($, 'rg')
    if (!found) {
      await debug($, `rg is not on PATH; files are listed with ${m.isRepo ? 'git ls-files' : 'a directory walk'}`)
    }
    return found
  })()
  return m.rg
}

/** The files under `root`, absolute, by a walk of the tree: hidden and vendored folders left out, WALK_CAP entries at most. */
async function walkFiles($: Engine, root: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = [root]
  let seen = 0
  while (queue.length > 0 && seen < WALK_CAP) {
    const dir = queue.shift() ?? root
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      seen += 1
      if (entry.kind === 'dir') {
        if (!entry.isLink && !entry.name.startsWith('.') && !SKIPPED_DIRS.includes(entry.name)) {
          queue.push(`${dir}/${entry.name}`)
        }
      } else if (entry.kind === 'file') {
        out.push(`${dir}/${entry.name}`)
      }
    }
  }
  return out
}

/**
 * The project's files under `root`, absolute: rg's listing (gitignore honoured), narrowed by `globs` when given; git's
 * when rg is not on PATH or did not run; a walk of the tree outside a repository.
 */
async function listFiles($: Engine, m: Memory, root: string, globs: readonly string[] | null): Promise<string[]> {
  if (m.isHome) {
    return []
  }
  let ran: Ran | null = null
  if (await hasRg($, m)) {
    const argv = ['rg', '--files']
    for (const glob of globs ?? []) {
      argv.push('-g', glob)
    }
    ran = await run($, argv, root, RG_TIMEOUT_MS)
  }
  if (ran === null && m.isRepo) {
    ran = await run($, ['git', 'ls-files', '--cached', '--others', '--exclude-standard'], root, RG_TIMEOUT_MS)
  }
  let paths: string[]
  if (ran !== null) {
    paths = ran.out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => resolvePath(root, line))
  } else {
    paths = m.isRepo ? [] : await walkFiles($, root)
  }
  return globs === null ? paths : paths.filter(isTestFile)
}

async function cacheFile($: Engine, root: string): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home === undefined || home === '' ? null : `${home.replace(/\/+$/, '')}/.claude/test-gardener/${hashOf(root)}.json`
}

async function loadCache($: Engine, file: string | null): Promise<Cache> {
  const empty: Cache = { version: CACHE_VERSION, files: {} }
  if (file === null) {
    return empty
  }
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(file))
    if (typeof parsed === 'object' && parsed !== null && (parsed as Cache).version === CACHE_VERSION && typeof (parsed as Cache).files === 'object') {
      return parsed as Cache
    }
  } catch {
    // Missing or unreadable: scanned afresh.
  }
  return empty
}

async function saveCache($: Engine, file: string, cache: Cache) {
  try {
    await $.fs.write(file, JSON.stringify(cache))
  } catch (error) {
    await debug($, `could not keep the scan: ${String(error)}`)
  }
}

/** The mtime of every path, read per directory. */
async function mtimesOf($: Engine, paths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const dir of new Set(paths.map(dirnameOf))) {
    const entries = await $.fs.list(dir).catch(() => null)
    for (const entry of entries ?? []) {
      out.set(`${dir}/${entry.name}`, entry.mtimeMs)
    }
  }
  return out
}

/**
 * Every test file of the project with its module, imports and test names: from the shared cache by path and mtime, the
 * rest read now; `fresh` is a file just written, whose text is at hand. `before` is what the cache held for it.
 */
async function scanTests($: Engine, m: Memory, root: string, fresh: { path: string; text: string } | null): Promise<Scan> {
  const paths = (await listFiles($, m, root, TEST_GLOBS)).sort()
  const file = await cacheFile($, root)
  const cache = await loadCache($, file)
  const before = fresh === null ? undefined : cache.files[fresh.path]
  const mtimes = await mtimesOf($, paths)
  const kept: Record<string, CacheEntry> = {}
  const infos: TestFileInfo[] = []
  let changed = false
  for (const path of paths) {
    const mtimeMs = mtimes.get(path) ?? 0
    const hit = cache.files[path]
    let entry = hit !== undefined && hit.mtimeMs === mtimeMs && fresh?.path !== path ? hit : undefined
    if (entry === undefined) {
      const text = fresh?.path === path ? fresh.text : await $.fs.read(path).catch(() => null)
      if (text === null) {
        continue
      }
      entry = { mtimeMs, module: moduleOf(path), imports: importsOf(path, text), tests: extractTests(path, text).map(summary) }
      changed = true
    }
    kept[path] = entry
    infos.push({ path, ...entry })
  }
  if (file !== null && (changed || Object.keys(cache.files).length !== Object.keys(kept).length)) {
    await saveCache($, file, { version: CACHE_VERSION, files: kept })
  }
  return { infos, before }
}

/** The tests of one file, with bodies; none when it cannot be read. */
async function readUnits($: Engine, path: string): Promise<TestUnit[]> {
  const text = await $.fs.read(path).catch(() => null)
  return text === null ? [] : extractTests(path, text)
}

const relativeDuplicate = (root: string, d: Duplicate): Duplicate => ({
  ...d,
  a: { ...d.a, file: relative(root, d.a.file) },
  b: { ...d.b, file: relative(root, d.b.file) },
})

/**
 * The note for a test file just written: the files already covering its module, the near-duplicates and clones among
 * the tests added (against the file's other tests and the neighbours'), the size past the guideline; null when clean.
 * `written` is a Write's content (an Edit's file is read); `original` the text before, null for a new file.
 */
async function noteAfterWrite($: Engine, m: Memory, filePath: string, written: string | null, original: string | null | undefined): Promise<string | null> {
  if (!isTestFile(filePath)) {
    return null
  }
  try {
    const path = resolvePath(await $.session.cwd(), filePath)
    const root = await projectRoot($, m)
    if (m.isHome) {
      return null
    }
    const text = written ?? (await $.fs.read(path))
    const { infos, before } = await scanTests($, m, root, { path, text })
    const units = extractTests(path, text)
    const known = typeof original === 'string' ? extractTests(path, original).map(unit => unit.name) : original === null ? [] : (before?.tests.map(test => test.name) ?? null)
    const isNew = original === null || (original === undefined && before === undefined)
    const added = known === null ? units : units.filter(unit => !known.includes(unit.name))
    const fresh: FileTest[] = added.map(unit => ({ file: path, unit }))
    const own = infos.find(info => info.path === path)
    const module = primaryModule([moduleOf(path) ?? '', ...(own?.imports ?? importsOf(path, text))], infos, path)
    const neighbours = module === null ? [] : neighbourhood(module, infos, path)
    let duplicates: Duplicate[] = []
    if (fresh.length > 0) {
      const pool: FileTest[] = units.filter(unit => !added.includes(unit)).map(unit => ({ file: path, unit }))
      for (const near of neighbours.slice(0, NEIGHBOUR_FILES)) {
        pool.push(...(await readUnits($, near.path)).map(unit => ({ file: near.path, unit })))
      }
      duplicates = findDuplicates(fresh, pool, languageOf(path) ?? 'python', m.settings.nearDuplicate)
    }
    return writeNote(
      {
        file: relative(root, path),
        module,
        isNew,
        count: units.length,
        neighbours: neighbours.map(near => ({ ...near, path: relative(root, near.path) })),
        duplicates: duplicates.map(d => relativeDuplicate(root, d)),
      },
      m.settings,
    )
  } catch (error) {
    await debug($, `no note for ${filePath}: ${String(error)}`)
    return null
  }
}

/** Where the test files live when none covers a module: their common directory, relative; null at the root or with none. */
const layoutHint = (root: string, infos: readonly TestFileInfo[]): { count: number; dir: string } | null => {
  const dir = commonDirectory(infos.map(info => info.path))
  return dir === null || dir === root || infos.length === 0 ? null : { count: infos.length, dir: relative(root, dir) }
}

/** The tests_neighbourhood answer for `module` or `path`. */
async function neighbourhoodTool($: Engine, m: Memory, input: { module?: unknown; path?: unknown }): Promise<string> {
  const moduleArg = typeof input.module === 'string' ? input.module.trim() : ''
  const pathArg = typeof input.path === 'string' ? input.path.trim() : ''
  const candidates: string[] = []
  let excluding: string | undefined
  if (moduleArg !== '') {
    candidates.push(moduleName(moduleArg))
  } else if (pathArg !== '') {
    const path = resolvePath(await $.session.cwd(), pathArg)
    if (isTestFile(path)) {
      excluding = path
      candidates.push(moduleOf(path) ?? '')
      const text = await $.fs.read(path).catch(() => null)
      if (text !== null) {
        candidates.push(...importsOf(path, text))
      }
    } else {
      candidates.push(moduleName(path))
    }
  }
  if (candidates.every(name => name === '')) {
    return 'test-gardener: pass `module` (the module under test, e.g. mesh_build) or `path` (a source file or a test file).'
  }
  const root = await projectRoot($, m)
  if (m.isHome) {
    return HOME_TEXT
  }
  const { infos } = await scanTests($, m, root, null)
  const module = primaryModule(candidates, infos, excluding) ?? ''
  const near = neighbourhood(module, infos)
  return neighbourhoodText(module, near.map(file => ({ ...file, path: relative(root, file.path) })), m.settings, near.length === 0 ? layoutHint(root, infos) : null)
}

/** ripwire's clone pairs over `dir`, relative to the project; null when it is not on PATH or fails. */
async function ripwireClones($: Engine, m: Memory, root: string, dir: string): Promise<Duplicate[] | null> {
  const ran = await run($, ['ripwire', dir, '--clones'], root, RIPWIRE_TIMEOUT_MS)
  if (ran === null || !ran.ok) {
    if (ran !== null) {
      await debug($, `ripwire exited with ${ran.err.trim().slice(0, 200)}`)
    }
    return null
  }
  return parseRipwireClones(ran.out, root, m.settings.nearDuplicate).map(d => relativeDuplicate(root, d))
}

/** The /tests audit of the project, or of a subtree: the text, with the consolidations suggested as the next prompt. */
async function audit($: Engine, m: Memory, pathArg: string | null): Promise<string> {
  const root = await projectRoot($, m)
  if (m.isHome) {
    return HOME_TEXT
  }
  const scope = pathArg === null ? root : resolvePath(await $.session.cwd(), pathArg)
  const { infos } = await scanTests($, m, root, null)
  const inScope = infos.filter(info => scope === root || info.path === scope || info.path.startsWith(`${scope}/`))
  const files: AuditFile[] = []
  for (const info of inScope) {
    if (info.tests.length > 0) {
      files.push({ path: relative(root, info.path), module: info.module, imports: info.imports, units: await readUnits($, info.path) })
    }
  }
  const projectFiles = (await listFiles($, m, root, null)).map(path => relative(root, path))
  const dir = commonDirectory(inScope.map(info => info.path)) ?? scope
  const ripwire = files.length === 0 ? null : await ripwireClones($, m, root, dir)
  const result = assembleAudit({ scope: scope === root ? '' : relative(root, scope), files, ripwire, projectFiles }, m.settings)
  const suggestion = auditSuggestion(result)
  if (suggestion !== null) {
    await $.prompt.suggest({ text: suggestion }).catch(() => undefined)
  }
  return auditText(result, m.settings)
}

/**
 * Tests and lines the checked-out branch adds to test files against the default branch (origin/HEAD's target, else
 * origin/main, origin/master, main, master, read in one `for-each-ref` that never fails); zero on the default branch
 * itself, on a detached HEAD, and where no default branch is told apart from the checked-out one.
 */
async function countBranch($: Engine, root: string): Promise<BranchCount> {
  const refs = await run($, ['git', 'for-each-ref', '--format=%(refname)%09%(symref)', ...DEFAULT_BRANCH_REFS], root, GIT_TIMEOUT_MS)
  const current = (await run($, ['git', 'branch', '--show-current'], root, GIT_TIMEOUT_MS))?.out.trim() ?? ''
  const base = pickDefaultBranch(refs?.ok ? refs.out : null, current === '' ? null : current)
  if (base === null || current === '' || current === base.replace(/^origin\//, '')) {
    return ZERO
  }
  const diff = await run($, ['git', 'diff', '-U0', `${base}...HEAD`, '--', ...TEST_GLOBS.map(glob => `:(glob)${glob}`)], root, GIT_TIMEOUT_MS)
  return diff?.ok ? countBranchTests(diff.out) : ZERO
}

/** Counts the branch's tests once, however many ask meanwhile; outside a git repository the count is zero. */
async function refreshBranch($: Engine, m: Memory): Promise<void> {
  if (m.refreshing !== null) {
    return m.refreshing
  }
  m.refreshing = (async () => {
    try {
      const root = await projectRoot($, m)
      const count = m.isRepo ? await countBranch($, root) : ZERO
      const at = await $.clock.now()
      const value: BranchTests = { at, ...count }
      await update($, branch, () => value)
    } catch (error) {
      await debug($, `the branch count failed: ${String(error)}`)
    } finally {
      m.refreshing = null
    }
  })()
  return m.refreshing
}

/** Refreshes the branch count when the last one is older than REFRESH_MS. */
async function refreshIfStale($: Engine, m: Memory) {
  const current = await read($, branch)
  const now = await $.clock.now()
  if (current === null || now - current.at >= REFRESH_MS) {
    await refreshBranch($, m)
  }
}

export const register: Register = (on, options) => {
  const m: Memory = {
    settings: {
      nearDuplicate: numberOption(options.nearDuplicate, DEFAULTS.nearDuplicate, 0.1),
      maxTestsPerFile: numberOption(options.maxTestsPerFile, DEFAULTS.maxTestsPerFile, 1),
      bigBranchTests: numberOption(options.bigBranchTests, DEFAULTS.bigBranchTests, 0),
      bigBranchLines: numberOption(options.bigBranchLines, DEFAULTS.bigBranchLines, 0),
      // Reserved: documented as not yet implemented; no model pass runs.
      modelReview: options.modelReview === true,
    },
    root: undefined,
    isRepo: false,
    isHome: false,
    refreshing: null,
    rg: null,
  }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'tests',
        description: 'The test-suite consolidation report: /tests audit [path] lists clones, near-duplicates, parametrize candidates, oversized files, skips and tests whose module is gone',
        argumentHint: 'audit [path]',
      })
      .catch((error: unknown) => debug($, `the /tests command did not register: ${String(error)}`))
    await $.tool.register(NEIGHBOURHOOD_TOOL).catch((error: unknown) => debug($, `the tests_neighbourhood tool did not register: ${String(error)}`))
    void refreshBranch($, m)
    return next(e)
  })

  // Once per conversation, and again after a compaction: the model learns the tests are gardened and how to ask.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    return { ...result, blocks: [...result.blocks.filter(block => block.name !== BLOCK), { name: BLOCK, text: contextText(m.settings) }] }
  })

  // A test file written: the write happens, then the note on what it did to the suite rides along for the model.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const note = await noteAfterWrite($, m, e.file_path, e.content, originalFileOf(ran.result))
    return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const note = await noteAfterWrite($, m, e.file_path, null, originalFileOf(ran.result))
    return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  // The tool only reads the project: never a question for the person, though a deny in settings stands.
  on('tool.check', { tool: TOOL }, async ($, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'test-gardener: reads the test files; writes nothing' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => ({ result: await neighbourhoodTool($, m, e as { module?: unknown; path?: unknown }) }))

  on('command.run', { command: 'tests' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    if (words[0] !== 'audit' || words.length > 2) {
      return { text: usage(m.settings) }
    }
    return { text: await audit($, m, words[1] ?? null) }
  })

  // The band's count is refreshed after the main loop's turns, at most every two minutes.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      void refreshIfStale($, m)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, branch)
    const hidden = await read($, isHidden)
    if (e.props.hasSurvey || hidden || current === null || !isBigBranch(current, m.settings)) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const band = (
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{bandText(current)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
    // Another plugin's band beneath stays, under this one.
    const below = await next(e)
    return isBlankTree(below) ? (
      band
    ) : (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // A /clear goes on in this process as a fresh conversation: counted again, shown again.
    await update($, branch, () => null)
    await update($, isHidden, () => false)
    return next(e)
  })
}
