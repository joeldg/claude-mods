import { expect, mock, test } from 'claude-code/testing'
import type { On, RegisteredToolSpec } from 'claude-code'

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

/** The first user message's context as the engine computes it, before the plugins add theirs. */
const firstContext = { blocks: [{ name: 'currentDate', text: "Today's date is 2026-10-07." }] }

const SLOW = { timeoutMs: 30_000 }

type World = {
  ps: string
  /** While true, `ps` times out: the host aborts it and the call rejects. */
  psFails: boolean
  psRuns: string[][]
  log: string
  size: number
  toasts: string[]
  statuses: (string | undefined)[]
  logs: string[]
  opened: string[]
  tools: RegisteredToolSpec[]
  commands: string[]
}

/** Answers the host beneath the plugin: processes, files, toasts, status, panes and registrations. */
const world = (on: On, now: () => number): World => {
  const w: World = {
    ps: '',
    psFails: false,
    psRuns: [],
    log: '',
    size: 0,
    toasts: [],
    statuses: [],
    logs: [],
    opened: [],
    tools: [],
    commands: [],
  }
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [command] = e.argv
    if (command === 'ps') {
      w.psRuns.push([...e.argv])
      return w.psFails ? { deny: 'aborted: still running after 10000ms' } : out(w.ps)
    }
    return command === 'tail' ? out(w.log) : command === 'df' ? out(DF) : out('')
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: w.size, mtimeMs: now(), isLink: false } }))
  on('fs.exists', (_$, e) => ({ value: !e.path.includes('missing') }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__job-watch__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  return w
}

/** Starts the session: the commands and tools register and the poll timer starts. */
const start = async ($: any): Promise<void> => {
  await $.session.start({ cwd: '/home/dev/app', surface: 'terminal', isInteractive: true })
}

/** Calls one of the mod's tools as the model would, answering its text. */
const tool = async ($: any, name: string, input: Record<string, unknown> = {}): Promise<string> =>
  String((await $.tool.call({ tool: `mcp__job-watch__${name}`, ...input })).result)

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

test('a background Bash task is tracked to its finish', SLOW, async ($, on) => {
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

test('a quick background command leaves without a toast', SLOW, async ($, on) => {
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

test('a detached nohup launch is picked up from its redirect', SLOW, async ($, on) => {
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

test('/watch adds a log and the pane draws it on both surfaces', SLOW, async ($, on) => {
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

test('the three tools are registered at the start, in the tool list, and allowed without asking', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  await start($)

  expect(w.commands).toEqual(['jobs', 'watch', 'unwatch'])
  expect(w.tools.map(one => one.name)).toEqual(['jobs_list', 'jobs_watch', 'jobs_unwatch'])
  const [list, watch, unwatch] = w.tools
  for (const one of w.tools) {
    expect(one.isDeferred).toBe(false)
  }
  expect(list?.description).toMatch(/instead of writing .*sleep.* loops or running .ps./)
  expect(list?.description).toMatch(/picked up automatically/)
  expect(list?.inputSchema).toEqual({ type: 'object', properties: {} })
  expect(Object.keys((watch?.inputSchema as { properties: object }).properties)).toEqual([
    'pid',
    'log',
    'name',
    'quietMinutes',
  ])
  expect(watch?.description).toMatch(/picked up automatically/)
  expect(watch?.description).toMatch(/does not start commands/)
  expect(unwatch?.inputSchema).toMatchObject({ required: ['name'] })

  // They only read the mod's own state: never a question for the person, though a deny in settings stands.
  for (const name of ['jobs_list', 'jobs_watch', 'jobs_unwatch']) {
    expect(await $.tool.check({ tool: `mcp__job-watch__${name}`, input: {} })).toMatchObject({ decision: 'allow' })
  }
  expect((await $.tool.check({ tool: 'mcp__other__jobs_list', input: {} })).decision).toBe('ask')
})

test('jobs_list reports each job, and with none says how jobs get watched', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, clock.now)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: 'Command running in background with ID: b1. Output is being written to: /tmp/s/tasks/b1.output. You will be notified when it completes.',
  }))
  await start($)

  const empty = await tool($, 'jobs_list')
  expect(empty).toMatch(/^No jobs are being watched\./)
  expect(empty).toMatch(/run_in_background/)
  expect(empty).toMatch(/jobs_watch/)

  w.ps = ' 4242 /bin/zsh -c .venv/bin/python -m myproject.train --epochs 3\n'
  const step = () => Math.min(100, Math.floor((clock.now() - 1_000_000) / 1000))
  let hasExited = false
  Object.defineProperty(w, 'log', {
    get: () => (hasExited ? 'step 100/100 loss 0.1\n\n[exited with code 0]\n' : `step ${step()}/100 loss 0.5\n`),
  })
  Object.defineProperty(w, 'size', { get: () => (hasExited ? 1000 : step()) })
  await $.tool.call({
    tool: 'Bash',
    command: '.venv/bin/python -m myproject.train --epochs 3',
    run_in_background: true,
    description: 'train coarse model',
  })
  await clock.advance(10_000)

  let listed = await tool($, 'jobs_list')
  expect(listed).toMatch(
    /^train coarse model \[b1\]: running · 10% \(10\/100\) · last output 0s ago\n  log \/tmp\/s\/tasks\/b1\.output\n  › step 10\/100 loss 0\.5\n/,
  )
  expect(listed).toMatch(/jobs_unwatch/)
  expect(w.psRuns.at(-1)).toEqual(['ps', '-axo', 'pid=,command='])

  await clock.advance(60_000)
  listed = await tool($, 'jobs_list')
  expect(listed).toMatch(/^train coarse model \[b1\]: running · 70% \(70\/100\) · ETA 30s · last output 0s ago\n/)

  // The task runner ends the output file with the exit code; ps no longer shows the job.
  hasExited = true
  w.ps = ''
  await clock.advance(10_000)
  listed = await tool($, 'jobs_list')
  expect(listed).toMatch(
    /^train coarse model \[b1\]: finished \d+s ago \(exit 0\) · 100% \(100\/100\) · last output \d+s ago\n  log \/tmp\/s\/tasks\/b1\.output\n  › step 100\/100 loss 0\.1\n/,
  )
  expect(w.toasts.at(-1)).toBe('train coarse model finished after 80s: step 100/100 loss 0.1')
})

test('a background task with no process to match still finishes on its exit marker', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b3' },
    text: 'Command running in background with ID: b3. Output is being written to: /tmp/s/tasks/b3.output.',
  }))
  w.log = 'fetching…\n'
  w.size = 9
  // A pipeline led by `cat` gives `ps` nothing to match: the job is judged by its output file alone.
  await $.tool.call({
    tool: 'Bash',
    command: 'cat urls.txt | xargs -n1 curl -sO',
    run_in_background: true,
    description: 'download assets',
  })
  await clock.advance(70_000)
  expect(await tool($, 'jobs_list')).toMatch(
    /^download assets \[b3\]: running · last output \d+s ago\n  log \/tmp\/s\/tasks\/b3\.output\n  › fetching…\n/,
  )
  expect(w.psRuns).toEqual([])

  w.log = 'fetching…\nfetched 12 files\n[exited with code 2]\n'
  w.size = 40
  await clock.advance(10_000)
  expect(await tool($, 'jobs_list')).toMatch(
    /^download assets \[b3\]: finished \d+s ago \(exit 2\) · last output \d+s ago\n/,
  )
  expect(w.toasts.at(-1)).toBe('download assets finished after 80s: fetched 12 files')
})

