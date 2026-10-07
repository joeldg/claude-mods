import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/Users/me/printproj'
const SCRATCH = '/private/tmp/claude-501/-Users-me/abc/scratchpad'
const TIGER = 'tiger-150-fullspectrum-grey-v3-snapmaker-only.3mf'
const TIGER_SRC = `artifacts/multiview-eval/figure-tiger/pshuman-figure/full-spectrum/${TIGER}`
const SNAPMAKER_SETTINGS = '{\n  "filament_settings_id": [\n    "Snapmaker PLA Full Spectrum @U1 0.4 nozzle"\n  ]\n}\n'
const BAMBU_SETTINGS = '{\n  "filament_settings_id": [\n    "Bambu PLA Basic @BBL P1S"\n  ]\n}\n'

type World = {
  /** Every Bash command the engine ran, as the plugin handed it on. */
  ran: string[]
  /** Every process the plugin ran, in order. */
  argv: string[][]
  /** What happened in order: processes, sleeps and Bash runs. */
  log: string[]
  toasts: string[]
  sleeps: number[]
  /** pgrep answers per process name, taken in order; the last one repeats. */
  running: Record<string, number[]>
  /** What `osascript` exits with. */
  quitExit: number
  /** `Metadata/project_settings.config` per 3MF path; a path not listed is not a zip there. */
  zips: Record<string, string>
  /** Paths `$.fs.exists` finds. */
  existing: Set<string>
}

const out = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Answers the host beneath the plugin: processes, the clock's waits, toasts, the cwd and Bash. */
const world = (on: On): World => {
  const w: World = {
    ran: [],
    argv: [],
    log: [],
    toasts: [],
    sleeps: [],
    running: {},
    quitExit: 0,
    zips: {},
    existing: new Set(),
  }
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    w.log.push(argv.join(' '))
    const [command, ...rest] = argv
    if (command === 'pgrep') {
      const queue = w.running[rest.at(-1) ?? ''] ?? [0]
      const count = (queue.length > 1 ? queue.shift() : queue[0]) ?? 0
      return out(Array.from({ length: count }, (_, i) => String(4000 + i)).join('\n'), count > 0 ? 0 : 1)
    }
    if (command === 'osascript') {
      return out('', w.quitExit)
    }
    if (command === 'unzip') {
      const text = w.zips[rest[1] ?? '']
      return text === undefined ? out('', 9) : out(text)
    }
    if (command === 'open') {
      return out('')
    }
    return out('', 127)
  })
  on('clock.sleep', (_$, e) => {
    w.sleeps.push(e.ms)
    w.log.push(`sleep ${e.ms}`)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: w.existing.has(e.path) }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.ran.push(e.command)
    w.log.push(`bash: ${e.command}`)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  return w
}

