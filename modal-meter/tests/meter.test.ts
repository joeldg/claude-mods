import { expect, test } from 'claude-code/testing'

import type { ModalApp, ModalCache, ModalMeter, ModalShared } from '../types'
import {
  activeApps,
  alertText,
  cliCandidates,
  brief,
  dueAlerts,
  errorBox,
  formatDuration,
  fullReason,
  isCacheEntry,
  isDependencyFile,
  isEnoent,
  isLock,
  isMissingModule,
  isModalCommand,
  isProjectRecord,
  isTimeout,
  kindOf,
  lacksBilling,
  namesModal,
  nextInterval,
  paneNotice,
  parseAppList,
  parseSpend,
  parseTimestamp,
  reasonText,
  retryText,
  rowText,
  servesPoll,
  splitCommand,
  statusText,
  summaryText,
  trackApps,
  wantsYes,
} from '../hooks/meter'

const MIN = 60_000
const NOW = Date.parse('2026-10-07T15:00:00Z')

/** `modal app list --json` as Modal 1.2 prints it: title-case keys, Tasks a string, local ISO times. */
const LIST_OLD = JSON.stringify(
  [
    {
      'App ID': 'ap-0123456789abcdefABCDEF',
      Description: 'image-worker',
      State: 'ephemeral (detached)',
      Tasks: '2',
      'Created at': '2026-10-07 07:15:00-07:00',
      'Stopped at': null,
    },
    {
      'App ID': 'ap-fedcba9876543210FEDCBA',
      Description: 'trainer',
      State: 'deployed',
      Tasks: '0',
      'Created at': '2026-09-20 10:00:00-07:00',
      'Stopped at': null,
    },
    {
      'App ID': 'ap-00000000000000000000zz',
      Description: 'old-sweep',
      State: 'stopped',
      Tasks: '0',
      'Created at': '2026-10-06 09:00:00-07:00',
      'Stopped at': '2026-10-06 11:30:00-07:00',
    },
  ],
  null,
  4,
)

/** The same as Modal 1.5 and later print it: keys in snake_case. */
const LIST_NEW = JSON.stringify([
  {
    app_id: 'ap-0123456789abcdefABCDEF',
    description: 'image-worker',
    state: 'initializing...',
    tasks: '1',
    created_at: '2026-10-07 07:55:00-07:00',
    stopped_at: null,
  },
])

/** `modal app list --json` with no token, as Modal 1.2 prints it to a pipe: one paragraph wrapped in a Rich error box. */
const TOKEN_BOX =
  '╭─ Error ──────────────────────────────────────────────────────────────────────╮\n' +
  '│ Token missing. Could not authenticate client. If you have token credentials, │\n' +
  '│ see modal.com/docs/reference/modal.config for setup help. If you are a new   │\n' +
  '│ user, register an account at modal.com, then run `modal token new`.          │\n' +
  '╰──────────────────────────────────────────────────────────────────────────────╯\n'
/** The box's message, unwrapped. */
const TOKEN_MESSAGE =
  'Token missing. Could not authenticate client. If you have token credentials, see modal.com/docs/reference/modal.config for setup help. If you are a new user, register an account at modal.com, then run `modal token new`.'

const app = (over: Partial<ModalApp>): ModalApp => ({
  id: 'ap-x',
  name: 'image-worker',
  state: 'ephemeral',
  containers: 0,
  createdAt: null,
  stoppedAt: null,
  ...over,
})

test('reads app list JSON in both key spellings', () => {
  const old = parseAppList(LIST_OLD)
  expect(old).toEqual([
    {
      id: 'ap-0123456789abcdefABCDEF',
      name: 'image-worker',
      state: 'detached',
      containers: 2,
      createdAt: Date.parse('2026-10-07T14:15:00Z'),
      stoppedAt: null,
    },
    {
      id: 'ap-fedcba9876543210FEDCBA',
      name: 'trainer',
      state: 'deployed',
      containers: 0,
      createdAt: Date.parse('2026-09-20T17:00:00Z'),
      stoppedAt: null,
    },
    {
      id: 'ap-00000000000000000000zz',
      name: 'old-sweep',
      state: 'stopped',
      containers: 0,
      createdAt: Date.parse('2026-10-06T16:00:00Z'),
      stoppedAt: Date.parse('2026-10-06T18:30:00Z'),
    },
  ])
  const fresh = parseAppList(LIST_NEW)
  expect(fresh?.[0]).toMatchObject({ name: 'image-worker', state: 'initializing', containers: 1 })
})