test('jobs_watch adds a pid, a log or both, checks its input, and the job shows in jobs_list', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  mock.env(on, { HOME: '/home/dev' })
  on('session.cwd', () => ({ value: '/home/dev/app' }))
  await start($)

  expect(await tool($, 'jobs_watch')).toBe('job-watch: jobs_watch needs a pid, a log path, or both.')
  expect(await tool($, 'jobs_watch', { pid: 'four' })).toBe('job-watch: pid must be a positive integer.')
  expect(await tool($, 'jobs_watch', { pid: 4242, quietMinutes: 0 })).toBe('job-watch: quietMinutes must be a positive number.')
  expect(await tool($, 'jobs_watch', { command: 'python train.py' })).toMatch(
    /^job-watch: jobs_watch does not start commands\. Run it with Bash \(run_in_background: true, or `nohup … > log 2>&1 &`\): it is watched automatically/,
  )
  expect(await tool($, 'jobs_watch', { log: '~/missing.log' })).toBe('job-watch: /home/dev/missing.log does not exist.')
  expect(await tool($, 'jobs_list')).toMatch(/^No jobs/)

  w.ps = ' 4242 python train.py\n  777 ffmpeg -i in.mov out.mp4\n'
  w.log = ' 50%|█████     | 5/10 [00:10<00:10,  0.50it/s]\n'
  w.size = 50
  const both = await tool($, 'jobs_watch', { pid: 4242, log: 'train.log', name: 'training run', quietMinutes: 1 })
  expect(both).toMatch(
    /^Watching training run \[[a-z0-9]+\]: pid 4242, log \/home\/dev\/app\/train\.log\. Call jobs_list to check on it: it counts as stalled after 60s without output and as finished when the process exits\.$/,
  )
  // The tool never opens the pane itself; a long job opens it later, as any other does.
  expect(w.opened).toEqual([])
  expect(w.psRuns.at(-1)).toEqual(['ps', '-o', 'pid=', '-p', '4242'])

  const alone = await tool($, 'jobs_watch', { pid: 777 })
  expect(alone).toBe(
    'Watching pid 777 [pid-777]: pid 777. Call jobs_list to check on it: it counts as finished when the process exits.',
  )
  expect(w.psRuns.at(-1)).toEqual(['ps', '-o', 'pid=', '-p', '4242,777'])

  let listed = await tool($, 'jobs_list')
  expect(listed).toMatch(/^pid 777 \[pid-777\]: running · pid 777 · no log \(added 0s ago\)$/m)
  expect(listed).toMatch(
    /^training run \[[a-z0-9]+\]: running · pid 4242 · 50% \(5\/10\) · ETA 10s · last output 0s ago\n  log \/home\/dev\/app\/train\.log\n  › 50%\|/m,
  )
  // The pane shows the same jobs.
  const texts = await paneTexts($)
  expect(texts).toContain('training run')
  expect(texts).toContain('pid 777')

  // A minute without output with the process alive: stalled, by the job's own quietMinutes.
  await clock.advance(70_000)
  listed = await tool($, 'jobs_list')
  expect(listed).toMatch(/^training run \[[a-z0-9]+\]: stalled \(no output for 60s\) · pid 4242 · 50% \(5\/10\) · ETA due · last output 70s ago$/m)
  expect(listed).toMatch(/^pid 777 \[pid-777\]: running · pid 777/m)
  expect(w.toasts).toEqual(['training run has written nothing for 60s'])

  // The process is gone: finished, with no exit code to report.
  w.ps = '  777 ffmpeg -i in.mov out.mp4\n'
  await clock.advance(10_000)
  listed = await tool($, 'jobs_list')
  expect(listed).toMatch(/^training run \[[a-z0-9]+\]: finished \d+s ago · pid 4242 · 50% \(5\/10\) · last output 80s ago$/m)
  expect(w.toasts.at(-1)).toMatch(/^training run finished after 80s: 50%\|/)
})

