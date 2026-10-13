import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import {
  agoText,
  coresContext,
  coresToast,
  criticalDenial,
  isHeavy,
  isParked,
  memoryOf,
  parseCores,
  parseDuration,
  parseGpu,
  parseLock,
  parseReservation,
  parseShared,
  parseSysctl,
  parseTopApps,
  parseVmStat,
  pressureOf,
  statusLine,
  statusReport,
  warnContext,
} from '../hooks/probe'

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                     7782.',
  'Pages active:                                1031321.',
  'Pages inactive:                              1030683.',
  'Pages speculative:                             13680.',
  'Pages throttled:                                   0.',
  'Pages wired down:                             550553.',
  'Pages purgeable:                                4521.',
  '"Translation faults":                     7615592958.',
  'Pages copy-on-write:                       550186868.',
  'Pages zero filled:                        6021362992.',
  'Pages reactivated:                         662331369.',
  'Pages purged:                              125992384.',
  'File-backed pages:                            837777.',
  'Anonymous pages:                             1237907.',
  'Pages stored in compressor:                  1849732.',
  'Pages occupied by compressor:                 451287.',
  'Decompressions:                            829029468.',
  'Compressions:                             1029568781.',
  'Pageins:                                   248712974.',
  'Pageouts:                                    1048034.',
  'Swapins:                                    21611010.',
  'Swapouts:                                   49549913.',
  '',
].join('\n')

const SNAPSHOT: Snapshot = {
  at: 1_000_000,
  pressure: 'normal',
  level: 1,
  freePct: 33,
  unusedGB: 16.1,
  totalGB: 48,
  compressorGB: 6.9,
  compressedGB: 28.2,
  swapUsedGB: 9.2,
  swapTotalGB: 10,
  gpuPct: 16,
  gpuAt: 1_000_000,
  cpuTotal: 16,
  cpuRecommended: 16,
  cpuMask: 65535,
  cpuParkedSince: null,
  top: [
    { name: 'python', gb: 31 },
    { name: 'Claude', gb: 9 },
  ],
  topAt: 970_000,
  topTriedAt: 970_000,
}

const CADENCE = { sampleMs: 15_000, intervalMs: 15_000, blockOnCritical: true }

test('reads the memory size, swap and pressure level from one sysctl call, whatever the order', () => {
  expect(parseSysctl('51539607552\ntotal = 10240.00M  used = 9425.50M  free = 814.50M  (encrypted)\n1\n')).toEqual({
    level: 1,
    totalGB: 48,
    swapUsedGB: 9.2,
    swapTotalGB: 10,
  })
  expect(parseSysctl('2\ntotal = 8192.00M  used = 7282.25M  free = 909.75M  (encrypted)\n')).toEqual({
    level: 2,
    totalGB: null,
    swapUsedGB: 7.1,
    swapTotalGB: 8,
  })
  expect(parseSysctl('')).toEqual({ level: null, totalGB: null, swapUsedGB: 0, swapTotalGB: 0 })
})

test('reads the page counts from vm_stat and turns them into unused memory and the compressor', () => {
  const vm = parseVmStat(VM_STAT)
  expect(vm).toEqual({
    pageSize: 16384,
    free: 7782,
    inactive: 1030683,
    speculative: 13680,
    compressorPages: 451287,
    compressedPages: 1849732,
  })
  // free + inactive + speculative pages are what a new job can take without swapping anyone out.
  expect(memoryOf(vm, 48)).toEqual({ freePct: 33, unusedGB: 16.1, compressorGB: 6.9, compressedGB: 28.2 })
  expect(memoryOf(vm, null)).toEqual({ freePct: null, unusedGB: 16.1, compressorGB: 6.9, compressedGB: 28.2 })
  expect(memoryOf(null, 48)).toEqual({ freePct: null, unusedGB: null, compressorGB: null, compressedGB: null })
  expect(parseVmStat('nothing')).toBeNull()
})

