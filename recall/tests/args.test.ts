import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_ASK_MODEL,
  configFrom,
  engineArgv,
  expandArgs,
  expandHome,
  expandInput,
  forgetArgs,
  listArgs,
  listInput,
  noteArgs,
  normalizeRef,
  parseKinds,
  parseRecallArgs,
  parseRememberArgs,
  parseScope,
  parseSince,
  parseSources,
  periodDays,
  projectNameOf,
  recapArgs,
  recapInput,
  searchArgs,
  searchInput,
  timelineArgs,
  updateArgs,
  freeText,
} from '../hooks/args'

describe('configFrom', () => {
  test('the manifest defaults', () => {
    expect(configFrom({})).toEqual({
      dbPath: '~/.claude/recall/index.db',
      python: '/usr/bin/python3',
      sources: ['claude', 'codex', 'memory', 'orders', 'reviews'],
      includeSubagents: true,
      includeRoutines: false,
      updateMs: 600_000,
      relatedBand: true,
      lastSessionBand: true,
      maxResults: 8,
      askModel: DEFAULT_ASK_MODEL,
    })
  })

  test('odd values are set right', () => {
    const config = configFrom({
      dbPath: '  ',
      sources: 'Codex, nope ,claude',
      updateMinutes: 0,
      maxResults: 500,
      askModel: ' claude-sonnet-4-5 ',
      includeSubagents: false,
    })
    expect(config.dbPath).toBe('~/.claude/recall/index.db')
    expect(config.sources).toEqual(['claude', 'codex'])
    expect(config.updateMs).toBe(0)
    expect(config.maxResults).toBe(25)
    expect(config.askModel).toBe('claude-sonnet-4-5')
    expect(config.includeSubagents).toBe(false)
    expect(configFrom({ updateMinutes: 0.2, maxResults: 0 })).toMatchObject({ updateMs: 60_000, maxResults: 1 })
    expect(parseSources('nothing known')).toEqual(['claude', 'codex', 'memory', 'orders', 'reviews'])
  })

  test("a project's name, a worktree's being its repository's", () => {
    expect(projectNameOf('/Users/me/widgets')).toBe('widgets')
    expect(projectNameOf('/Users/me/widgets/.claude/worktrees/feature-x')).toBe('widgets')
    expect(projectNameOf('/Users/me/widgets/')).toBe('widgets')
  })

  test('~ is the home folder', () => {
    expect(expandHome('~/.claude/recall/index.db', '/Users/me/')).toBe('/Users/me/.claude/recall/index.db')
    expect(expandHome('/data/index.db', '/Users/me')).toBe('/data/index.db')
    expect(expandHome('~/x.db', undefined)).toBe('~/x.db')
  })
})

