import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE_PROPS = {
  title: 'Jobs',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const DF = [
  'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on',
  '/dev/disk3s1s1 971350180 12341084 157639564 8% 458732 1576395640 0% /',
].join('\n')

type World = {
  ps: string
  log: string
  size: number
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
}

/** Answers the host beneath the plugin: processes, files, toasts, status and panes. */
const world = (on: On, now: () => number): World => {
  const w: World = { ps: '', log: '', size: 0, toasts: [], statuses: [], opened: [] }
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [command] = e.argv
    return command === 'ps' ? out(w.ps) : command === 'tail' ? out(w.log) : command === 'df' ? out(DF) : out('')
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: w.size, mtimeMs: now(), isLink: false } }))
  on('fs.exists', () => ({ value: true }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return w
}

/** Every Text the Jobs pane draws on the terminal, one string per element. */
const paneTexts = async ($: any): Promise<string[]> => {
  const ui = await $.ui.mount({
    plugin: 'job-watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'job-watch',
    props: PANE_PROPS,
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((found: { text: string }) => found.text)
  await ui.unmount()
  return texts
}

test('a background Bash task is tracked to its finish', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock.now)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: 'Command running in background with ID: b1. Output is being written to: /tmp/s/tasks/b1.output. You will be notified when it completes.',
  }))

  w.ps = '/bin/zsh -c .venv/bin/python -m myproject.train --epochs 3\n'
  // One step a second from the launch, out of 100.
  const step = () => Math.min(100, Math.floor((clock.now() - 1_000_000) / 1000))
  Object.defineProperty(w, 'log', { get: () => `step ${step()}/100 loss 0.5\n` })
  Object.defineProperty(w, 'size', { get: () => step() })
  await $.tool.call({
    tool: 'Bash',
    command: '.venv/bin/python -m myproject.train --epochs 3',
    run_in_background: true,
    description: 'train coarse model',
  })
  await clock.advance(10_000)

  expect(w.statuses.at(-1)).toBe('jobs: 1 running')
  let texts = await paneTexts($)
  expect(texts).toContain('train coarse model')
  expect(texts).toContain('running')
  expect(texts.some(text => /10%\s+10\/100/.test(text))).toBe(true)

  await clock.advance(60_000)
  texts = await paneTexts($)
  expect(texts.some(text => /70%\s+70\/100\s+ETA 30s/.test(text))).toBe(true)
  expect(w.opened).toEqual(['job-watch'])

  w.ps = ''
  await clock.advance(10_000)
  expect(await paneTexts($)).toContain('done')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts.at(-1)).toMatch(/^train coarse model finished after .*step 80\/100/)
})

test('a quick background command leaves without a toast', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2' },
    text: 'Command running in background with ID: b2. Output is being written to: /tmp/s/tasks/b2.output.',
  }))
  w.ps = 'pytest tests/test_x.py\n'
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/test_x.py', run_in_background: true, description: 'run tests' })
  await clock.advance(10_000)
  w.ps = ''
  await clock.advance(10_000)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(await paneTexts($)).not.toContain('run tests')
  expect(w.toasts).toEqual([])
})

test('a detached nohup launch is picked up from its redirect', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: '/Users/me/Projects/SF' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  w.ps = '/bin/bash ./scripts/run.sh\n'
  w.log = 'extracting 3 of 12 shards\n'
  w.size = 10

  await $.tool.call({
    tool: 'Bash',
    command: 'cd /Volumes/NAS/data && nohup ./scripts/run.sh >> extract.log 2>&1 < /dev/null & disown; sleep 2',
    description: 'start extraction',
  })
  await clock.advance(10_000)
  const texts = await paneTexts($)
  expect(texts).toContain('start extraction')
  expect(texts.some(text => /25%\s+3\/12/.test(text))).toBe(true)
  expect(w.statuses.at(-1)).toBe('jobs: 1 running')
})

test('/watch adds a log and the pane draws it on both surfaces', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: '/Users/me' }))
  w.log = ' 50%|█████     | 5/10 [00:10<00:10,  0.50it/s]\n'
  w.size = 50

  const ran = await $.command.run(typed('watch', '~/train.log training run'))
  expect(ran.text).toBe('Watching /Users/me/train.log')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'job-watch',
      surface,
      component: 'Pane',
      requestId: 'job-watch',
      props: PANE_PROPS,
    })
    expect((await ui.find({ type: 'Text', text: 'training run' }))?.text).toBe('training run')
    expect(await ui.find({ type: 'Text', text: /50%.*ETA 10s/ })).toBeDefined()
    await ui.unmount()
  }

  await $.command.run(typed('unwatch', 'all'))
  expect(await paneTexts($)).not.toContain('training run')
})