test('reads GPU use', () => {
  expect(parseGpu('"PerformanceStatistics" = {"Tiler Utilization %"=14,"Renderer Utilization %"=29,"Device Utilization %"=29}')).toBe(29)
  expect(parseGpu('nothing')).toBeNull()
})

test('sums memory per app, helpers included', () => {
  const ps = [
    ' 1307152 /Applications/Microsoft Edge.app/Contents/Frameworks/Microsoft Edge Helper (Renderer).app/Contents/MacOS/Microsoft Edge Helper (Renderer)',
    '  741152 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ' 3145728 /Users/me/app/.venv/bin/python3.12',
    '  796560 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
    '   21104 /sbin/launchd',
  ].join('\n')
  expect(parseTopApps(ps)).toEqual([
    { name: 'python', gb: 3 },
    { name: 'Microsoft Edge', gb: 2 },
    { name: 'Claude', gb: 0.8 },
  ])
})

test('raises the pressure when free memory and swap say worse', () => {
  expect(pressureOf(1, 40, 2, 8)).toBe('normal')
  expect(pressureOf(2, 37, 7.1, 8)).toBe('warn')
  expect(pressureOf(1, 15, 2, 8)).toBe('warn')
  expect(pressureOf(4, 30, 2, 8)).toBe('critical')
  expect(pressureOf(2, 6, 7.9, 8)).toBe('critical')
})

test('reads the shared sample and the lock, and treats anything malformed as absent', () => {
  const shared = { ts: 999_000, by: 'sess-b', ttlMs: 15_000, probeMs: 120, n: 7, data: SNAPSHOT }
  expect(parseShared(JSON.stringify(shared))).toEqual(shared)
  // An older session's record without the newer fields still counts.
  const older = {
    ts: 999_000,
    by: 'sess-b',
    ttlMs: 15_000,
    data: { ...SNAPSHOT, gpuAt: undefined, topAt: undefined, topTriedAt: undefined, cpuTotal: undefined, cpuRecommended: undefined, cpuMask: undefined, cpuParkedSince: undefined },
  }
  expect(parseShared(JSON.stringify(older))).toEqual({
    ...shared,
    probeMs: 0,
    n: 0,
    data: { ...SNAPSHOT, gpuAt: null, topAt: null, topTriedAt: null, cpuTotal: null, cpuRecommended: null, cpuMask: null, cpuParkedSince: null },
  })
  expect(parseShared('{"ts":5}')).toBeNull()
  expect(parseShared('not json')).toBeNull()
  expect(parseShared(null)).toBeNull()
  expect(parseLock('{"ts":5,"by":"sess-b"}')).toEqual({ ts: 5, by: 'sess-b' })
  expect(parseLock('{}')).toBeNull()
  expect(parseLock(null)).toBeNull()
})

test('treats training, extraction, rendering and Docker as heavy', () => {
  const heavy = [
    '.venv/bin/python -m experiments.coarse_model.train --epochs 3',
    'cd /x && nohup nice -n 15 .venv/bin/python scripts/extract_omni.py a b >> $O/extract.log 2>&1 < /dev/null & disown',
    'PYTHONPATH=$PWD/src nohup /x/.venv/bin/python -W ignore -m myproject.datasets.mesh_build --out d',
    'python3 tools/render_turntable.py --views 8',
    'blender -b scene.blend -P bake.py',
    'docker compose up -d',
    'ffmpeg -i in.mp4 -vf scale=640:-1 out.mp4',
  ]
  for (const command of heavy) {
    expect([command, isHeavy(command)]).toEqual([command, true])
  }
})

