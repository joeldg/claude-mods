import { expect, test } from 'claude-code/testing'

import type { WatchedPr } from '../types'
import {
  ciAttachment,
  describePrs,
  failingRunIds,
  gitError,
  MAX_ATTACHMENT,
  mentionedPrs,
  nameWithOwner,
  parsePrUrls,
  parseView,
  repoFromRemote,
  runIdOf,
  statusLine,
  summarizeRollup,
  tailLines,
  worktreeHolding,
} from '../hooks/pr'

const run = (name: string, status: string, conclusion: string, runId = 111) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/widgets/actions/runs/${runId}/job/9${runId}`,
  workflowName: 'CI',
})

const pr = (number: number, changes: Partial<WatchedPr> = {}): WatchedPr => ({
  number,
  repo: 'acme/widgets',
  url: `https://github.com/acme/widgets/pull/${number}`,
  title: `PR ${number}`,
  branch: `codex/pr-${number}`,
  headSha: 'a'.repeat(40),
  ci: 'pending',
  failing: [],
  runIds: [],
  state: 'open',
  cleaned: false,
  addedAt: number,
  ...changes,
})

test('summarizes a rollup: pass, fail, pending and none', () => {
  expect(summarizeRollup([run('lint', 'COMPLETED', 'SUCCESS'), run('docs', 'COMPLETED', 'SKIPPED')])).toEqual({
    ci: 'pass',
    failing: [],
    runIds: [],
  })
  expect(summarizeRollup([run('lint', 'COMPLETED', 'SUCCESS'), run('test', 'IN_PROGRESS', '')]).ci).toBe('pending')
  expect(summarizeRollup([run('test', 'QUEUED', '')]).ci).toBe('pending')
  expect(summarizeRollup([])).toEqual({ ci: 'none', failing: [], runIds: [] })
  expect(summarizeRollup(null).ci).toBe('none')
  // A failure wins over a check still running.
  expect(
    summarizeRollup([
      run('lint', 'COMPLETED', 'FAILURE', 37636185372),
      run('test', 'IN_PROGRESS', ''),
      run('e2e', 'COMPLETED', 'TIMED_OUT', 37636185999),
      run('lint', 'COMPLETED', 'FAILURE', 37636185372),
    ]),
  ).toEqual({ ci: 'fail', failing: ['lint', 'e2e'], runIds: [37636185372, 37636185999] })
})

test('reads status contexts beside check runs', () => {
  const vercel = { __typename: 'StatusContext', context: 'vercel', state: 'PENDING', targetUrl: 'https://vercel.com/x' }
  expect(summarizeRollup([run('lint', 'COMPLETED', 'SUCCESS'), vercel]).ci).toBe('pending')
  expect(summarizeRollup([{ ...vercel, state: 'SUCCESS' }]).ci).toBe('pass')
  expect(summarizeRollup([{ ...vercel, state: 'ERROR' }])).toEqual({ ci: 'fail', failing: ['vercel'], runIds: [] })
})

test('extracts the Actions run id from a details URL', () => {
  expect(runIdOf('https://github.com/cli/cli/actions/runs/37636185049/job/112842912002')).toBe(37636185049)
  expect(runIdOf('https://github.com/cli/cli/runs/112843214409')).toBeNull()
})

test('parses gh pr view output', () => {
  const view = parseView({
    number: 219,
    url: 'https://github.com/acme/widgets/pull/219',
    state: 'OPEN',
    title: 'Faster widgets',
    headRefName: 'codex/faster',
    headRefOid: 'b'.repeat(40),
    statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE', 5)],
    mergedAt: null,
  })
  expect(view).toEqual({
    number: 219,
    url: 'https://github.com/acme/widgets/pull/219',
    state: 'OPEN',
    title: 'Faster widgets',
    branch: 'codex/faster',
    headSha: 'b'.repeat(40),
    rollup: { ci: 'fail', failing: ['lint'], runIds: [5] },
  })
  expect(parseView([])).toBeNull()
  expect(parseView({ number: 1 })).toBeNull()
})