test('app list parsing survives missing fields, styling and junk', () => {
  const sparse = parseAppList(
    JSON.stringify([{ 'App ID': 'ap-1' }, { Description: 'no id' }, 'nonsense', { app_id: 'ap-2', tasks: 3 }]),
  )
  expect(sparse).toEqual([
    { id: 'ap-1', name: 'ap-1', state: 'unknown', containers: 0, createdAt: null, stoppedAt: null },
    { id: 'ap-2', name: 'ap-2', state: 'unknown', containers: 3, createdAt: null, stoppedAt: null },
  ])
  // rich styles JSON keys in bold when FORCE_COLOR is set.
  const styled = '\u001b[1m[\u001b[0m\n  \u001b[1m{\u001b[0m\n    \u001b[1;34m"App ID"\u001b[0m: \u001b[32m"ap-3"\u001b[0m\n  \u001b[1m}\u001b[0m\n\u001b[1m]\u001b[0m\n'
  expect(parseAppList(styled)?.[0]?.id).toBe('ap-3')
  expect(parseAppList('[]')).toEqual([])
  expect(parseAppList('Token missing. Could not authenticate client.')).toBeNull()
  expect(parseAppList('{"not": "a list"}')).toBeNull()
})

test('the reason in a Rich error box: frame stripped, wrapped lines joined, cut at a sentence end', () => {
  expect(errorBox(TOKEN_BOX)).toEqual([TOKEN_MESSAGE])
  expect(reasonText(TOKEN_BOX)).toBe('Token missing. Could not authenticate client.')
  expect(fullReason(TOKEN_BOX)).toBe(TOKEN_MESSAGE)
  // With FORCE_COLOR rich colours the frame.
  const styled = TOKEN_BOX.split('\n')
    .map(line => line.replace(/^(.)/, '\u001b[31m$1\u001b[0m').replace(/(.)$/, '\u001b[31m$1\u001b[0m'))
    .join('\n')
  expect(reasonText(styled)).toBe('Token missing. Could not authenticate client.')
  // A gRPC error: the status in the title, details in a second paragraph; the usage lines before the box are not the reason.
  const grpc =
    "Usage: modal app list [OPTIONS]\nTry 'modal app list -h' for help.\n╭─ Error: Permission denied ─╮\n│ Workspace is suspended.    │\n│                            │\n│ Details: contact support.  │\n╰────────────────────────────╯\n"
  expect(errorBox(grpc)).toEqual(['Workspace is suspended.', 'Details: contact support.'])
  expect(reasonText(grpc)).toBe('Workspace is suspended.')
  expect(fullReason(grpc)).toBe('Workspace is suspended. Details: contact support.')
  // No box: the first line worth showing, as before, cut the same way.
  expect(errorBox('Connection refused\n')).toBeNull()
  expect(reasonText('Connection refused\n')).toBe('Connection refused')
  expect(reasonText(`${TOKEN_MESSAGE}\n`)).toBe('Token missing. Could not authenticate client.')
  expect(reasonText('')).toBe('no output')
  // A traceback's box is not the error; the line after it is.
  const traceback =
    '╭─ Traceback (most recent call last) ─╮\n│ File "app.py", line 1              │\n╰─────────────────────────────────────╯\nValueError: bad config\n'
  expect(reasonText(traceback)).toBe('ValueError: bad config')
  // Short text stays whole; long text ends at a sentence, or at an ellipsis when it has none.
  expect(brief('Token not found')).toBe('Token not found')
  expect(brief('a'.repeat(130))).toBe(`${'a'.repeat(119)}…`)
  expect(brief(`${'a'.repeat(100)}. ${'b'.repeat(50)}.`)).toBe(`${'a'.repeat(100)}.`)
})

test('timestamps: Modal JSON, ISO, epoch seconds and ms', () => {
  expect(parseTimestamp('2026-10-07 07:15:00-07:00')).toBe(Date.parse('2026-10-07T14:15:00Z'))
  expect(parseTimestamp('2026-10-07T14:15:00Z')).toBe(Date.parse('2026-10-07T14:15:00Z'))
  expect(parseTimestamp(1_791_400_000)).toBe(1_791_400_000_000)
  expect(parseTimestamp('1791400000.5')).toBe(1_791_400_000_500)
  expect(parseTimestamp(null)).toBeNull()
  expect(parseTimestamp('not a date')).toBeNull()
})