test('leaves remote runs, tests and everyday commands alone', () => {
  const light = [
    'modal run app.py::train',
    '.venv/bin/python -m pytest tests/test_training.py -q',
    'git log --oneline -5 && gh run view 123',
    'python3 -c "import torch; print(torch.__version__)"',
    'ssh gpu-box python train.py',
    'pip install torch',
    'rg -n train src/',
    "sed -i '' -e 's|old\\.sh|overnight_train.sh|g' README.md",
    'cat logs/train.log | tail -5',
    'echo python train.py >> notes.md',
    "cd /x && python3 - <<'EOF'\nprint('overnight_train.sh')\nEOF",
  ]
  for (const command of light) {
    expect([command, isHeavy(command)]).toEqual([command, false])
  }
})

test('adds the user’s own heavy pattern', () => {
  expect(isHeavy('nohup ./scripts/nightly_run.sh >> run.log 2>&1 &')).toBe(false)
  expect(isHeavy('nohup ./scripts/nightly_run.sh >> run.log 2>&1 &', /nightly_run\.sh/)).toBe(true)
})

test('parses durations and reservations', () => {
  expect(parseDuration('15m')).toBe(900_000)
  expect(parseDuration('1.5h')).toBe(5_400_000)
  expect(parseDuration('training')).toBeNull()
  expect(parseReservation('{"reason":"training","until":5000,"setAt":0}', 1000)).toEqual({
    reason: 'training',
    until: 5000,
    setAt: 0,
  })
  expect(parseReservation('{"reason":"training","until":5000}', 6000)).toBeNull()
  expect(parseReservation('{}', 0)).toBeNull()
  expect(parseReservation('not json', 0)).toBeNull()
})

test('writes a compact status line', () => {
  const snapshot: Snapshot = { ...SNAPSHOT, pressure: 'warn', freePct: 12, swapUsedGB: 7.9, swapTotalGB: 8, gpuPct: 87, top: [{ name: 'python', gb: 31 }] }
  expect(statusLine(snapshot, null, 0)).toBe('RAM tight 12% free · swap 7.9/8G · top python 31G · GPU 87%')
  expect(statusLine({ ...snapshot, pressure: 'normal', freePct: 40 }, { reason: 'training', until: 8_200_000, setAt: 0 }, 0)).toBe(
    'RAM 40% free · swap 7.9/8G · GPU 87% · reserved 2h00m: training',
  )
  // No process table yet: the line does without the biggest app.
  expect(statusLine({ ...snapshot, top: [], gpuPct: null }, null, 0)).toBe('RAM tight 12% free · swap 7.9/8G')
})

test('says how long ago', () => {
  expect(agoText(0)).toBe('just now')
  expect(agoText(900)).toBe('just now')
  expect(agoText(12_000)).toBe('12 s ago')
  expect(agoText(300_000)).toBe('5m ago')
})