test('finds the PR URL gh pr create prints', () => {
  const created = [
    'Warning: 1 uncommitted change',
    '',
    'Creating pull request for codex/faster into main in acme/widgets',
    '',
    'https://github.com/acme/widgets/pull/219',
  ].join('\n')
  expect(parsePrUrls(created)).toEqual([
    { repo: 'acme/widgets', number: 219, url: 'https://github.com/acme/widgets/pull/219' },
  ])
  const exists =
    'a pull request for branch "codex/faster" into branch "main" already exists:\nhttps://github.com/acme/my.repo/pull/7'
  expect(parsePrUrls(exists).map(ref => `${ref.repo}#${ref.number}`)).toEqual(['acme/my.repo#7'])
  expect(parsePrUrls('https://github.com/a/b/pull/1 and again https://github.com/a/b/pull/1')).toHaveLength(1)
  expect(parsePrUrls('https://github.com/acme/widgets/issues/3')).toEqual([])
  expect(parsePrUrls(undefined)).toEqual([])
})

test('reads owner/name from remotes and gh', () => {
  expect(repoFromRemote('git@github.com:acme/widgets.git\n')).toBe('acme/widgets')
  expect(repoFromRemote('https://github.com/acme/widgets')).toBe('acme/widgets')
  expect(repoFromRemote('ssh://git@github.com/acme/my.repo.git')).toBe('acme/my.repo')
  expect(repoFromRemote('https://gitlab.com/acme/widgets.git')).toBeNull()
  expect(nameWithOwner({ nameWithOwner: 'acme/widgets' })).toBe('acme/widgets')
  expect(nameWithOwner(null)).toBeNull()
})

test('detects a prompt about a failing PR', () => {
  const watched = [pr(258, { ci: 'fail', addedAt: 2 }), pr(219, { ci: 'pass', addedAt: 1 })]
  expect(mentionedPrs('#258 is failing', watched)).toEqual([258])
  expect(mentionedPrs('#258 failed checks', [])).toEqual([258])
  expect(mentionedPrs('CI is red on PR 300, lint failed', [])).toEqual([300])
  expect(mentionedPrs('checks on 258 are failing again', watched)).toEqual([258])
  expect(mentionedPrs('lint failed on #219 and #258, and #300 too', watched)).toEqual([219, 258])
  // No number: "CI failed" means the watched PRs failing now.
  expect(mentionedPrs('CI failed again, can you look?', watched)).toEqual([258])
  expect(mentionedPrs('the build is failing', watched)).toEqual([258])
})

test('leaves prompts that are not about failing CI alone', () => {
  const watched = [pr(258, { ci: 'fail' }), pr(214)]
  expect(mentionedPrs('merged #219, clean up branches and start #214', watched)).toEqual([])
  expect(mentionedPrs('fix the 3 failing tests in parser.ts', watched)).toEqual([])
  expect(mentionedPrs('start on #214. The tests are fine', watched)).toEqual([])
  expect(mentionedPrs('CI failed', [pr(258, { ci: 'pass' })])).toEqual([])
})

test('finds the failing runs in gh pr checks output', () => {
  const checks = [
    'build (macos-latest)\tpass\t7m7s\thttps://github.com/acme/widgets/actions/runs/100/job/1\t',
    'lint\tfail\t1m2s\thttps://github.com/acme/widgets/actions/runs/200/job/2\t',
    'test\tfail\t3m\thttps://github.com/acme/widgets/actions/runs/200/job/3\t',
    'vercel\tfail\t0\thttps://vercel.com/acme\tDeployment failed',
  ].join('\n')
  expect(failingRunIds(checks)).toEqual([200])
  expect(failingRunIds('')).toEqual([])
})

test('tails a failed log without timestamps or colors', () => {
  const log = [
    'lint\tRun eslint\t2026-10-07T14:25:02.1234567Z ﻿Starting',
    'lint\tRun eslint\t2026-10-07T14:25:03.0000000Z \u001b[31msrc/a.ts:3:1 error no-unused-vars\u001b[0m',
    'lint\tRun eslint\t2026-10-07T14:25:04.0000000Z ##[error]Process completed with exit code 1.',
    '',
  ].join('\n')
  expect(tailLines(log, 2)).toBe(
    'lint\tRun eslint\tsrc/a.ts:3:1 error no-unused-vars\nlint\tRun eslint\t##[error]Process completed with exit code 1.',
  )
})

