import { expect, test } from 'claude-code/testing'

import {
  etaFrom,
  exitCodeOf,
  formatDuration,
  isAlive,
  isPidAlive,
  isTimerTask,
  launchFromCommand,
  matchToken,
  outputFileFromText,
  parseDf,
  parseProgress,
  programsOf,
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
  // With a pid column in front, our own probe is still told apart.
  expect(isAlive('  512 ps -axo pid=,command= scripts/run.sh\n', 'scripts/run.sh')).toBe(false)
  expect(isAlive('  512 ps -axo pid=,command=\n 4242 /bin/bash ./scripts/run.sh\n', 'scripts/run.sh')).toBe(true)
})

test('tells a process by its pid, from a listing or a per-pid lookup', () => {
  const listing = '  512 ps -axo pid=,command=\n 4242 python train.py\n14242 node server.js\n'
  expect(isPidAlive(listing, 4242)).toBe(true)
  expect(isPidAlive(listing, 424)).toBe(false)
  expect(isPidAlive(listing, 1424)).toBe(false)
  expect(isPidAlive(' 4242\n  777\n', 777)).toBe(true)
  expect(isPidAlive('', 777)).toBe(false)
})

test('reads the exit code a background task leaves at the end of its output', () => {
  expect(exitCodeOf('step 100/100\n\n[exited with code 0]\n')).toBe(0)
  expect(exitCodeOf('Traceback …\n[exited with code 1]')).toBe(1)
  expect(exitCodeOf('[exited with code 0]\nstill writing\n')).toBeNull()
  expect(exitCodeOf('step 99/100\n')).toBeNull()
  // The marker is not a log line: progress and the last line come from what the job wrote.
  const reading = parseProgress('step 100/100 loss 0.1\n\n[exited with code 0]\n')
  expect(reading.progress).toEqual({ done: 100, total: 100, pct: 100 })
  expect(reading.lastLine).toBe('step 100/100 loss 0.1')
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

test('names the programs a command runs', () => {
  expect(programsOf('sleep 600 && echo "timer done"')).toEqual(['sleep', 'echo'])
  expect(programsOf('until [ "$(date +%H%M)" -ge 0146 ]; do sleep 30; done; date')).toEqual(['date', '[', 'sleep', 'date'])
  expect(programsOf('nohup nice -n 15 /usr/bin/timeout -k 5 600 sleep 1000 > out.log 2>&1 &')).toEqual(['timeout', 'sleep'])
  expect(programsOf('for i in 1 2 3; do sleep 60; echo $i; done')).toEqual(['sleep', 'echo'])
  expect(programsOf('cat urls.txt | xargs -n1 curl -sO')).toEqual(['cat', 'xargs'])
  // A pipe inside quotes is no pipe.
  expect(programsOf('rg -q "Traceback|Error" x.log || echo none')).toEqual(['rg', 'echo'])
  expect(programsOf('until { [ -f a.log ] && rg -q "start at" a.log; } || rg -q exited b.log; do sleep 30; done')).toEqual([
    '[',
    'rg',
    'rg',
    'sleep',
  ])
})

test('tells a pure timer from a real background job', () => {
  // A sleep, dressed at most with echo, date and a shell loop, is a timer whatever it is called.
  expect(isTimerTask('sleep 600', 'Wait ten minutes')).toBe(true)
  expect(isTimerTask('sleep 600')).toBe(true)
  expect(isTimerTask('sleep 600 && echo "timer: check the Gemini queue"')).toBe(true)
  expect(isTimerTask('sleep 300; date')).toBe(true)
  expect(isTimerTask('/bin/sleep 120 && echo done && date')).toBe(true)
  expect(isTimerTask('(sleep 600; echo done) 2>&1')).toBe(true)
  expect(isTimerTask('timeout 600 sleep 1000')).toBe(true)
  expect(isTimerTask('timeout 600')).toBe(true)
  expect(isTimerTask('while true; do sleep 60; echo tick; done')).toBe(true)
  expect(isTimerTask('until [ "$(date +%H%M)" -ge 0146 ]; do sleep 30; done; date', 'Wait until about 1:46')).toBe(true)
  // A wait with no sleep in it counts when it is described as one.
  expect(isTimerTask('until [ -f /tmp/done.flag ]; do :; done', 'Wait for the flag file')).toBe(true)
  expect(isTimerTask('until [ -f /tmp/done.flag ]; do :; done', 'Poll for the flag file')).toBe(false)
  // Described as a wait, it may poll and report with programs that only read, and still be a wait.
  const reporting = "sleep 600; S=/tmp/s; rg -o '\\[ *[0-9]+%\\]' $S/full.txt | tail -1; echo \"timer done\""
  expect(isTimerTask(reporting, 'Wait ten minutes, then report merge-check progress')).toBe(true)
  expect(isTimerTask(reporting, 'Report merge-check progress in ten minutes')).toBe(false)
  expect(
    isTimerTask(
      'while pgrep -f "scripts/eval.sh" > /dev/null; do sleep 120; done; date; tail -3 ~/eval.log',
      "Wait for Arm N's evaluation chain to finish",
    ),
  ).toBe(true)
  expect(
    isTimerTask(
      'LOG=~/train.log; while pgrep -f train > /dev/null && ! rg -q "Traceback|Error" $LOG; do sleep 15; done; date; tail -5 $LOG',
      'Wait for the 2,000-step log line or a crash',
    ),
  ).toBe(true)
  expect(
    isTimerTask(
      'until [ "$(ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -o - -)" != "true" ]; do sleep 30; done; echo "unlocked at $(date)"',
      'Wait in the background until the screen is unlocked',
    ),
  ).toBe(true)
  expect(isTimerTask('sleep 40; zsh watch.sh', 'Watch pass 2 on 2 workers')).toBe(false)
  // Anything that runs a real program is a job, however it is described.
  expect(isTimerTask('sleep 600 && gh pr checks 123')).toBe(false)
  expect(isTimerTask('sleep 5 && pytest tests/', 'Wait, then run the tests')).toBe(false)
  expect(isTimerTask('gh run watch 123', 'Wait for CI')).toBe(false)
  expect(isTimerTask('until curl -sf localhost:8080/health; do sleep 2; done', 'Wait for the server')).toBe(false)
  expect(isTimerTask('until [ "$(curl -s localhost:8080/health)" = ok ]; do sleep 2; done', 'Wait for the server')).toBe(false)
  expect(isTimerTask('timeout 600 pytest tests/')).toBe(false)
  expect(isTimerTask('.venv/bin/python -m myproject.train --epochs 3', 'train coarse model')).toBe(false)
  expect(isTimerTask('cat urls.txt | xargs -n1 curl -sO')).toBe(false)
  expect(isTimerTask('')).toBe(false)
})