test('reports the sample, the verdict and the rules for the model', () => {
  expect(statusReport(SNAPSHOT, null, 0, 1_012_000, CADENCE)).toBe(
    [
      'machine-guard · sampled 12 s ago · every 15 s, one sample shared by all sessions',
      'RAM: 33% free · 16.1 of 48 GB unused (free + inactive + speculative pages) · compressor holds 28.2 GB in 6.9 GB',
      'Swap: 9.2 of 10 GB used',
      'GPU: 16% (read 12 s ago)',
      'CPU cores: 16 of 16 available.',
      'Pressure: normal (kernel level 1)',
      'Biggest apps (ps 42 s ago): python 31 GB, Claude 9 GB',
      'Verdict: ok — heavy local jobs may start.',
      'Rules: blocked when memory is critical (kernel level 4, or under 10% free with swap 95% full) or while /busy reserves the Mac; when memory is tight (under 20% free, or kernel level 2) the job runs with a note to run one at a time.',
    ].join('\n'),
  )
  // Just sampled, backed off, tight, and the table taken this moment.
  const tight: Snapshot = { ...SNAPSHOT, pressure: 'warn', level: 2, freePct: 18, topAt: 1_000_000, topTriedAt: 1_000_000 }
  const backedOff = statusReport(tight, null, 0, 1_000_000, { ...CADENCE, intervalMs: 60_000 }).split('\n')
  expect(backedOff[0]).toBe('machine-guard · sampled just now · every 60 s (backed off: probes were slow), one sample shared by all sessions')
  expect(backedOff[3]).toBe('GPU: 16%')
  expect(backedOff[5]).toBe('Pressure: warn (kernel level 2)')
  expect(backedOff[6]).toBe('Biggest apps (ps just now): python 31 GB, Claude 9 GB')
  expect(backedOff[7]).toBe('Verdict: ok — memory is tight: run one heavy job at a time.')
  // Critical, blocked; or critical with blocking off; or the guard paused.
  const critical: Snapshot = { ...SNAPSHOT, pressure: 'critical', level: 4, freePct: 6 }
  expect(statusReport(critical, null, 0, 1_000_000, CADENCE).split('\n')[7]).toBe(
    'Verdict: busy — memory is critical: heavy local jobs are blocked (the user can lift this with /guard pause 15m).',
  )
  expect(statusReport(critical, null, 0, 1_000_000, { ...CADENCE, blockOnCritical: false }).split('\n')[7]).toBe(
    'Verdict: ok — memory is critical but blocking is off: start nothing heavy unless the user asks for it.',
  )
  expect(statusReport(critical, null, 900_000, 1_000_000, CADENCE).split('\n')[7]).toBe(
    'Verdict: ok — the guard is paused for 15m in this session: heavy jobs run even while memory is critical.',
  )
  // Reserved with /busy.
  expect(statusReport(SNAPSHOT, { reason: 'training', until: 8_200_000, setAt: 1_000_000 }, 0, 1_000_000, CADENCE).split('\n')[7]).toBe(
    'Verdict: busy — the Mac is reserved for "training" for 2h00m more: heavy local jobs are blocked (/busy off lifts it).',
  )
  // No GPU, vm_stat unread, no process table: tried and failed a moment ago, or never.
  const bare: Snapshot = { ...SNAPSHOT, freePct: null, unusedGB: null, compressorGB: null, compressedGB: null, gpuPct: null, gpuAt: null, top: [], topAt: null, topTriedAt: 995_000 }
  const bareLines = statusReport(bare, null, 0, 1_000_000, CADENCE).split('\n')
  expect(bareLines[1]).toBe('RAM: free memory unknown (vm_stat did not answer) · 48 GB in all')
  expect(bareLines[3]).toBe('GPU: n/a')
  expect(bareLines[6]).toBe(
    'Biggest apps: no process table — ps did not answer within 10 s (tried 5 s ago; the Mac is that loaded). machine_status and /guard try again at most once a minute, or run `ps -axo rss=,comm= | sort -rn | head -5` yourself.',
  )
  expect(statusReport({ ...bare, topTriedAt: null }, null, 0, 1_000_000, CADENCE).split('\n')[6]).toBe(
    'Biggest apps: no process table from the last 5 min; machine_status or /guard takes one (ps, at most once a minute).',
  )
  // A table older than 5 minutes is not shown.
  expect(statusReport({ ...SNAPSHOT, topAt: 600_000, topTriedAt: 600_000 }, null, 0, 1_000_000, CADENCE).split('\n')[6]).toBe(
    'Biggest apps: no process table from the last 5 min; machine_status or /guard takes one (ps, at most once a minute).',
  )
  expect(statusReport(null, null, 0, 1_000_000, CADENCE)).toBe(
    'machine-guard · no sample yet: the Mac’s memory counters could not be read.\nVerdict: ok — heavy local jobs may start.',
  )
})