test('drops the runner cleanup after the last error', () => {
  const log = [
    'govulncheck\tUNKNOWN STEP\t2026-09-11T05:20:52.0000000Z Vulnerability #1: GO-2026-0001',
    'govulncheck\tUNKNOWN STEP\t2026-09-11T05:20:53.1016205Z ##[error]Process completed with exit code 1.',
    'govulncheck\tUNKNOWN STEP\t2026-09-11T05:20:53.1173013Z Post job cleanup.',
    'govulncheck\tUNKNOWN STEP\t2026-09-11T05:20:53.2936923Z [command]/usr/bin/git submodule foreach --recursive git config',
    'govulncheck\tUNKNOWN STEP\t2026-09-11T05:20:53.3360090Z Cleaning up orphan processes',
  ].join('\n')
  expect(tailLines(log, 120)).toBe(
    'govulncheck\tUNKNOWN STEP\tVulnerability #1: GO-2026-0001\ngovulncheck\tUNKNOWN STEP\t##[error]Process completed with exit code 1.',
  )
  // With no error line, nothing is dropped.
  expect(tailLines('a\tb\tPost job cleanup.\na\tb\tdone', 5)).toBe('a\tb\tPost job cleanup.\na\tb\tdone')
})

test('builds an attachment under the size limit', () => {
  const block = ciAttachment({
    number: 258,
    repo: 'acme/widgets',
    checks: 'lint\tfail\t1m\thttps://github.com/acme/widgets/actions/runs/200/job/2\t',
    runId: 200,
    log: Array.from({ length: 500 }, (_, i) => `lint\tRun eslint\tline ${i} ${'x'.repeat(60)}`).join('\n'),
    logLines: 400,
  })
  expect(block).toMatch(/^pr-autopilot: the prompt mentions failing CI on #258 \(acme\/widgets\)/)
  expect(block).toMatch(/`gh pr checks 258 --repo acme\/widgets`/)
  // 400 lines do not fit in 12k characters: the newest are kept, and the header counts those.
  const kept = Number(block?.match(/Last (\d+) lines of the failed log \(`gh run view 200 --repo acme\/widgets --log-failed`\)/)?.[1])
  expect(kept > 100 && kept < 400).toBe(true)
  expect(block).toMatch(/\n…\nlint\tRun eslint\tline \d+ x+\n/)
  expect(block).toMatch(/line 499 x+$/)
  expect(block).not.toMatch(/line 99 /)
  expect((block ?? '').length <= MAX_ATTACHMENT).toBe(true)
  const small = ciAttachment({ number: 7, repo: null, checks: '', runId: 9, log: 'a\nb\nc\nd\n', logLines: 3 })
  expect(small).toBe(
    'pr-autopilot: the prompt mentions failing CI on #7, so here is what gh reports.\n\n' +
      'Last 3 lines of the failed log (`gh run view 9 --log-failed`):\nb\nc\nd',
  )
  expect(ciAttachment({ number: 1, repo: null, checks: '', runId: null, log: '', logLines: 10 })).toBeNull()
})

test('finds the worktree that holds a branch', () => {
  const porcelain = [
    'worktree /Users/me/widgets',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /Users/me/widgets-faster',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/codex/faster',
    '',
  ].join('\n')
  expect(worktreeHolding(porcelain, 'codex/faster')).toBe('/Users/me/widgets-faster')
  expect(worktreeHolding(porcelain, 'codex/other')).toBeNull()
})

test('writes the status line and the /prs listing', () => {
  const list = [
    pr(219, { ci: 'pass' }),
    pr(220, { ci: 'pending' }),
    pr(221, { ci: 'fail', failing: ['lint'] }),
    pr(222, { ci: 'none' }),
    pr(200, { state: 'merged', cleaned: true }),
  ]
  expect(statusLine(list)).toBe('PRs: #219 ✓ · #220 CI… · #221 ✗ · #222')
  expect(statusLine([pr(200, { state: 'merged' })])).toBeUndefined()
  expect(describePrs(list).split('\n')).toEqual([
    '#219 acme/widgets · open · CI passed · codex/pr-219 · PR 219',
    '#220 acme/widgets · open · CI running · codex/pr-220 · PR 220',
    '#221 acme/widgets · open · CI failing: lint · codex/pr-221 · PR 221',
    '#222 acme/widgets · open · no CI checks · codex/pr-222 · PR 222',
    '#200 acme/widgets · merged, cleaned up · codex/pr-200 · PR 200',
  ])
})

test('picks the line of git stderr that says what failed', () => {
  expect(gitError("hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.\n")).toBe(
    'Not possible to fast-forward, aborting.',
  )
  expect(gitError('')).toBe('failed')
})
