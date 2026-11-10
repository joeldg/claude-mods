import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, PluginOptions, Register } from 'claude-code'

import type { DocsAudit, DocsAuditFile, DocsAuditItem, DocsFinding, DocsItemState } from '../types'
import {
  DAY_MS,
  MAX_LOOKUPS,
  datedSeries,
  deadReferences,
  duplicateParagraphs,
  findReferences,
  finishedPlan,
  hasMarkers,
  makeTargets,
  orphanCandidates,
  orphanFinding,
  oversized,
  parseBlame,
  sortFindings,
  splitLines,
  staleMarkers,
} from './checks'
import type { DeadReferenceLookups, Doc, LineAge, OrphanCandidate } from './checks'
import {
  applyPlanItem,
  buildPlanPrompt,
  buildRollupPrompt,
  contextNote,
  describeFindings,
  parseArgs,
  parsePlan,
  rollupPath,
  sectionRange,
  usage,
} from './plan'
import type { FactSheet } from './plan'
import { EXCLUDED_DIRS, baseName, datedName, folderOf, inScope, isDoc, joinPath, normalisePath, parseGlobs, relativeTo, rgFilesArgv, rgIdentifiersArgv } from './scope'
import { auditTree } from './view'
import type { PaneActions } from './view'

type Engine = EngineInterface

const PLUGIN = 'docs-gardener'
const PANE = 'docs-gardener'
const TITLE = 'Docs audit'
const COMMAND = 'docs'
const TOOL_NAME = 'docs_check'
const TOOL = `mcp__${PLUGIN}__${TOOL_NAME}`
const CONTEXT_BLOCK = 'docsGardener'
const GIT_MS = 30_000
const RG_MS = 60_000
/** The reply's cap: a rewritten section or a roll-up can be long. */
const MAX_TOKENS = 8_000
const MODEL_TIMEOUT_MS = 3 * 60_000
/** How long an identifier lookup's answer is trusted. */
const LOOKUP_MS = 10 * 60_000
/** A running audit older than this was left by a reload: a new one may start. */
const STALE_AUDIT_MS = 15 * 60_000
/** Identifiers per rg call. */
const LOOKUP_CHUNK = 200
/** How many entries a walk of the tree (when rg is missing) reads at most. */
const WALK_CAP = 50_000

const CONTEXT_TEXT = [
  'Docs here are gardened (docs-gardener): reference docs describe the current state of the project, nothing more.',
  "Before editing a .md file, call docs_check({ path }) and fix what it lists; put passing thoughts and working notes in the project's notes file (NOTES.md or the scratchpad), not in reference docs.",
  '/docs audit cleans up: the deterministic checks, then a model edit plan applied from a pane.',
].join('\n')

const TOOL_DESCRIPTION =
  'Check one markdown file or folder of this project before editing it: dead references (paths, make targets and identifiers the code no longer has), stale TODOs and unchecked items, paragraphs duplicated in another doc, orphans, dated series, oversized files and finished plans. Deterministic and read-only, no model call. Call it before editing a doc and fix what it lists.'

type Config = {
  model: string
  maxModelFiles: number
  staleDays: number
  orphanDays: number
  seriesRollupAt: number
  maxLines: number
  excludeGlobs: string[]
  writeTimeChecks: boolean
}

const DEFAULTS: Config = {
  model: 'claude-haiku-5-5',
  maxModelFiles: 20,
  staleDays: 30,
  orphanDays: 60,
  seriesRollupAt: 10,
  maxLines: 400,
  excludeGlobs: [],
  writeTimeChecks: true,
}