test('classifies running, idle and stopped apps', () => {
  expect(kindOf(app({ state: 'deployed', containers: 2 }))).toBe('running')
  expect(kindOf(app({ state: 'deployed' }))).toBe('idle')
  expect(kindOf(app({ state: 'ephemeral' }))).toBe('running')
  expect(kindOf(app({ state: 'detached' }))).toBe('running')
  expect(kindOf(app({ state: 'initializing' }))).toBe('running')
  expect(kindOf(app({ state: 'stopped' }))).toBe('stopped')
  expect(kindOf(app({ state: 'stopping' }))).toBe('stopped')
  expect(kindOf(app({ state: 'stopping', containers: 1 }))).toBe('running')
  expect(kindOf(app({ state: 'disabled' }))).toBe('stopped')
  expect(kindOf(app({ state: 'unknown' }))).toBe('idle')

  const listed = parseAppList(LIST_OLD) ?? []
  expect(activeApps(listed).map(one => one.name)).toEqual(['image-worker', 'trainer'])
})

test('status line text', () => {
  const listed = parseAppList(LIST_OLD) ?? []
  expect(statusText(listed)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  expect(statusText([app({ containers: 1 })])).toBe('Modal: 1 running (1 container)')
  expect(statusText([app({ state: 'initializing' })])).toBe('Modal: 1 running')
  expect(statusText([app({ state: 'deployed' }), app({ id: 'b', state: 'deployed' })])).toBe('Modal: 2 deployed')
  expect(statusText([app({ state: 'deployed' }), app({ id: 'b', state: 'deployed' })], false)).toBeUndefined()
  expect(statusText(listed, false)).toBe('Modal: 1 running (2 containers) · 1 deployed')
  expect(statusText([app({ state: 'stopped' })])).toBeUndefined()
  expect(statusText([])).toBeUndefined()
})

test('alerts once past the threshold, then once per interval', () => {
  const alertMs = 30 * MIN
  const worker = app({ id: 'w', state: 'detached', containers: 2, createdAt: NOW - 10 * MIN })
  let tracked = trackApps({}, [worker], NOW)
  expect(tracked.w).toEqual({ busySince: NOW - 10 * MIN, alertedAt: null })
  expect(dueAlerts([worker], tracked, NOW + 20 * MIN, alertMs)).toEqual([])
  expect(dueAlerts([worker], tracked, NOW + 21 * MIN, alertMs)).toEqual([worker])

  tracked = { w: { busySince: NOW - 10 * MIN, alertedAt: NOW + 21 * MIN } }
  expect(dueAlerts([worker], trackApps(tracked, [worker], NOW + 50 * MIN), NOW + 50 * MIN, alertMs)).toEqual([])
  expect(dueAlerts([worker], trackApps(tracked, [worker], NOW + 51 * MIN), NOW + 51 * MIN, alertMs)).toEqual([worker])
})

test('deployed apps count from their first containers, never alert idle, and keep the alert time between bursts', () => {
  const alertMs = 30 * MIN
  const deployed = app({ id: 'd', state: 'deployed', createdAt: NOW - 20 * 24 * 60 * MIN })
  let tracked = trackApps({}, [deployed], NOW)
  expect(tracked.d).toEqual({ busySince: null, alertedAt: null })
  expect(dueAlerts([deployed], tracked, NOW + 999 * MIN, alertMs)).toEqual([])

  const busy = { ...deployed, containers: 3 }
  tracked = trackApps(tracked, [busy], NOW + 5 * MIN)
  expect(tracked.d?.busySince).toBe(NOW + 5 * MIN)
  expect(dueAlerts([busy], tracked, NOW + 34 * MIN, alertMs)).toEqual([])
  expect(dueAlerts([busy], tracked, NOW + 36 * MIN, alertMs)).toEqual([busy])

  // Containers go and come back: the clock restarts, the last alert is remembered.
  tracked = { d: { busySince: NOW + 5 * MIN, alertedAt: NOW + 36 * MIN } }
  tracked = trackApps(tracked, [deployed], NOW + 40 * MIN)
  expect(tracked.d).toEqual({ busySince: null, alertedAt: NOW + 36 * MIN })
  // A stopped app drops out.
  expect(trackApps(tracked, [{ ...deployed, state: 'stopped' }], NOW + 41 * MIN)).toEqual({})
})

test('durations, rows and the alert line', () => {
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(45 * MIN)).toBe('45m')
  expect(formatDuration(120 * MIN)).toBe('2h')
  expect(formatDuration(125 * MIN)).toBe('2h 5m')
  expect(formatDuration((3 * 24 + 4) * 60 * MIN)).toBe('3d 4h')

  const worker = app({ name: 'image-worker', state: 'detached', containers: 2, createdAt: NOW - 45 * MIN })
  expect(rowText(worker, { busySince: NOW - 45 * MIN, alertedAt: null }, NOW)).toBe(
    'image-worker · detached · 2 containers · up 45m',
  )
  expect(rowText(app({ name: 'trainer', state: 'deployed' }), undefined, NOW)).toBe('trainer · deployed · 0 containers')
  expect(alertText(worker, 45 * MIN)).toBe('Modal app image-worker has run 45m with 2 containers — /modal to stop it')
})

