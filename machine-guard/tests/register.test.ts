import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HEAVY = '.venv/bin/python -m experiments.coarse_model.train --epochs 3'
const LIGHT = 'git status --porcelain'
const RESERVATION = '/Users/me/.claude/machine-guard.json'

type World = {
  level: number
  freePct: number
  files: Map<string, string>
  toasts: string[]
  statuses: (string | undefined)[]
  ran: string[]
}

/** Answers the host beneath the plugin: macOS probes, files, toasts and the status line. */
const world = (on: On): World => {
  const w: World = { level: 1, freePct: 40, files: new Map(), toasts: [], statuses: [], ran: [] }
  mock.env(on, { HOME: '/Users/me' })
  on('process.run', (_$, e) => {
    const outputs: Record<string, string> = {
      sysctl: `${w.level}\ntotal = 8192.00M  used = 7987.20M  free = 204.80M  (encrypted)\n`,
      memory_pressure: `System-wide memory free percentage: ${w.freePct}%\n`,
      ps: ' 32505856 /Users/me/.venv/bin/python3.12\n 9437184 /Applications/Claude.app/Contents/MacOS/Claude\n',
      ioreg: '"Device Utilization %"=91',
    }
    const stdout = outputs[e.argv[0] ?? ''] ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  return w
}

type Outcome = { deny?: string; isError?: boolean; text?: string }

/** Whether the call was refused, and why: a deny, or the errored result a deny becomes. */
const refusal = (outcome: Outcome): string | undefined =>
  outcome.deny ?? (outcome.isError === true ? outcome.text : undefined)

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

test('refuses a heavy job while memory is critical and lets light commands through', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.level = 4

  const refused = refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))
  expect(refused).toMatch(/memory pressure is critical .*biggest: python 31 GB, Claude 9 GB/)
  expect(refused).toMatch(/\/guard pause 15m/)
  expect(w.toasts).toContain('machine-guard blocked a heavy job: memory is critical')

  await $.tool.call({ tool: 'Bash', command: LIGHT })
  expect(w.ran).toEqual([LIGHT])
  expect(w.statuses.at(-1)).toBe('RAM CRITICAL 40% free · swap 7.8/8G · top python 31G · GPU 91%')
})

test('warns the model when memory is tight but runs the job', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.level = 2

  const ran = await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
  expect(ran.context?.join('\n')).toMatch(/memory is tight .*one at a time/)
})

test('/busy blocks heavy jobs until /busy off, whatever the memory', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)

  const reserved = await $.command.run(typed('busy', '2h training a vision model'))
  expect(reserved.text).toMatch(/^Reserved this Mac for "training a vision model" for 2h00m/)
  expect(JSON.parse(w.files.get(RESERVATION) ?? '{}')).toEqual({
    reason: 'training a vision model',
    until: 1_000_000 + 7_200_000,
    setAt: 1_000_000,
  })

  const refused = refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))
  expect(refused).toMatch(/reserved this Mac for "training a vision model" for 2h00m more/)
  expect(refused).toMatch(/\/busy off/)
  expect(w.ran).toEqual([])

  await $.command.run(typed('busy', 'off'))
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
})

test('a reservation written by another session is honoured, and runs out', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.files.set(RESERVATION, JSON.stringify({ reason: 'overnight training', until: 600_000, setAt: 0 }))

  expect(refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))).toBeDefined()
  await clock.advance(600_001)
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])
})

test('/guard pause lets a heavy job through until it runs out', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  w.level = 4

  const paused = await $.command.run(typed('guard', 'pause 15m'))
  expect(paused.text).toBe('Guard paused for 15m in this session.')
  await $.tool.call({ tool: 'Bash', command: HEAVY })
  expect(w.ran).toEqual([HEAVY])

  await clock.advance(16 * 60_000)
  expect(refusal(await $.tool.call({ tool: 'Bash', command: HEAVY }))).toBeDefined()
})

test('/guard reports what it sees', async ($, on) => {
  mock.clock(on, { now: 0 })
  const w = world(on)
  w.level = 2
  w.freePct = 12
  const shown = await $.command.run(typed('guard', ''))
  expect(shown.text).toBe(
    [
      'Memory pressure: warn (12% free)',
      'Swap: 7.8 of 8 GB',
      'GPU: 91%',
      'Biggest: python 31 GB, Claude 9 GB',
      'Not reserved (/busy [2h] [reason] reserves it)',
      'Guard on (/guard pause 15m pauses it)',
    ].join('\n'),
  )
})