const numberOption = (value: unknown, fallback: number, least: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= least ? Math.floor(value) : fallback

export function configFrom(options: PluginOptions): Config {
  return {
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULTS.model,
    maxModelFiles: numberOption(options.maxModelFiles, DEFAULTS.maxModelFiles, 0),
    staleDays: numberOption(options.staleDays, DEFAULTS.staleDays, 1),
    orphanDays: numberOption(options.orphanDays, DEFAULTS.orphanDays, 1),
    seriesRollupAt: numberOption(options.seriesRollupAt, DEFAULTS.seriesRollupAt, 1),
    maxLines: numberOption(options.maxLines, DEFAULTS.maxLines, 10),
    excludeGlobs: parseGlobs(options.excludeGlobs),
    writeTimeChecks: options.writeTimeChecks !== false,
  }
}

const audit = atom({ plugin: 'docs-gardener', key: 'audit' } as const, null)

let config: Config = DEFAULTS
/** Whether an identifier occurs in the code, by `root\0identifier`, with when it was looked up. */
let lookups = new Map<string, { has: boolean; at: number }>()
/** The repo root per working directory. */
let roots = new Map<string, string>()

type Ran = { ok: boolean; out: string; err: string }
type Request = { path: string | null; isChanged: boolean; isApply: boolean }
/** A path the person or Claude named, placed in the repo: a doc, or a folder (`''` for the root). */
type Target = { rel: string; isFolder: boolean }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
const byFile = (a: Doc, b: Doc): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
const trimmedLines = (text: string): string[] => splitLines(text).map(line => line.trim()).filter(line => line !== '')

function debug($: Engine, line: string): void {
  try {
    $.ui.log(`${PLUGIN}: ${line}`, { to: 'debug' })
  } catch {
    // The debug log is best effort.
  }
}

async function run($: Engine, argv: readonly string[], cwd: string, timeoutMs: number): Promise<Ran> {
  try {
    const out = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: out.exitCode === 0, out: out.stdout, err: out.stderr }
  } catch (error) {
    return { ok: false, out: '', err: messageOf(error) }
  }
}

const git = ($: Engine, root: string, args: readonly string[]): Promise<Ran> => run($, ['git', ...args], root, GIT_MS)

/** The repository's top folder, or the working directory outside one. */
async function repoRoot($: Engine): Promise<string> {
  const cwd = await $.session.cwd()
  const known = roots.get(cwd)
  if (known !== undefined) {
    return known
  }
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  const root = normalisePath(top.ok && top.out.trim() !== '' ? top.out.trim() : cwd)
  roots.set(cwd, root)
  return root
}