test('finds the CLI: the option split into argv, else modal then python3 -m modal', () => {
  expect(cliCandidates('')).toEqual([['modal'], ['python3', '-m', 'modal']])
  expect(cliCandidates('  uv run modal ')).toEqual([['uv', 'run', 'modal']])
  expect(splitCommand('"/opt/my env/bin/python" -m modal')).toEqual(['/opt/my env/bin/python', '-m', 'modal'])
})

test('spend from billing report JSON, and the failures told apart', () => {
  expect(
    parseSpend(
      JSON.stringify([
        { object_id: 'ap-1', description: 'image-worker', environment: 'main', interval_start: '2026-10-07', cost: '1.25' },
        { object_id: 'ap-2', description: 'trainer', environment: 'main', interval_start: '2026-10-07', cost: '0.5' },
      ]),
    ),
  ).toBe(1.75)
  expect(parseSpend(JSON.stringify([{ 'Object ID': 'ap-1', Cost: '2.10' }]))).toBe(2.1)
  expect(parseSpend('[]')).toBe(0)
  expect(parseSpend('Usage: modal billing report')).toBeNull()

  const noBilling =
    "Usage: python -m modal [OPTIONS] COMMAND [ARGS]...\nTry 'python -m modal -h' for help.\n╭─ Error ──────╮\n│ No such command 'billing'. │\n╰──────────────╯"
  expect(lacksBilling(noBilling)).toBe(true)
  // The usage error for an unknown command, as its first line reaches a log; not one for billing's own options.
  expect(lacksBilling("Usage: modal [OPTIONS] COMMAND [ARGS]...\nTry 'modal -h' for help.")).toBe(true)
  expect(lacksBilling('Usage: modal billing report [OPTIONS]\nNo such option: --for')).toBe(false)
  expect(lacksBilling("Usage: modal billing [OPTIONS] COMMAND [ARGS]...\nNo such command 'report'.")).toBe(false)
  expect(reasonText(noBilling)).toBe("No such command 'billing'.")
  expect(isMissingModule('/usr/bin/python3: No module named modal')).toBe(true)
  expect(
    wantsYes("Are you sure? [y/N]:\nAborted: no interactive terminal detected. Rerun with --yes (-y) to skip confirmation."),
  ).toBe(true)
  expect(wantsYes('App is already stopped.')).toBe(false)
})