describe('parseRecallArgs', () => {
  test('nothing, or help, is the help', () => {
    expect(parseRecallArgs('')).toEqual({ kind: 'help' })
    expect(parseRecallArgs(' help ')).toEqual({ kind: 'help' })
    expect(parseRecallArgs('--help')).toEqual({ kind: 'help' })
  })

  test('words are a search, and search <words> searches for verbs', () => {
    expect(parseRecallArgs('modal deploy')).toEqual({ kind: 'search', query: 'modal deploy' })
    expect(parseRecallArgs('"NAS file" OR backup')).toEqual({ kind: 'search', query: '"NAS file" OR backup' })
    expect(parseRecallArgs('search last week')).toEqual({ kind: 'search', query: 'last week' })
    expect(parseRecallArgs('search').kind).toBe('usage')
    expect(parseRecallArgs('help me find the deploy')).toEqual({ kind: 'search', query: 'help me find the deploy' })
  })

  test('last [n]', () => {
    expect(parseRecallArgs('last')).toEqual({ kind: 'last', count: 1 })
    expect(parseRecallArgs('last 3')).toEqual({ kind: 'last', count: 3 })
    expect(parseRecallArgs('last 99')).toEqual({ kind: 'last', count: 5 })
    expect(parseRecallArgs("last week's deploy")).toEqual({ kind: 'search', query: "last week's deploy" })
  })

  test('timeline [period] [all]', () => {
    expect(parseRecallArgs('timeline')).toEqual({ kind: 'timeline', days: 14, isAll: false })
    expect(parseRecallArgs('timeline 7d')).toEqual({ kind: 'timeline', days: 7, isAll: false })
    expect(parseRecallArgs('timeline 30d all')).toEqual({ kind: 'timeline', days: 30, isAll: true })
    expect(parseRecallArgs('timeline all 90d')).toEqual({ kind: 'timeline', days: 90, isAll: true })
    expect(parseRecallArgs('timeline 2w')).toEqual({ kind: 'timeline', days: 14, isAll: false })
    expect(parseRecallArgs('timeline of deploys')).toEqual({ kind: 'search', query: 'timeline of deploys' })
    expect(periodDays('0d')).toBeNull()
    expect(periodDays('12h')).toBeNull()
  })

  test('the lists, each with an optional query', () => {
    expect(parseRecallArgs('decisions')).toEqual({ kind: 'list', listKind: 'decision', query: '' })
    expect(parseRecallArgs('decisions about caching')).toEqual({ kind: 'list', listKind: 'decision', query: 'about caching' })
    expect(parseRecallArgs('commands modal')).toEqual({ kind: 'list', listKind: 'command', query: 'modal' })
    expect(parseRecallArgs('files')).toEqual({ kind: 'list', listKind: 'file', query: '' })
    expect(parseRecallArgs('prs')).toEqual({ kind: 'list', listKind: 'pr', query: '' })
    expect(parseRecallArgs('PR retry')).toEqual({ kind: 'list', listKind: 'pr', query: 'retry' })
    expect(parseRecallArgs('commits')).toEqual({ kind: 'list', listKind: 'commit', query: '' })
    expect(parseRecallArgs('issues')).toEqual({ kind: 'list', listKind: 'issue', query: '' })
    expect(parseRecallArgs('urls')).toEqual({ kind: 'list', listKind: 'url', query: '' })
    expect(parseRecallArgs('tasks')).toEqual({ kind: 'list', listKind: 'task', query: '' })
    expect(parseRecallArgs('notes')).toEqual({ kind: 'list', listKind: 'note', query: '' })
  })

  test('ask <question>', () => {
    expect(parseRecallArgs('ask what did we decide about retries?')).toEqual({
      kind: 'ask',
      question: 'what did we decide about retries?',
    })
    expect(parseRecallArgs('ask').kind).toBe('usage')
  })

  test('stats and reindex stand alone', () => {
    expect(parseRecallArgs('stats')).toEqual({ kind: 'stats' })
    expect(parseRecallArgs('stats for the upload')).toEqual({ kind: 'search', query: 'stats for the upload' })
    expect(parseRecallArgs('reindex')).toEqual({ kind: 'reindex' })
  })

  test('forget names what, or shows how', () => {
    expect(parseRecallArgs('forget session 3f2a9c1e-77aa')).toEqual({
      kind: 'forget',
      target: { kind: 'session', id: '3f2a9c1e-77aa' },
    })
    expect(parseRecallArgs('forget project old widgets')).toEqual({
      kind: 'forget',
      target: { kind: 'project', name: 'old widgets' },
    })
    expect(parseRecallArgs('forget before 2026-01-01')).toEqual({
      kind: 'forget',
      target: { kind: 'before', date: '2026-01-01' },
    })
    expect(parseRecallArgs('forget before 90d')).toEqual({ kind: 'forget', target: { kind: 'before', date: '90d' } })
    for (const bad of ['forget', 'forget everything', 'forget session', 'forget before soon', 'forget session a b']) {
      expect(parseRecallArgs(bad).kind).toBe('usage')
    }
  })
})

