import { expect, test } from 'claude-code/testing'

import {
  etaFrom,
  formatDuration,
  isAlive,
  launchFromCommand,
  matchToken,
  outputFileFromText,
  parseDf,
  parseProgress,
  resolvePath,
} from '../hooks/parse'

test('reads the output file of a background Bash task', () => {
  const text =
    'Command running in background with ID: b11xnhuvs. Output is being written to: /private/tmp/claude-501/p/s/tasks/b11xnhuvs.output. You will be notified when it completes.'
  expect(outputFileFromText(text)).toBe('/private/tmp/claude-501/p/s/tasks/b11xnhuvs.output')
  expect(outputFileFromText('done')).toBeNull()
})

test('finds the token ps shows for a job', () => {
  expect(
    matchToken('PYTHONPATH=$PWD/src nohup /x/.venv/bin/python -W ignore -m myproject.datasets.mesh_build --out d'),
  ).toBe('myproject.datasets.mesh_build')
  expect(matchToken('nohup ./scripts/overnight_train.sh >> $HOME/o.log 2>&1 < /dev/null')).toBe(
    'scripts/overnight_train.sh',
  )
  expect(matchToken('nohup nice -n 15 tar xf dataset-3dmodels.tar > extract.log 2>&1')).toBe('tar xf dataset-3dmodels.tar')
  expect(matchToken(".venv/bin/python - <<'EOF'")).toBeNull()
  expect(matchToken('sleep 300')).toBeNull()
})

test('finds a detached launch and its log', () => {
  const launch = launchFromCommand(
    'mkdir -p $HOME/Data && cd /Users/me/Projects/SF && nohup ./scripts/run.sh >> $HOME/Data/run.log 2>&1 < /dev/null & disown; sleep 3; cat $HOME/Data/run.log',
  )
  expect(launch).toEqual({
    log: '$HOME/Data/run.log',
    segment: 'nohup ./scripts/run.sh >> $HOME/Data/run.log 2>&1 < /dev/null',
    cwd: '/Users/me/Projects/SF',
  })
  expect(launchFromCommand('python train.py > out.log')).toBeNull()
  expect(launchFromCommand('nohup caffeinate -i -w 5584 >/dev/null 2>&1 & disown')).toBeNull()
})

test('expands home and relative paths', () => {
  expect(resolvePath('$HOME/Data/run.log', '/Users/me', '/tmp')).toBe('/Users/me/Data/run.log')
  expect(resolvePath('~/x.log', '/Users/me', '/tmp')).toBe('/Users/me/x.log')
  expect(resolvePath('extract.log', '/Users/me', '/Volumes/NAS/data')).toBe('/Volumes/NAS/data/extract.log')
  expect(resolvePath('$O/extract.log', '/Users/me', '/tmp')).toBeNull()
})

test('reads tqdm progress and its ETA from carriage-return output', () => {
  const tail = 'epoch 1\r 12%|█▏        | 120/1000 [00:30<03:40,  4.00it/s]\r 45%|████▌     | 450/1000 [01:52<02:17,  4.01it/s]'
  const reading = parseProgress(tail)
  expect(reading.progress).toEqual({ done: 450, total: 1000, pct: 45 })
  expect(reading.etaSeconds).toBe(137)
})

test('reads step counts, byte counts and bare percentages', () => {
  expect(parseProgress('step 41,200/200,000 loss 0.183\n').progress?.done).toBe(41200)
  expect(parseProgress('Downloaded 12.5G / 50G\n').progress?.pct).toBe(25)
  expect(parseProgress('extracting… 63% done\n').progress?.pct).toBe(63)
  expect(parseProgress('[ 3/12] shard written\n').progress?.total).toBe(12)
  const none = parseProgress('starting up\nloading weights\n')
  expect(none.progress).toBeNull()
  expect(none.lastLine).toBe('loading weights')
})

test('estimates time left from the average rate', () => {
  const progress = { done: 40, total: 100, pct: 40 }
  expect(etaFrom({ at: 0, done: 10 }, 60_000, progress)).toBe(120)
  expect(etaFrom({ at: 0, done: 10 }, 10_000, progress)).toBe(20)
  expect(etaFrom({ at: 0, done: 40 }, 60_000, progress)).toBeNull()
  expect(etaFrom({ at: 0, done: 10 }, 60_000, { done: 0, total: 0, pct: 40 })).toBe(120)
  expect(etaFrom(null, 60_000, progress)).toBeNull()
})

test('tells a running process from our own probes', () => {
  const ps = 'ps -axo command=\n/bin/bash ./scripts/run.sh\npython -m train\n'
  expect(isAlive(ps, 'scripts/run.sh')).toBe(true)
  expect(isAlive('ps -axo command= scripts/run.sh\n', 'scripts/run.sh')).toBe(false)
})

test('reads free space for / and /Volumes, skipping Time Machine', () => {
  const df = [
    'Filesystem     1024-blocks       Used  Available Capacity  iused       ifree %iused  Mounted on',
    '/dev/disk3s1s1   971350180   12341084  157639564     8%   458732  1576395640    0%   /',
    '/dev/disk5s4   11720613840 1481882320 1833575280    45%  4916307 18679548165    0%   /Volumes/Backups of Me',
    '/dev/disk5s1   11720613840 4613760848 1833575280    72% 12495539 18679548165    0%   /Volumes/NAS',
    'devfs                 412        412          0   100%      714           0  100%   /dev',
  ].join('\n')
  expect(parseDf(df, [])).toEqual([
    { mount: '/', freeGB: 150, capacityPct: 8 },
    { mount: '/Volumes/NAS', freeGB: 1749, capacityPct: 72 },
  ])
  expect(parseDf(df, ['/Volumes/NAS'])).toHaveLength(1)
})

test('formats durations', () => {
  expect(formatDuration(45)).toBe('45s')
  expect(formatDuration(600)).toBe('10m')
  expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h12m')
})