test('the /modal summary', () => {
  const apps = parseAppList(LIST_OLD) ?? []
  const meter: ModalMeter = {
    cli: 'python3 -m modal',
    problem: null,
    apps,
    polledAt: NOW,
    retryAt: null,
    spendToday: null,
    spendNote: 'this Modal CLI has no `billing report` command',
  }
  const tracked = trackApps({}, apps, NOW)
  expect(summaryText(meter, tracked, NOW, 0).split('\n')).toEqual([
    'Modal: 1 running (2 containers) · 1 deployed (read with `python3 -m modal`)',
    '  image-worker · detached · 2 containers · up 45m',
    '  trainer · deployed · 0 containers · up 16d 22h (idle)',
    'Spend: not shown (this Modal CLI has no `billing report` command)',
  ])
  expect(summaryText({ ...meter, spendToday: 3.5, spendNote: null }, tracked, NOW, 5).split('\n').at(-1)).toBe(
    'Spend today (UTC): $3.50 of a $5.00 daily budget',
  )
  expect(summaryText({ ...meter, apps: [], problem: 'no Modal CLI found' }, {}, NOW, 0)).toBe(
    'modal-meter is silent: no Modal CLI found.',
  )

  // The pane's notice: the problem, the wait, the reason it is not watching, or no rows.
  expect(paneNotice({ ...meter, apps: [], problem: 'no Modal CLI found' }, true, NOW)).toBe('modal-meter is silent: no Modal CLI found.')
  expect(paneNotice({ ...meter, polledAt: null }, true, NOW)).toBe('Reading Modal…')
  expect(paneNotice({ ...meter, polledAt: null }, false, NOW)).toMatch(/^Not watching Modal: this project does not use it\. \/modal starts watching/)
  expect(paneNotice({ ...meter, apps: [] }, true, NOW)).toBe('No Modal apps running or deployed.')
  expect(paneNotice(meter, true, NOW)).toBeNull()

  // The CLI refused: its reason and the wait, counting down, in the pane and on the status line; /modal adds the retry hint.
  const refused: ModalMeter = { ...meter, apps: [], problem: 'Token missing. Could not authenticate client.', retryAt: NOW + 60 * MIN }
  expect(retryText('Token missing. Could not authenticate client.', NOW + 60 * MIN, NOW)).toBe(
    'Modal: Token missing. Could not authenticate client. · retry in 60m',
  )
  expect(paneNotice(refused, true, NOW + 59 * MIN + 1)).toBe('Modal: Token missing. Could not authenticate client. · retry in 1m')
  expect(paneNotice(refused, true, NOW + 61 * MIN)).toBe('Modal: Token missing. Could not authenticate client. · retry in 1m')
  expect(summaryText(refused, {}, NOW, 0)).toBe(
    'Modal: Token missing. Could not authenticate client. · retry in 60m (`python3 -m modal app list` failed; /modal retries at once)',
  )
})