/** A slash command as the person types it. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const isKill = (argv: readonly string[]) =>
  argv.some(arg => /^(?:kill|pkill|killall)$|^-9$|^-KILL$|force/i.test(arg))

test('a full-spectrum file sent to Bambu opens in Snapmaker Orca instead', async ($, on) => {
  const w = world(on)
  const command = `S=${SCRATCH} && cp ${TIGER_SRC} "$S/${TIGER}" && open -a BambuStudio "$S/${TIGER}" && echo opened; sleep 20`

  const ran = await $.tool.call({ tool: 'Bash', command })

  expect(w.ran).toEqual([
    `S=${SCRATCH} && cp ${TIGER_SRC} "$S/${TIGER}" && open -b com.snapmaker.snapmaker-orca "$S/${TIGER}" && echo opened; sleep 20`,
  ])
  expect(w.toasts).toEqual([`Bambu can't open full-spectrum files: opened ${TIGER} in Snapmaker Orca instead`])
  const context = ran.context?.join('\n') ?? ''
  expect(context).toMatch(/full-spectrum \(Snapmaker U1\) file, which Bambu Studio cannot open/)
  expect(context).toMatch(/must always be opened in Snapmaker Orca/)
  // Named full-spectrum, so nothing is unzipped; Snapmaker Orca was not running, so nothing is quit.
  expect(w.argv).toEqual([['pgrep', '-x', 'Snapmaker_Orca']])
})

test('an ordinary 3MF opens in Bambu unchanged, with no note', async ($, on) => {
  const w = world(on)
  w.zips[`${CWD}/artifacts/m0/bambu-paint/cube-20mm.3mf`] = BAMBU_SETTINGS
  const command = 'open -a "Bambu Studio" artifacts/m0/bambu-paint/cube-20mm.3mf && sleep 5'

  const ran = await $.tool.call({ tool: 'Bash', command })

  expect(w.ran).toEqual([command])
  expect(w.toasts).toEqual([])
  expect(ran.context ?? []).toEqual([])
  expect(w.argv).toEqual([
    ['unzip', '-p', `${CWD}/artifacts/m0/bambu-paint/cube-20mm.3mf`, 'Metadata/project_settings.config'],
    ['pgrep', '-x', 'BambuStudio'],
  ])
})

test('commands without a slicer open pass straight through', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: 'git status --porcelain' })
  await $.tool.call({ tool: 'Bash', command: 'open -a Preview render.png' })
  expect(w.ran).toEqual(['git status --porcelain', 'open -a Preview render.png'])
  expect(w.argv).toEqual([])
})

test('a neutral name whose 3MF names a Full Spectrum profile is rerouted', async ($, on) => {
  const w = world(on)
  w.zips['/Users/me/prints/model-v2.3mf'] = SNAPMAKER_SETTINGS

  const ran = await $.tool.call({ tool: 'Bash', command: 'open -a /Applications/BambuStudio.app ~/prints/model-v2.3mf' })

  expect(w.argv[0]).toEqual(['unzip', '-p', '/Users/me/prints/model-v2.3mf', 'Metadata/project_settings.config'])
  expect(w.ran).toEqual(['open -b com.snapmaker.snapmaker-orca ~/prints/model-v2.3mf'])
  expect(w.toasts).toEqual(["Bambu can't open full-spectrum files: opened model-v2.3mf in Snapmaker Orca instead"])
  expect(ran.context?.join('\n')).toMatch(/model-v2\.3mf is a full-spectrum/)
})

test('a file copied earlier in the command is judged by its source', async ($, on) => {
  const w = world(on)
  w.zips[`${CWD}/out/coupon.3mf`] = SNAPMAKER_SETTINGS
  const command = `S=${SCRATCH} && cp out/coupon.3mf "$S/b.3mf" && open -a BambuStudio "$S/b.3mf"`

  await $.tool.call({ tool: 'Bash', command })

  expect(w.argv.slice(0, 2)).toEqual([
    ['unzip', '-p', `${SCRATCH}/b.3mf`, 'Metadata/project_settings.config'],
    ['unzip', '-p', `${CWD}/out/coupon.3mf`, 'Metadata/project_settings.config'],
  ])
  expect(w.ran).toEqual([`S=${SCRATCH} && cp out/coupon.3mf "$S/b.3mf" && open -b com.snapmaker.snapmaker-orca "$S/b.3mf"`])
})

test('checkContents off: only the name decides', { options: { checkContents: false } }, async ($, on) => {
  const w = world(on)
  w.zips['/Users/me/prints/model-v2.3mf'] = SNAPMAKER_SETTINGS
  await $.tool.call({ tool: 'Bash', command: 'open -a BambuStudio ~/prints/model-v2.3mf' })
  expect(w.ran).toEqual(['open -a BambuStudio ~/prints/model-v2.3mf'])
  expect(w.argv.some(argv => argv[0] === 'unzip')).toBe(false)
})

test('previous instances get a gentle quit before the open runs, never a kill', async ($, on) => {
  const w = world(on)
  w.zips[`${CWD}/cube-20mm.3mf`] = BAMBU_SETTINGS
  w.running.BambuStudio = [1, 0]

  const ran = await $.tool.call({ tool: 'Bash', command: 'open -a BambuStudio cube-20mm.3mf' })

  expect(w.log).toEqual([
    `unzip -p ${CWD}/cube-20mm.3mf Metadata/project_settings.config`,
    'pgrep -x BambuStudio',
    'osascript -e quit app id "com.bambulab.bambu-studio"',
    'sleep 1000',
    'pgrep -x BambuStudio',
    'bash: open -a BambuStudio cube-20mm.3mf',
  ])
  expect(w.argv.filter(argv => argv[0] === 'osascript')).toEqual([['osascript', '-e', 'quit app id "com.bambulab.bambu-studio"']])
  expect(w.argv.some(isKill)).toBe(false)
  expect(w.toasts).toEqual(['Closed 1 Bambu Studio window(s) before opening cube-20mm.3mf'])
  expect(ran.context ?? []).toEqual([])
})

test('several Snapmaker Orca instances are quit one by one', async ($, on) => {
  const w = world(on)
  w.running.Snapmaker_Orca = [3, 2, 1, 0]

  await $.tool.call({ tool: 'Bash', command: 'open -b com.snapmaker.snapmaker-orca artifacts/coupon/full-spectrum/cmyk-ratio-coupon.3mf' })

  expect(w.argv.filter(argv => argv[0] === 'osascript').length).toBe(3)
  expect(w.sleeps).toEqual([1000, 1000, 1000])
  expect(w.toasts).toEqual(['Closed 3 Snapmaker Orca window(s) before opening cmyk-ratio-coupon.3mf'])
  expect(w.ran).toEqual(['open -b com.snapmaker.snapmaker-orca artifacts/coupon/full-spectrum/cmyk-ratio-coupon.3mf'])
})

test('an instance that never quits: stops after the limit and tells the model', async ($, on) => {
  const w = world(on)
  w.running.Snapmaker_Orca = [1]

  const ran = await $.tool.call({ tool: 'Bash', command: 'open -a "Snapmaker Orca" figure2-tiger-u1.3mf' })

  expect(w.argv.filter(argv => argv[0] === 'osascript').length).toBe(5)
  expect(w.argv.some(isKill)).toBe(false)
  expect(w.toasts).toEqual([])
  expect(w.ran).toEqual(['open -a "Snapmaker Orca" figure2-tiger-u1.3mf'])
  expect(ran.context?.join('\n')).toMatch(/an instance of Snapmaker Orca is still open .*asking whether to save.*tell the user/)
})

test('a refused quit (save dialog cancelled) stops at once', async ($, on) => {
  const w = world(on)
  w.running.Snapmaker_Orca = [2]
  w.quitExit = 1

  const ran = await $.tool.call({ tool: 'Bash', command: 'open -a "Snapmaker Orca" figure2-tiger-u1.3mf' })

  expect(w.argv.filter(argv => argv[0] === 'osascript').length).toBe(1)
  expect(ran.context?.join('\n')).toMatch(/2 instances of Snapmaker Orca are still open/)
  expect(w.ran).toEqual(['open -a "Snapmaker Orca" figure2-tiger-u1.3mf'])
})

test('closePrevious off: nothing is quit', { options: { closePrevious: false } }, async ($, on) => {
  const w = world(on)
  w.running.BambuStudio = [2]
  w.running.Snapmaker_Orca = [2]

  await $.tool.call({ tool: 'Bash', command: `open -a BambuStudio ${TIGER}` })

  expect(w.ran).toEqual([`open -b com.snapmaker.snapmaker-orca ${TIGER}`])
  expect(w.argv).toEqual([])
  expect(w.sleeps).toEqual([])
})

test('/slice opens a full-spectrum file in Snapmaker Orca even when Bambu is asked for', async ($, on) => {
  const w = world(on)
  const path = `${CWD}/${TIGER_SRC}`
  w.existing.add(path)
  w.running.Snapmaker_Orca = [1, 0]

  const shown = await $.command.run(typed('slice', `${TIGER_SRC} bambu`))

  expect(w.argv.at(-1)).toEqual(['open', '-b', 'com.snapmaker.snapmaker-orca', path])
  expect(w.argv.filter(argv => argv[0] === 'osascript')).toEqual([['osascript', '-e', 'quit app id "com.snapmaker.snapmaker-orca"']])
  expect(shown.text).toBe(
    [
      `${TIGER} is a full-spectrum file, which Bambu Studio cannot open: using Snapmaker Orca.`,
      'Closed 1 previous Snapmaker Orca window(s).',
      `Opened ${path} in Snapmaker Orca.`,
    ].join('\n'),
  )
})

test('/slice opens other files in Bambu Studio, or where asked', async ($, on) => {
  const w = world(on)
  w.existing.add(`${CWD}/cube-20mm.3mf`)
  w.zips[`${CWD}/cube-20mm.3mf`] = BAMBU_SETTINGS

  const bambu = await $.command.run(typed('slice', 'cube-20mm.3mf'))
  expect(bambu.text).toBe(`Opened ${CWD}/cube-20mm.3mf in Bambu Studio.`)
  expect(w.argv.at(-1)).toEqual(['open', '-b', 'com.bambulab.bambu-studio', `${CWD}/cube-20mm.3mf`])

  await $.command.run(typed('slice', 'cube-20mm.3mf snapmaker'))
  expect(w.argv.at(-1)).toEqual(['open', '-b', 'com.snapmaker.snapmaker-orca', `${CWD}/cube-20mm.3mf`])

  const missing = await $.command.run(typed('slice', 'nope.3mf'))
  expect(missing.text).toBe(`slicer-handoff: no such file: ${CWD}/nope.3mf`)
  expect((await $.command.run(typed('slice', ''))).text).toMatch(/^Usage: \/slice <file>/)
})