async function readText($: Engine, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** The docs under the root, when rg is not there to list them. */
async function walkDocs($: Engine, root: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  let seen = 0
  while (queue.length > 0 && seen < WALK_CAP) {
    const folder = queue.shift() ?? ''
    const entries = await $.fs.list(folder === '' ? root : `${root}/${folder}`).catch(() => [])
    for (const entry of entries) {
      seen += 1
      const rel = folder === '' ? entry.name : `${folder}/${entry.name}`
      if (entry.kind === 'dir') {
        if (!EXCLUDED_DIRS.includes(entry.name) && rel.split('/').length <= 15) {
          queue.push(rel)
        }
      } else if (entry.kind === 'file' && isDoc(rel)) {
        out.push(rel)
      }
    }
  }
  return out
}

/** The docs in scope, relative to the root, sorted: rg's listing, or a walk of the tree without it. */
async function listDocs($: Engine, root: string): Promise<string[]> {
  const listed = await run($, rgFilesArgv(root, config.excludeGlobs), root, RG_MS)
  let paths: string[]
  if (listed.ok || (listed.out === '' && listed.err === '')) {
    paths = trimmedLines(listed.out).map(line => relativeTo(root, line) ?? '')
  } else {
    debug($, `rg could not list the docs (${listed.err.trim().slice(0, 200)}); walking the tree instead`)
    paths = await walkDocs($, root)
  }
  return [...new Set(paths.filter(rel => rel !== '' && inScope(rel, config.excludeGlobs)))].sort()
}

async function readDoc($: Engine, root: string, rel: string): Promise<Doc | null> {
  const text = await readText($, `${root}/${rel}`)
  return text === null ? null : { file: rel, text }
}

/** Every doc in scope with its text, sorted by path. */
async function loadCorpus($: Engine, root: string): Promise<Doc[]> {
  const files = await listDocs($, root)
  const docs = await Promise.all(files.map(rel => readDoc($, root, rel)))
  return docs.filter((doc): doc is Doc => doc !== null).sort(byFile)
}

/** Which of the identifiers occur in the code: from the cache, else one batched rg lookup. */
async function identifiersInCode($: Engine, root: string, wanted: readonly string[]): Promise<Set<string>> {
  const now = await $.clock.now()
  const found = new Set<string>()
  const missing: string[] = []
  for (const identifier of new Set(wanted)) {
    const known = lookups.get(`${root}\0${identifier}`)
    if (known !== undefined && now - known.at < LOOKUP_MS) {
      if (known.has) {
        found.add(identifier)
      }
    } else {
      missing.push(identifier)
    }
  }
  for (let i = 0; i < missing.length; i += LOOKUP_CHUNK) {
    const chunk = missing.slice(i, i + LOOKUP_CHUNK)
    const ran = await run($, rgIdentifiersArgv(root, chunk, config.excludeGlobs), root, RG_MS)
    if (!ran.ok && ran.err.trim() !== '') {
      // Without rg nothing can be called dead: every identifier passes.
      debug($, `rg could not look identifiers up (${ran.err.trim().slice(0, 200)}); none is called dead`)
      for (const identifier of chunk) {
        found.add(identifier)
      }
      continue
    }
    const hits = new Set(trimmedLines(ran.out))
    for (const identifier of chunk) {
      const has = hits.has(identifier)
      lookups.set(`${root}\0${identifier}`, { has, at: now })
      if (has) {
        found.add(identifier)
      }
    }
  }
  return found
}

/** The identifiers a doc's dead-reference check would look up: the first MAX_LOOKUPS of them. */
const identifiersOf = (doc: Doc): string[] =>
  findReferences(doc.text)
    .filter(ref => ref.kind === 'identifier')
    .map(ref => ref.token)
    .slice(0, MAX_LOOKUPS)

async function makeTargetsOf($: Engine, root: string): Promise<ReadonlySet<string> | null> {
  for (const name of ['Makefile', 'GNUmakefile', 'makefile']) {
    const text = await readText($, `${root}/${name}`)
    if (text !== null) {
      return makeTargets(text)
    }
  }
  return null
}

/** The dead references of one doc, the identifiers looked up (or served from the cache) first. */
async function deadReferencesOf($: Engine, root: string, doc: Doc): Promise<DocsFinding[]> {
  const refs = findReferences(doc.text)
  const identifiers = identifiersOf(doc)
  const inCode = identifiers.length > 0 ? await identifiersInCode($, root, identifiers) : new Set<string>()
  const existing = new Map<string, Promise<boolean>>()
  const lookup: DeadReferenceLookups = {
    exists: rel => {
      let known = existing.get(rel)
      if (known === undefined) {
        known = $.fs.exists(`${root}/${rel}`).catch(() => false)
        existing.set(rel, known)
      }
      return known
    },
    inCode: async identifier => inCode.has(identifier),
    makeTargets: refs.some(ref => ref.kind === 'make') ? await makeTargetsOf($, root) : null,
  }
  return deadReferences(doc, lookup)
}

/** When each line of a doc was last committed, from git blame; nothing is known without git. */
async function lineAges($: Engine, root: string, rel: string): Promise<LineAge> {
  const blame = await git($, root, ['blame', '--line-porcelain', '--', `${root}/${rel}`])
  if (!blame.ok) {
    return () => null
  }
  const ages = parseBlame(blame.out)
  return line => ages.get(line) ?? null
}

async function staleMarkersOf($: Engine, root: string, doc: Doc, now: number): Promise<DocsFinding[]> {
  return hasMarkers(doc.text) ? staleMarkers(doc, await lineAges($, root, doc.file), now, config.staleDays) : []
}

/** One doc's own findings: dead references, stale markers, size, a finished plan (duplicates are the corpus's). */
async function checkDoc($: Engine, root: string, doc: Doc, now: number): Promise<DocsFinding[]> {
  const found = [...(await deadReferencesOf($, root, doc)), ...(await staleMarkersOf($, root, doc, now))]
  const over = oversized(doc, config.maxLines)
  if (over !== null) {
    found.push(over)
  }
  const finished = finishedPlan(doc)
  if (finished !== null) {
    found.push(finished)
  }
  return found
}

/** The orphan finding for a candidate: git dates it and says which of its references changed since. */
async function orphanOf($: Engine, root: string, candidate: OrphanCandidate, now: number): Promise<DocsFinding | null> {
  const touched = await git($, root, ['log', '-1', '--format=%ct', '--', candidate.file])
  const at = touched.ok && touched.out.trim() !== '' ? Number(touched.out.trim()) * 1000 : null
  if (at === null || !Number.isFinite(at) || now - at < config.orphanDays * DAY_MS) {
    return null
  }
  const changed = await git($, root, ['log', `--since=@${Math.floor(at / 1000)}`, '--format=', '--name-only', '--', ...candidate.refs])
  return orphanFinding(candidate, at, changed.ok ? [...new Set(trimmedLines(changed.out))] : [], now, config.orphanDays)
}

/** Whether a selection (docs by path) reaches into a series folder. */
const touchesFolder = (selected: ReadonlySet<string>, series: string): boolean => {
  const folder = series === './' ? '' : series.replace(/\/$/, '')
  return [...selected].some(file => folderOf(file) === folder)
}

/** The deterministic findings for the selected docs, judged against the whole corpus. */
async function checkScope($: Engine, root: string, corpus: readonly Doc[], selected: ReadonlySet<string>, now: number): Promise<DocsFinding[]> {
  const chosen = corpus.filter(doc => selected.has(doc.file))
  // One rg for every identifier of the selection, so the per-doc checks read the cache.
  const identifiers = [...new Set(chosen.flatMap(identifiersOf))]
  if (identifiers.length > 0) {
    await identifiersInCode($, root, identifiers)
  }
  const found: DocsFinding[] = []
  for (const doc of chosen) {
    found.push(...(await checkDoc($, root, doc, now)))
  }
  found.push(...duplicateParagraphs(corpus).filter(one => selected.has(one.file)))
  for (const candidate of orphanCandidates(corpus)) {
    if (selected.has(candidate.file)) {
      const orphan = await orphanOf($, root, candidate, now)
      if (orphan !== null) {
        found.push(orphan)
      }
    }
  }
  found.push(...datedSeries(corpus.map(doc => doc.file), config.seriesRollupAt, now).filter(one => touchesFolder(selected, one.file)))
  return sortFindings(found)
}

/** Where a named path lands in the repo: a doc in scope, or a folder; null for anything else. */
async function resolveTarget($: Engine, root: string, raw: string): Promise<Target | null> {
  const cwdRel = relativeTo(root, await $.session.cwd()) ?? ''
  const rel = raw.startsWith('/') ? relativeTo(root, raw) : relativeTo(root, joinPath(cwdRel, raw))
  if (rel === null || rel.startsWith('..')) {
    return null
  }
  const clean = rel.replace(/\/+$/, '')
  if (clean === '') {
    return { rel: '', isFolder: true }
  }
  try {
    const stat = await $.fs.stat(`${root}/${clean}`)
    if (stat.kind === 'dir') {
      return { rel: clean, isFolder: true }
    }
    return stat.kind === 'file' && inScope(clean, config.excludeGlobs) ? { rel: clean, isFolder: false } : null
  } catch {
    return null
  }
}

const inTarget = (target: Target, file: string): boolean =>
  target.isFolder ? target.rel === '' || file.startsWith(`${target.rel}/`) : file === target.rel

const targetName = (target: Target): string => (target.isFolder ? (target.rel === '' ? 'all docs' : `${target.rel}/`) : target.rel)

/** The deterministic findings for a file or folder, as the tool and `/docs check` answer them. */
async function checkPath($: Engine, raw: string): Promise<string> {
  const root = await repoRoot($)
  const target = await resolveTarget($, root, raw)
  if (target === null) {
    return `${PLUGIN}: ${raw} is not a markdown file or folder in scope.`
  }
  const corpus = await loadCorpus($, root)
  const selected = new Set(corpus.map(doc => doc.file).filter(file => inTarget(target, file)))
  const found = await checkScope($, root, corpus, selected, await $.clock.now())
  return describeFindings(found, targetName(target))
}

/** The note for Claude after a Write or Edit of a doc in scope: dead references, duplicates, stale markers. */
async function writeNote($: Engine, filePath: string, content: string | null): Promise<string | null> {
  const root = await repoRoot($)
  const cwdRel = relativeTo(root, await $.session.cwd()) ?? ''
  const rel = filePath.startsWith('/') ? relativeTo(root, filePath) : relativeTo(root, joinPath(cwdRel, filePath))
  if (rel === null || !inScope(rel, config.excludeGlobs)) {
    return null
  }
  const text = content ?? (await readText($, `${root}/${rel}`))
  if (text === null) {
    return null
  }
  const doc: Doc = { file: rel, text }
  const corpus = [...(await loadCorpus($, root)).filter(other => other.file !== rel), doc].sort(byFile)
  const now = await $.clock.now()
  const found = [...(await deadReferencesOf($, root, doc)), ...duplicateParagraphs(corpus, rel), ...(await staleMarkersOf($, root, doc, now))]
  return contextNote(rel, found, config.staleDays)
}

async function defaultBranch($: Engine, root: string): Promise<string | null> {
  const symbolic = await git($, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (symbolic.ok && symbolic.out.trim() !== '') {
    return symbolic.out.trim()
  }
  const refs = await git($, root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ])
  return refs.ok ? (trimmedLines(refs.out)[0] ?? null) : null
}

/** What the model is told about the project: name, folders, the last 20 commit subjects, the default branch. */
async function factSheet($: Engine, root: string): Promise<FactSheet> {
  const [entries, log, branch] = await Promise.all([$.fs.list(root).catch(() => []), git($, root, ['log', '-20', '--format=%s']), defaultBranch($, root)])
  const folders = entries
    .filter(entry => entry.kind === 'dir' && !EXCLUDED_DIRS.includes(entry.name) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
  return { repo: baseName(root), defaultBranch: branch?.replace(/^origin\//, '') ?? null, folders, commits: log.ok ? trimmedLines(log.out) : [] }
}

/** The files changed on the branch against the default branch; on the default branch, the last 7 days; plus the working tree. */
async function changedFiles($: Engine, root: string): Promise<{ files: Set<string>; scope: string }> {
  const [base, current] = await Promise.all([defaultBranch($, root), git($, root, ['branch', '--show-current'])])
  const branch = current.out.trim() || 'HEAD'
  const isDefault = base === null || branch === base.replace(/^origin\//, '')
  const committed = isDefault
    ? await git($, root, ['log', '--since=7.days', '--format=', '--name-only'])
    : await git($, root, ['diff', '--name-only', `${base}...HEAD`])
  const [dirty, untracked] = await Promise.all([git($, root, ['diff', '--name-only', 'HEAD']), git($, root, ['ls-files', '--others', '--exclude-standard'])])
  const files = new Set([committed, dirty, untracked].flatMap(ran => (ran.ok ? trimmedLines(ran.out) : [])))
  const scope = isDefault ? `the docs changed in the last 7 days on ${branch}` : `the docs changed on ${branch} against ${base}`
  return { files, scope }
}

/** The audit's files: each with findings (and each changed doc), sorted by path, the model cap on the most flagged. */
function auditFiles(findings: readonly DocsFinding[], selected: ReadonlySet<string>, isChanged: boolean): DocsAuditFile[] {
  const byPath = new Map<string, DocsFinding[]>()
  for (const found of findings) {
    byPath.set(found.file, [...(byPath.get(found.file) ?? []), found])
  }
  if (isChanged) {
    for (const file of selected) {
      if (!byPath.has(file)) {
        byPath.set(file, [])
      }
    }
  }
  const files: DocsAuditFile[] = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, found]) => ({ file, kind: file.endsWith('/') ? 'series' : 'doc', findings: found, items: [], model: 'waiting', modelNote: null }))
  const ranked = [...files].sort((a, b) => b.findings.length - a.findings.length || (a.file < b.file ? -1 : 1))
  for (const file of ranked.slice(config.maxModelFiles)) {
    file.model = 'skipped'
    file.modelNote = `over the ${config.maxModelFiles}-file cap (maxModelFiles)`
  }
  return files
}

/** Runs the deterministic checks now and answers; the model pass follows on a timer. */
async function startAudit($: Engine, request: Request): Promise<string> {
  const now = await $.clock.now()
  const current = await read($, audit)
  if (current?.state === 'running' && now - current.startedAt < STALE_AUDIT_MS) {
    return `${PLUGIN}: an audit is already running (${current.model} is answering); /docs show opens it.`
  }
  const root = await repoRoot($)
  const corpus = await loadCorpus($, root)
  let selected = new Set(corpus.map(doc => doc.file))
  let scope = 'all docs'
  if (request.isChanged) {
    const changed = await changedFiles($, root)
    selected = new Set([...selected].filter(file => changed.files.has(file)))
    scope = changed.scope
  } else if (request.path !== null) {
    const target = await resolveTarget($, root, request.path)
    if (target === null) {
      return `${PLUGIN}: ${request.path} is not a markdown file or folder in scope.`
    }
    selected = new Set([...selected].filter(file => inTarget(target, file)))
    scope = targetName(target)
  }
  const findings = await checkScope($, root, corpus, selected, now)
  const files = auditFiles(findings, selected, request.isChanged)
  const checked = plural(selected.size, 'doc')
  if (files.length === 0) {
    return `Docs audit of ${scope}: ${checked} checked, nothing to fix; the model was not asked.`
  }
  const asked = files.filter(file => file.model === 'waiting').length
  const skipped = files.length - asked
  const flagged = files.filter(file => file.findings.length > 0).length
  const started: DocsAudit = {
    startedAt: now,
    root,
    scope,
    docs: selected.size,
    findings: findings.length,
    files,
    model: config.model,
    state: 'running',
    isApplyAll: request.isApply,
  }
  await update($, audit, () => started)
  if (!request.isApply) {
    await $.ui.open({ id: PANE, title: TITLE }).catch((error: unknown) => debug($, `the pane could not open: ${messageOf(error)}`))
  }
  // A timer, not this command's dispatch, carries the model calls: they run on after the command has answered.
  $.clock.after(0, () => {
    void modelPass($, root, corpus, request.isApply).catch((error: unknown) => debug($, `the model pass failed: ${messageOf(error)}`))
  })
  const capNote = skipped > 0 ? ` (${skipped} more keep their findings only; maxModelFiles is ${config.maxModelFiles})` : ''
  const tail = request.isApply
    ? 'Every item is applied as it arrives; the diffs go to the debug log.'
    : 'The pane shows the plan as it arrives; Apply and Skip decide each item.'
  return `Docs audit of ${scope}: ${checked} checked, ${plural(findings.length, 'finding')} in ${plural(flagged, 'file')}. Asking ${config.model} about ${plural(asked, 'file')}${capNote}… ${tail}`
}

const failureReason = (result: Exclude<ModelCompleteResult, { isAnswered: true }>): string => {
  switch (result.reason) {
    case 'api-error':
      return result.status === null ? `the API did not answer (${result.error})` : `the API answered HTTP ${result.status} (${result.error})`
    case 'empty-reply':
      return 'the model answered with no text'
    default:
      return 'the call was cut short'
  }
}

async function setFile($: Engine, fi: number, change: Partial<DocsAuditFile>): Promise<void> {
  await update($, audit, current => (current ? { ...current, files: current.files.map((file, i) => (i === fi ? { ...file, ...change } : file)) } : current))
}

/** Asks the model about one file (a plan) or series (a roll-up) and records what it answered. */
async function askModel($: Engine, root: string, corpus: readonly Doc[], facts: FactSheet, fi: number): Promise<void> {
  const current = await read($, audit)
  const file = current?.files[fi]
  if (!current || !file) {
    return
  }
  let prompt: string
  let lines: string[] = []
  if (file.kind === 'series') {
    const folder = file.file === './' ? '' : file.file.replace(/\/$/, '')
    const dailies = corpus
      .filter(doc => folderOf(doc.file) === folder && datedName(baseName(doc.file)) !== null)
      .sort((a, b) => (datedName(baseName(a.file)) ?? '').localeCompare(datedName(baseName(b.file)) ?? ''))
    prompt = buildRollupPrompt(file.file, dailies, facts, rollupPath(file.file, await $.clock.now()))
  } else {
    const doc = corpus.find(one => one.file === file.file) ?? (await readDoc($, root, file.file))
    if (doc === null) {
      await setFile($, fi, { model: 'failed', modelNote: 'the file could not be read' })
      return
    }
    lines = doc.text.split('\n')
    prompt = buildPlanPrompt(file.file, doc.text, file.findings, facts)
  }
  let reply: ModelCompleteResult | null = null
  let refusal = ''
  try {
    reply = await $.model.complete({ model: current.model, prompt, maxTokens: MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
  } catch (error) {
    refusal = messageOf(error)
  }
  if (reply === null) {
    await setFile($, fi, { model: 'failed', modelNote: `the request was refused: ${refusal}` })
    return
  }
  if (!reply.isAnswered) {
    await setFile($, fi, { model: 'failed', modelNote: failureReason(reply) })
    return
  }
  const plan = parsePlan(reply.text, lines, file.kind === 'series')
  const items: DocsAuditItem[] = plan.items.map(item => ({ ...item, state: 'pending', note: null }))
  await setFile($, fi, { items, model: 'done', modelNote: plan.isPlan ? null : 'the reply held no usable plan' })
}

/** The background half of an audit: the model, file by file; with `--apply`, each plan applied as it lands. */
async function modelPass($: Engine, root: string, corpus: readonly Doc[], isApply: boolean): Promise<void> {
  const facts = await factSheet($, root)
  const current = await read($, audit)
  if (!current) {
    return
  }
  for (let fi = 0; fi < current.files.length; fi++) {
    if (current.files[fi]?.model !== 'waiting') {
      continue
    }
    await askModel($, root, corpus, facts, fi)
    if (isApply) {
      await applyAll($, fi)
    }
  }
  await update($, audit, done => (done ? { ...done, state: 'done' as const } : done))
  await report($, isApply)
}

/** The toast (and, for --apply, the transcript line) that ends an audit. */
async function report($: Engine, isApply: boolean): Promise<void> {
  const current = await read($, audit)
  if (!current) {
    return
  }
  const failed = current.files.filter(file => file.model === 'failed').length
  const failedNote = failed > 0 ? ` (${plural(failed, 'model call')} failed)` : ''
  if (isApply) {
    const written = new Map<string, number>()
    let count = 0
    for (const file of current.files) {
      for (const item of file.items) {
        if (item.state !== 'applied') {
          continue
        }
        count += 1
        const path = item.verdict === 'rollup' ? (item.note?.replace(/^wrote /, '') ?? file.file) : file.file
        written.set(path, (written.get(path) ?? 0) + 1)
      }
    }
    const list = [...written.entries()].map(([path, times]) => (times > 1 ? `${path} ×${times}` : path)).join(', ')
    const summary = `applied ${plural(count, 'change')} in ${plural(written.size, 'file')}`
    $.ui.toast(`Docs audit ${summary}${failedNote}`, { timeoutMs: 8_000 })
    $.ui.log(`${PLUGIN}: /docs audit --apply ${summary}${list !== '' ? ` (${list})` : ''}${failedNote}; the diffs are in the debug log.`)
    return
  }
  const proposed = current.files.flatMap(file => file.items.filter(item => item.verdict !== 'current'))
  const inFiles = current.files.filter(file => file.items.some(item => item.verdict !== 'current')).length
  const summary = proposed.length > 0 ? `${plural(proposed.length, 'change')} proposed in ${plural(inFiles, 'file')}` : 'nothing to change'
  $.ui.toast(`Docs audit ready: ${summary}${failedNote} · /docs show`, { timeoutMs: 8_000 })
}

async function setItem($: Engine, fi: number, ii: number, state: DocsItemState, note: string | null): Promise<void> {
  await update($, audit, current =>
    current
      ? {
          ...current,
          files: current.files.map((file, i) =>
            i === fi ? { ...file, items: file.items.map((item, j) => (j === ii ? { ...item, state, note } : item)) } : file,
          ),
        }
      : current,
  )
}

/** Writes one item: the section rewritten or removed, or the roll-up written beside the dailies; the diff to the debug log. */
async function performItem($: Engine, root: string, file: DocsAuditFile, item: DocsAuditItem): Promise<{ ok: boolean; note: string }> {
  if (file.kind === 'series') {
    if (item.verdict !== 'rollup' || item.replacement === null) {
      return { ok: false, note: 'nothing to write' }
    }
    const path = rollupPath(file.file, await $.clock.now())
    const text = item.replacement.endsWith('\n') ? item.replacement : `${item.replacement}\n`
    try {
      await $.fs.write(`${root}/${path}`, text)
    } catch (error) {
      return { ok: false, note: `could not write ${path}: ${messageOf(error)}` }
    }
    debug($, `applied ${path}\n@@ ${path} (rollup)\n${splitLines(text).map(line => `+${line}`).join('\n')}`)
    return { ok: true, note: `wrote ${path}` }
  }
  const text = await readText($, `${root}/${file.file}`)
  if (text === null) {
    return { ok: false, note: `could not read ${file.file}` }
  }
  const out = applyPlanItem(file.file, text, item)
  if ('error' in out) {
    return { ok: false, note: out.error }
  }
  try {
    await $.fs.write(`${root}/${file.file}`, out.text)
  } catch (error) {
    return { ok: false, note: `could not write ${file.file}: ${messageOf(error)}` }
  }
  debug($, `applied ${file.file}\n${out.diff}`)
  const span = out.range.start === out.range.end ? `line ${out.range.start + 1}` : `lines ${out.range.start + 1}-${out.range.end + 1}`
  return { ok: true, note: `${item.replacement === null ? 'removed' : 'rewrote'} ${span}` }
}

async function applyItem($: Engine, fi: number, ii: number): Promise<void> {
  const current = await read($, audit)
  const file = current?.files[fi]
  const item = file?.items[ii]
  if (!current || !file || !item || item.state !== 'pending' || item.verdict === 'current') {
    return
  }
  const outcome = await performItem($, current.root, file, item)
  await setItem($, fi, ii, outcome.ok ? 'applied' : 'failed', outcome.note)
}

async function skipItem($: Engine, fi: number, ii: number): Promise<void> {
  const current = await read($, audit)
  if (current?.files[fi]?.items[ii]?.state === 'pending') {
    await setItem($, fi, ii, 'skipped', null)
  }
}

/** Every pending item of one file, the lowest in the file first, so the ranges above it hold. */
async function applyAll($: Engine, fi: number): Promise<void> {
  const current = await read($, audit)
  const file = current?.files[fi]
  if (!current || !file) {
    return
  }
  const text = file.kind === 'doc' ? await readText($, `${current.root}/${file.file}`) : null
  const lines = text?.split('\n') ?? []
  const order = file.items
    .map((item, ii) => ({ ii, item, at: file.kind === 'doc' ? (sectionRange(lines, item.section)?.start ?? -1) : 0 }))
    .filter(({ item }) => item.state === 'pending' && item.verdict !== 'current')
    .sort((a, b) => b.at - a.at)
  for (const { ii } of order) {
    await applyItem($, fi, ii)
  }
}

async function show($: Engine): Promise<string> {
  const current = await read($, audit)
  if (!current) {
    return 'No docs audit yet. /docs audit runs one.'
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch((error: unknown) => ({ isPlaced: false as const, reason: messageOf(error) }))
  return opened.isPlaced ? `Showing the docs audit of ${current.scope}.` : `The pane could not be shown here (${opened.reason}); the audit of ${current.scope} is kept.`
}

function paneActions($: Engine): PaneActions {
  const settle = (work: Promise<void>, what: string): void => {
    void work.catch((error: unknown) => debug($, `${what} failed: ${messageOf(error)}`))
  }
  return {
    apply: (fi, ii) => settle(applyItem($, fi, ii), 'apply'),
    skip: (fi, ii) => settle(skipItem($, fi, ii), 'skip'),
    applyAll: fi => settle(applyAll($, fi), 'apply all'),
    close: () => settle($.ui.close({ id: PANE }).then(() => undefined), 'close'),
  }
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  lookups = new Map()
  roots = new Map()

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Garden the docs: /docs audit [path|--changed] [--apply] checks every markdown file and plans edits with a model; /docs check <path> runs the checks alone',
        argumentHint: 'audit [path|--changed] [--apply] | check <path> | show',
        immediate: true,
      })
      await $.tool.register({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'A markdown file or a folder, relative to the project root or absolute.' } },
          required: ['path'],
        },
        isDeferred: false,
      })
    } catch (error) {
      debug($, `could not register: ${messageOf(error)}`)
    }
    return next(e)
  })

  // The tool only reads the docs and runs git and rg: it never needs to ask, though a deny in settings stands.
  on('tool.check', { tool: TOOL }, async ($, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: `${PLUGIN}: a read-only check of the project docs` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const path = (e as { path?: unknown }).path
    if (typeof path !== 'string' || path.trim() === '') {
      return { result: `${PLUGIN}: docs_check needs a path: a markdown file or a folder.` }
    }
    return { result: await checkPath($, path.trim()) }
  })

  // A doc written or edited is checked as it now stands; the note rides with the tool's result. Never a block.
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (!config.writeTimeChecks || ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    try {
      const note = await writeNote($, e.file_path, e.tool === 'Write' ? e.content : null)
      return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
    } catch (error) {
      debug($, `the write-time check of ${e.file_path} failed: ${messageOf(error)}`)
      return ran
    }
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const others = result.blocks.filter(block => block.name !== CONTEXT_BLOCK)
    return { ...result, blocks: [...others, { name: CONTEXT_BLOCK, text: CONTEXT_TEXT }] }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const request = parseArgs(e.args)
    try {
      switch (request.kind) {
        case 'help':
          return { text: usage() }
        case 'usage':
          return { text: `${request.message}\n\n${usage()}` }
        case 'show':
          return { text: await show($) }
        case 'check':
          return { text: await checkPath($, request.path) }
        default:
          return { text: await startAudit($, request) }
      }
    } catch (error) {
      const text = `${PLUGIN}: ${messageOf(error)}`
      debug($, text)
      return { text }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => auditTree($.ui.resolve(e), await read($, audit), paneActions($)))
}