test('a Bash command that runs modal, and project files that name it', () => {
  expect(isModalCommand('modal run train.py')).toBe(true)
  expect(isModalCommand('cd /home/dev/app && python3 -m modal deploy app.py')).toBe(true)
  expect(isModalCommand('MODAL_PROFILE=work uv run modal app list')).toBe(true)
  expect(isModalCommand('./.venv/bin/modal token new')).toBe(true)
  expect(isModalCommand('ls | grep modal')).toBe(false)
  expect(isModalCommand('rg -n modal README.md')).toBe(false)
  expect(isModalCommand('echo "modal is down"')).toBe(false)
  expect(isModalCommand('pip install modal')).toBe(false)
  expect(isModalCommand('')).toBe(false)

  expect(namesModal('pyproject.toml', '[project]\ndependencies = ["numpy", "modal>=1.0"]\n')).toBe(true)
  expect(namesModal('pyproject.toml', '[tool.poetry.dependencies]\nmodal = "^1.0"\n')).toBe(true)
  expect(namesModal('pyproject.toml', '[project]\ndescription = "a modal dialog"\n')).toBe(false)
  expect(namesModal('requirements.txt', 'numpy\nmodal==1.2.6\n')).toBe(true)
  expect(namesModal('requirements-dev.txt', '# modal\nruff\n')).toBe(false)
  expect(namesModal('uv.lock', '[[package]]\nname = "modal"\nversion = "1.2.6"\n')).toBe(true)
  expect(namesModal('poetry.lock', 'name = "modal-dialog"\n')).toBe(false)
  expect(namesModal('package.json', '"modal": "1.0"')).toBe(false)
  expect(['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'uv.lock', 'poetry.lock'].every(isDependencyFile)).toBe(true)
  expect(isDependencyFile('requirements.in')).toBe(false)
})

test('the poll interval doubles after a slow or timed-out probe, and comes back after a fast one', () => {
  expect(nextInterval(MIN, MIN, 500, false, true)).toBe(MIN)
  expect(nextInterval(MIN, MIN, 2_500, false, true)).toBe(2 * MIN)
  expect(nextInterval(2 * MIN, MIN, 60_000, true, false)).toBe(4 * MIN)
  expect(nextInterval(8 * MIN, MIN, 60_000, true, false)).toBe(10 * MIN)
  expect(nextInterval(10 * MIN, MIN, 60_000, true, false)).toBe(10 * MIN)
  expect(nextInterval(4 * MIN, MIN, 800, false, true)).toBe(MIN)
  // A fast failure (no profile, say) changes nothing.
  expect(nextInterval(4 * MIN, MIN, 800, false, false)).toBe(4 * MIN)
  // Never below the option.
  expect(nextInterval(15 * MIN, 15 * MIN, 5_000, false, true)).toBe(15 * MIN)

  expect(isTimeout('HooksError: modal-meter: $.process.run(modal) aborted: still running after 60000ms')).toBe(true)
  expect(isTimeout('ENOENT: Executable not found in $PATH: "modal"')).toBe(false)
  expect(isEnoent('HooksError: modal-meter: $.process.run(modal) failed to start: ENOENT: Executable not found in $PATH: "modal"')).toBe(true)
  expect(isEnoent('Token missing.')).toBe(false)
})

test('the shared cache answers a tick while fresh or while a refusal is waited out; /modal retries a refusal at once; a stop polls', () => {
  const entry = (over: Partial<Omit<ModalCache, 'data'>> = {}, data: Partial<ModalShared> = {}): ModalCache => ({
    ts: NOW - 10_000,
    by: 'sess-b',
    intervalMs: MIN,
    ...over,
    data: { cli: ['modal'], problem: null, apps: [], retryAt: null, spendToday: null, spendNote: null, spendAskedAt: null, spendWaitMs: 5 * MIN, billingUnsupportedAt: null, ...data },
  })
  expect(servesPoll('tick', entry(), NOW)).toBe(true)
  expect(servesPoll('asked', entry(), NOW)).toBe(true)
  expect(servesPoll('changed', entry(), NOW)).toBe(false)
  expect(servesPoll('tick', entry({ ts: NOW - 2 * MIN }), NOW)).toBe(false)
  expect(servesPoll('asked', entry({ ts: NOW - 2 * MIN }), NOW)).toBe(false)

  const refused = entry({ ts: NOW - 2 * MIN }, { problem: 'Token not found', retryAt: NOW + 50 * MIN })
  expect(servesPoll('tick', refused, NOW)).toBe(true)
  expect(servesPoll('tick', refused, NOW + 50 * MIN - 1)).toBe(true)
  expect(servesPoll('tick', refused, NOW + 50 * MIN)).toBe(false)
  expect(servesPoll('asked', refused, NOW)).toBe(false)
  expect(servesPoll('changed', refused, NOW)).toBe(false)
  // Fresh and refused: /modal still retries at once.
  expect(servesPoll('asked', entry({}, { problem: 'Token not found', retryAt: NOW + 60 * MIN }), NOW)).toBe(false)
  expect(servesPoll('tick', entry({}, { problem: 'Token not found', retryAt: NOW + 60 * MIN }), NOW)).toBe(true)
})

test('the shared cache, lock and project records are read defensively', () => {
  const shared = { cli: ['modal'], problem: null, apps: [], spendToday: null, spendNote: null, spendAskedAt: null, spendWaitMs: 300_000, billingUnsupportedAt: null, retryAt: null }
  expect(isCacheEntry({ ts: NOW, by: 'sess-b', intervalMs: MIN, data: shared })).toBe(true)
  expect(isCacheEntry({ ts: NOW, by: 'sess-b', intervalMs: MIN, data: { ...shared, retryAt: NOW + MIN } })).toBe(true)
  // A cache written before retryAt existed (modal-meter 0.2) still counts.
  expect(isCacheEntry({ ts: NOW, by: 'sess-b', intervalMs: MIN, data: { ...shared, retryAt: undefined } })).toBe(true)
  expect(isCacheEntry({ ts: NOW, by: 'sess-b', intervalMs: MIN, data: { ...shared, retryAt: 'soon' } })).toBe(false)
  expect(isCacheEntry({ ts: NOW, by: 'sess-b', intervalMs: MIN, data: { ...shared, apps: 'nope' } })).toBe(false)
  expect(isCacheEntry({ ts: 'yesterday', by: 'sess-b', intervalMs: MIN, data: shared })).toBe(false)
  expect(isCacheEntry(null)).toBe(false)
  expect(isLock({ ts: NOW, by: 'sess-b' })).toBe(true)
  expect(isLock({ ts: NOW })).toBe(false)
  expect(isLock('lock')).toBe(false)
  expect(isProjectRecord({ usesModal: true, checkedAt: NOW })).toBe(true)
  expect(isProjectRecord({ usesModal: 'yes', checkedAt: NOW })).toBe(false)
  expect(isProjectRecord(undefined)).toBe(false)
})