test('/watch and jobs_watch register the same job: the second replaces the first', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  mock.env(on, { HOME: '/home/dev' })
  on('session.cwd', () => ({ value: '/home/dev/app' }))
  await start($)
  w.log = 'step 1/4\n'
  w.size = 9

  expect((await $.command.run(typed('watch', 'run.log'))).text).toBe('Watching /home/dev/app/run.log')
  await tool($, 'jobs_watch', { log: 'run.log', name: 'the run' })
  const listed = await tool($, 'jobs_list')
  expect(listed.match(/\/home\/dev\/app\/run\.log/g)).toHaveLength(1)
  expect(listed).toMatch(/^the run \[[a-z0-9]+\]: running · 25% \(1\/4\)/)
  expect(w.opened).toEqual(['job-watch'])
})

test('jobs_unwatch removes a job by name or id, and says what it did', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  await start($)
  w.ps = '   11 sleep 1000\n   22 sleep 1000\n'
  expect(await tool($, 'jobs_watch', { pid: 11, name: 'first' })).toMatch(/^Watching first \[pid-11\]/)
  expect(await tool($, 'jobs_watch', { pid: 22, name: 'second' })).toMatch(/^Watching second \[pid-22\]/)

  expect(await tool($, 'jobs_unwatch')).toBe(
    'job-watch: jobs_unwatch needs the name or id of a job as jobs_list prints it, or done, or all.',
  )
  expect(await tool($, 'jobs_unwatch', { name: 'third' })).toBe(
    'job-watch: no job named third. Watched: first [pid-11], second [pid-22].',
  )
  expect(await tool($, 'jobs_unwatch', { name: 'first' })).toBe('Removed 1 job(s).')
  expect(/first/.test(await tool($, 'jobs_list'))).toBe(false)
  expect(await tool($, 'jobs_unwatch', { name: 'pid-22' })).toBe('Removed 1 job(s).')
  expect(await tool($, 'jobs_list')).toMatch(/^No jobs/)
  expect(await tool($, 'jobs_unwatch', { name: 'all' })).toBe('Removed 0 job(s).')
})