describe('parseRememberArgs', () => {
  test('a note, list, or forget <ref>', () => {
    expect(parseRememberArgs('').kind).toBe('usage')
    expect(parseRememberArgs('list')).toEqual({ kind: 'list' })
    expect(parseRememberArgs('forget d9')).toEqual({ kind: 'forget', ref: 'd9' })
    expect(parseRememberArgs('forget 9')).toEqual({ kind: 'forget', ref: 'd9' })
    expect(parseRememberArgs('forget about the old API')).toEqual({ kind: 'add', text: 'forget about the old API' })
    expect(parseRememberArgs(' the NAS backups live in /Volumes/nas/backups ')).toEqual({
      kind: 'add',
      text: 'the NAS backups live in /Volumes/nas/backups',
    })
    expect(parseRememberArgs('list of things to do')).toEqual({ kind: 'add', text: 'list of things to do' })
    expect(normalizeRef('[d123]')).toBe('d123')
    expect(normalizeRef('x123')).toBeNull()
  })
})

describe('tool inputs', () => {
  test('scope', () => {
    expect(parseScope(undefined)).toEqual({ kind: 'this' })
    expect(parseScope('This Project')).toEqual({ kind: 'this' })
    expect(parseScope('all projects')).toEqual({ kind: 'all' })
    expect(parseScope('all')).toEqual({ kind: 'all' })
    expect(parseScope('gadgets')).toEqual({ kind: 'named', name: 'gadgets' })
  })

  test('kinds and since', () => {
    expect(parseKinds(['decision', 'PRs', 'bogus', 'commands'])).toEqual(['decision', 'pr', 'command'])
    expect(parseKinds('file, commit')).toEqual(['file', 'commit'])
    expect(parseKinds(7)).toEqual([])
    expect(parseSince(' 7d ')).toBe('7d')
    expect(parseSince('2026-09-01')).toBe('2026-09-01')
    expect(parseSince('; rm -rf /')).toBeNull()
  })

  test('search, expand, recap and list inputs', () => {
    expect(searchInput({ query: '  modal deploy ', limit: 99 }, 8)).toEqual({
      query: 'modal deploy',
      scope: { kind: 'this' },
      kinds: [],
      since: null,
      limit: 25,
    })
    expect(searchInput({ query: 'x', scope: 'all projects', kinds: ['decision'], since: '30d' }, 8)).toEqual({
      query: 'x',
      scope: { kind: 'all' },
      kinds: ['decision'],
      since: '30d',
      limit: 8,
    })
    expect('error' in searchInput({ query: '  ' }, 8)).toBe(true)
    expect(expandInput({ ref: 'd123' })).toEqual({ ref: 'd123' })
    expect(expandInput({ ref: 123 })).toEqual({ ref: 'd123' })
    expect('error' in expandInput({})).toBe(true)
    expect(recapInput({ count: 9, scope: 'gadgets' })).toEqual({ scope: { kind: 'named', name: 'gadgets' }, count: 5 })
    expect(recapInput({})).toEqual({ scope: { kind: 'this' }, count: 1 })
    expect(listInput({ kind: 'decision', query: 'cache' }, 8)).toEqual({
      kind: 'decision',
      query: 'cache',
      scope: { kind: 'this' },
      since: null,
      limit: 15,
    })
    expect('error' in listInput({ kind: 'prompt' }, 8)).toBe(true)
  })
})