test('names the biggest apps in a denial or a note only when a process table exists', () => {
  const critical: Snapshot = { ...SNAPSHOT, pressure: 'critical', level: 4, freePct: 6 }
  expect(criticalDenial(critical, 'python train.py')).toMatch(
    /^machine-guard: memory pressure is critical on this Mac \(6% free, swap 9.2 of 10 GB; biggest: python 31 GB, Claude 9 GB\), so this heavy job was not started: `python train.py`/,
  )
  expect(criticalDenial({ ...critical, top: [] }, 'python train.py')).toMatch(
    /^machine-guard: memory pressure is critical on this Mac \(6% free, swap 9.2 of 10 GB\), so this heavy job/,
  )
  expect(warnContext({ ...SNAPSHOT, pressure: 'warn', freePct: 18, top: [] })).toBe(
    'machine-guard: memory is tight on this Mac (18% free, swap 9.2 of 10 GB). Avoid starting more heavy jobs in parallel; prefer running one at a time.',
  )
})

test('reads the CPU count and the cores the scheduler is recommended to use', () => {
  expect(parseCores('16\n65535\n')).toEqual({ cpuTotal: 16, cpuRecommended: 16, cpuMask: 65535 })
  expect(parseCores('16\n15\n')).toEqual({ cpuTotal: 16, cpuRecommended: 4, cpuMask: 15 })
  expect(parseCores('16\n1055\n')).toEqual({ cpuTotal: 16, cpuRecommended: 6, cpuMask: 1055 })
  expect(parseCores('16\n')).toBeNull()
  expect(parseCores('')).toBeNull()
  expect(isParked(SNAPSHOT)).toBe(false)
  expect(isParked({ ...SNAPSHOT, cpuRecommended: 4, cpuMask: 15 })).toBe(true)
  expect(isParked({ ...SNAPSHOT, cpuTotal: null, cpuRecommended: null, cpuMask: null })).toBe(false)
  expect(isParked(null)).toBe(false)
})

test('parked performance cores show on the status line, in the report, and in what the model is told', () => {
  const parked: Snapshot = { ...SNAPSHOT, cpuRecommended: 4, cpuMask: 15 }
  const unknown: Snapshot = { ...SNAPSHOT, cpuTotal: null, cpuRecommended: null, cpuMask: null }
  expect(statusLine(parked, null, 0)).toBe('RAM 33% free · swap 9.2/10G · GPU 16% · CPU 4/16 cores')
  expect(statusLine(SNAPSHOT, null, 0)).toBe('RAM 33% free · swap 9.2/10G · GPU 16%')
  expect(statusReport(parked, null, 0, 1_000_000, CADENCE).split('\n')[4]).toBe(
    'CPU cores: 4 of 16 recommended by macOS (12 parked, kern.sched_recommended_cores = 15) — the performance controller parks cores under thermal or power pressure; a state that outlasts the load is cleared by a sleep/wake or reboot.',
  )
  expect(statusReport({ ...SNAPSHOT, cpuRecommended: 12, cpuMask: 15615 }, null, 0, 1_000_000, CADENCE).split('\n')[4]).toBe(
    'CPU cores: 12 of 16 recommended by macOS (4 parked, kern.sched_recommended_cores = 15615) — the performance controller parks cores under thermal or power pressure; a state that outlasts the load is cleared by a sleep/wake or reboot.',
  )
  expect(statusReport(SNAPSHOT, null, 0, 1_000_000, CADENCE).split('\n')[4]).toBe('CPU cores: 16 of 16 available.')
  expect(statusReport(unknown, null, 0, 1_000_000, CADENCE).split('\n')[4]).toBe('CPU cores: unknown.')
  expect(coresContext(parked)).toBe(
    'machine-guard: macOS is scheduling on 4 of 16 CPU cores right now (12 parked by its performance controller), so CPU-bound work runs slower than usual: size worker counts to 4 cores and tell the user if it matters.',
  )
  expect(coresToast(parked)).toBe(
    'macOS has parked 12 of 16 CPU cores: scheduling on 4 (kern.sched_recommended_cores = 15). CPU-bound work will crawl until it clears — check thermal pressure (sudo powermetrics --samplers thermal -n 1); a sleep/wake or reboot resets a stuck controller.',
  )
  expect(coresToast(SNAPSHOT)).toBe('All 16 CPU cores are back.')
})