test('the first message says jobs are watched and names the tools, once', SLOW, async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on, () => 0)

  const out = await $.prompt.context(firstContext)
  expect(out.blocks.map(block => block.name)).toEqual(['currentDate', 'jobWatch'])
  const text = out.blocks[1]?.text ?? ''
  expect(text.split('\n').length <= 3).toBe(true)
  expect(text).toMatch(/picked up automatically/)
  expect(text).toMatch(/mcp__job-watch__jobs_list/)
  expect(text).toMatch(/mcp__job-watch__jobs_watch/)
  expect(text).toMatch(/mcp__job-watch__jobs_unwatch/)
  expect(text).toMatch(/sleep/)

  // The re-read after a compaction carries the block once, not twice.
  const again = await $.prompt.context({ blocks: out.blocks })
  expect(again.blocks.filter(block => block.name === 'jobWatch')).toHaveLength(1)
  expect(again.blocks[0]).toEqual(firstContext.blocks[0])
})

test('a ps probe that times out backs off, doubling up to a cap, and a fast one restores the pace', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on, clock.now)
  await start($)
  w.ps = ' 4242 python train.py\n'
  await tool($, 'jobs_watch', { pid: 4242, name: 'train' })

  w.psRuns.length = 0
  await clock.advance(60_000)
  expect(w.psRuns).toHaveLength(6)

  // Each timeout doubles the interval: 20s, 40s, 80s, 160s, then the 5 min cap.
  w.psFails = true
  w.psRuns.length = 0
  await clock.advance(600_000)
  expect(w.psRuns).toHaveLength(5)
  expect(w.logs.filter(line => line.startsWith('job-watch: ps'))).toEqual([
    'job-watch: ps timed out: probing every 20s',
    'job-watch: ps timed out: probing every 40s',
    'job-watch: ps timed out: probing every 80s',
    'job-watch: ps timed out: probing every 3m',
    'job-watch: ps timed out: probing every 5m',
  ])
  // With ps unanswered the job is judged by its log alone, so it is not pronounced finished.
  expect(await tool($, 'jobs_list')).toMatch(/^train \[pid-4242\]: running · pid 4242/)

  // That jobs_list was the 30th tick since the last probe and probed again (still failing), so the next
  // probe is due 5 min on: fast, it restores the pace, and ps runs every tick again.
  w.psFails = false
  w.psRuns.length = 0
  await clock.advance(300_000)
  expect(w.psRuns).toHaveLength(1)
  expect(w.logs.at(-1)).toBe('job-watch: ps is fast again: probing every 10s')
  await clock.advance(60_000)
  expect(w.psRuns).toHaveLength(7)
  expect(w.logs.filter(line => line.startsWith('job-watch: ps'))).toEqual([
    'job-watch: ps timed out: probing every 20s',
    'job-watch: ps timed out: probing every 40s',
    'job-watch: ps timed out: probing every 80s',
    'job-watch: ps timed out: probing every 3m',
    'job-watch: ps timed out: probing every 5m',
    'job-watch: ps is fast again: probing every 10s',
  ])
})