describe('engine command lines', () => {
  const config = configFrom({})

  test('the script, the index, then the command', () => {
    expect(engineArgv(config, '/opt/mods/recall/', '/Users/me/.claude/recall/index.db', ['stats'])).toEqual([
      '/usr/bin/python3',
      '/opt/mods/recall/engine/recall.py',
      '--db',
      '/Users/me/.claude/recall/index.db',
      'stats',
    ])
  })

  test('update', () => {
    expect(updateArgs(config)).toEqual(['update', '--sources', 'claude,codex,memory,orders,reviews', '--subagents'])
    expect(updateArgs(configFrom({ includeSubagents: false, sources: 'claude' }), { maxSeconds: 45 })).toEqual([
      'update',
      '--sources',
      'claude',
      '--max-seconds',
      '45',
    ])
    expect(updateArgs(config, { progress: true, rebuild: true }).slice(-2)).toEqual(['--progress', '--rebuild'])
  })

  test('search', () => {
    expect(
      searchArgs({
        query: 'modal deploy',
        project: '/Users/me/widgets',
        boost: '/Users/me/widgets',
        exclude: 'sess-now',
        kinds: ['command', 'file'],
        since: '30d',
        limit: 8,
        routines: 'exclude',
      }),
    ).toEqual([
      'search',
      '--query',
      'modal deploy',
      '--project',
      '/Users/me/widgets',
      '--boost-project',
      '/Users/me/widgets',
      '--exclude-session',
      'sess-now',
      '--kinds',
      'command,file',
      '--since',
      '30d',
      '--limit',
      '8',
      '--routines',
      'exclude',
    ])
    expect(
      searchArgs({ query: 'x', project: 'all', boost: null, exclude: null, kinds: [], since: null, limit: 5, routines: 'include' }),
    ).toEqual(['search', '--query', 'x', '--project', 'all', '--limit', '5', '--routines', 'include'])
  })

  test('the rest', () => {
    expect(expandArgs('d123')).toEqual(['expand', '--ref', 'd123', '--before', '4', '--after', '4', '--max-chars', '6000'])
    expect(recapArgs({ project: '/Users/me/widgets', exclude: 'sess-now', count: 2 })).toEqual([
      'recap',
      '--project',
      '/Users/me/widgets',
      '--exclude-session',
      'sess-now',
      '--count',
      '2',
      '--routines',
      'exclude',
    ])
    expect(recapArgs({ project: null, exclude: null, count: 1, session: 's-1' })).toEqual(['recap', '--session', 's-1'])
    // The engine's list takes no --routines.
    expect(listArgs({ kind: 'decision', query: 'cache', project: 'all', since: '7d', limit: 15 })).toEqual([
      'list',
      '--kind',
      'decision',
      '--query',
      'cache',
      '--project',
      'all',
      '--since',
      '7d',
      '--limit',
      '15',
    ])
    expect(timelineArgs('/Users/me/widgets', 30, 'exclude')).toEqual([
      'timeline',
      '--project',
      '/Users/me/widgets',
      '--since',
      '30d',
      '--limit',
      '60',
      '--routines',
      'exclude',
    ])
    expect(forgetArgs({ kind: 'session', id: 's-1' })).toEqual(['forget', '--session', 's-1'])
    expect(forgetArgs({ kind: 'project', name: 'widgets' })).toEqual(['forget', '--project', 'widgets'])
    expect(forgetArgs({ kind: 'before', date: '90d' })).toEqual(['forget', '--before', '90d'])
    expect(noteArgs('add', 'keep it', '/Users/me/widgets')).toEqual(['note', 'add', '--text', 'keep it', '--project', '/Users/me/widgets'])
    expect(noteArgs('list', '', '/Users/me/widgets')).toEqual(['note', 'list', '--project', '/Users/me/widgets', '--limit', '50'])
    expect(noteArgs('forget', 'd9', null)).toEqual(['note', 'forget', '--ref', 'd9'])
  })
})

test('free text that starts with a dash is passed as --name=value, so argparse cannot take it for an option', () => {
  expect(freeText('--query', 'modal deploy')).toEqual(['--query', 'modal deploy'])
  expect(freeText('--query', '--force push')).toEqual(['--query=--force push'])
  expect(freeText('--text', '-x is the flag')).toEqual(['--text=-x is the flag'])
  expect(noteArgs('add', '--dry-run first', null)).toEqual(['note', 'add', '--text=--dry-run first'])
})
