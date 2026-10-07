import { expect, test } from 'claude-code/testing'

import {
  isHeavy,
  parseDuration,
  parseFreePct,
  parseGpu,
  parseReservation,
  parseSysctl,
  parseTopApps,
  pressureOf,
  statusLine,
} from '../hooks/probe'

test('reads the pressure level and swap from sysctl', () => {
  expect(parseSysctl('2\ntotal = 8192.00M  used = 7282.25M  free = 909.75M  (encrypted)\n')).toEqual({
    level: 2,
    swapUsedGB: 7.1,
    swapTotalGB: 8,
  })
  expect(parseSysctl('')).toEqual({ level: null, swapUsedGB: 0, swapTotalGB: 0 })
})

test('reads free memory and GPU use', () => {
  expect(parseFreePct('The system has 51539607552 (12582912 pages)\nSystem-wide memory free percentage: 37%\n')).toBe(37)
  expect(parseGpu('"PerformanceStatistics" = {"Tiler Utilization %"=14,"Renderer Utilization %"=29,"Device Utilization %"=29}')).toBe(29)
  expect(parseGpu('nothing')).toBeNull()
})

test('sums memory per app, helpers included', () => {
  const ps = [
    ' 1307152 /Applications/Microsoft Edge.app/Contents/Frameworks/Microsoft Edge Helper (Renderer).app/Contents/MacOS/Microsoft Edge Helper (Renderer)',
    '  741152 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ' 3145728 /Users/me/Projects/SF/.venv/bin/python3.12',
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
  const snapshot = {
    at: 0,
    pressure: 'warn' as const,
    freePct: 12,
    swapUsedGB: 7.9,
    swapTotalGB: 8,
    gpuPct: 87,
    top: [{ name: 'python', gb: 31 }],
  }
  expect(statusLine(snapshot, null, 0)).toBe('RAM tight 12% free · swap 7.9/8G · top python 31G · GPU 87%')
  expect(statusLine({ ...snapshot, pressure: 'normal', freePct: 40 }, { reason: 'training', until: 7_200_000, setAt: 0 }, 0)).toBe(
    'RAM 40% free · swap 7.9/8G · GPU 87% · reserved 2h00m: training',
  )
})
