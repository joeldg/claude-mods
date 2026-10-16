import { expect, test } from 'claude-code/testing'

import type { CachedListener, KnownEntry, Server } from '../types'
import {
  commandScore,
  describe as describeSnapshot,
  detectManager,
  expandHome,
  findConflict,
  formatUptime,
  holderNote,
  isClaudeCode,
  isFresh,
  isInside,
  isSystemProgram,
  knownEntries,
  lastLines,
  logPath,
  matchServers,
  MAX_POLL_MS,
  mayScan,
  nextPollMs,
  parseCwds,
  parseEtime,
  parseLaunchJson,
  parseListeners,
  parseNetstat,
  parsePackageJson,
  parsePortTable,
  parseProcesses,
  parseProcfile,
  parseScanCache,
  parseScanLock,
  parseSs,
  portFromCommand,
  programName,
  programOf,
  projectKey,
  scriptCalled,
  serverLine,
  SLOW_MS,
  startScript,
  statusLine,
  toolText,
  upSince,
} from '../hooks/servers'

const LSOF = [
  'p646',
  'crapportd',
  'f10',
  'n*:53480',
  'f11',
  'n*:53480',
  'p4242',
  'cnode',
  'f23',
  'n[::1]:5173',
  'f24',
  'n127.0.0.1:5173',
  'f25',
  'n*:24678',
  'p986',
  'cpostgres',
  'f7',
  'n[::1]:5432',
  '',
].join('\n')

test('reads listeners, their commands and ports from lsof -F pcn', () => {
  expect(parseListeners(LSOF)).toEqual([
    { pid: 646, command: 'rapportd', ports: [53480] },
    { pid: 4242, command: 'node', ports: [5173, 24678] },
    { pid: 986, command: 'postgres', ports: [5432] },
  ])
  expect(parseListeners('')).toEqual([])
})

test('reads working directories from lsof -d cwd -Fn', () => {
  const cwds = parseCwds('p4242\nfcwd\nn/Users/me/project\np986\nfcwd\nn/opt/homebrew/var/postgresql\n')
  expect(cwds.get(4242)).toBe('/Users/me/project')
  expect(cwds.get(986)).toBe('/opt/homebrew/var/postgresql')
  expect(cwds.size).toBe(2)
})

test('reads elapsed time and command lines from ps', () => {
  expect(parseEtime('05:07')).toBe(307)
  expect(parseEtime('02:03:04')).toBe(7384)
  expect(parseEtime('1-02:03:04')).toBe(93_784)
  expect(parseEtime('bogus')).toBeNull()
  const rows = parseProcesses(
    ' 4242    02:10:00 node /Users/me/project/node_modules/.bin/vite --port 5173\n  986 05-07:27:45 /opt/homebrew/bin/postgres -D /x\n',
  )
  expect(rows.get(4242)).toEqual({ upSeconds: 7800, commandLine: 'node /Users/me/project/node_modules/.bin/vite --port 5173' })
  expect(rows.get(986)?.upSeconds).toBe(5 * 86_400 + 7 * 3600 + 27 * 60 + 45)
  expect(formatUptime(7800)).toBe('2h')
  expect(formatUptime(42)).toBe('42s')
  expect(formatUptime(600)).toBe('10m')
  expect(formatUptime(200_000)).toBe('2d')
})

test('reads the holder of one port from the lsof table', () => {
  const table = [
    'COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node     123 me     23u  IPv6 0xdea46c6399673b40      0t0  TCP *:4000 (LISTEN)',
    'node     123 me     24u  IPv4 0x4f7d8bf164f36e9c      0t0  TCP 127.0.0.1:4000 (LISTEN)',
  ].join('\n')
  expect(parsePortTable(table)).toEqual([{ command: 'node', pid: 123 }])
  expect(parsePortTable('')).toEqual([])
})

test('a path is inside the project root only below it', () => {
  expect(isInside('/Users/me/project', '/Users/me/project')).toBe(true)
  expect(isInside('/Users/me/project/web', '/Users/me/project')).toBe(true)
  expect(isInside('/Users/me/project-two', '/Users/me/project')).toBe(false)
  expect(isInside('/Users/me', '/Users/me/project')).toBe(false)
})

test('picks the package manager from the lockfile', () => {
  expect(detectManager(['pnpm-lock.yaml', 'package-lock.json'])).toBe('pnpm')
  expect(detectManager(['yarn.lock'])).toBe('yarn')
  expect(detectManager(['bun.lockb'])).toBe('bun')
  expect(detectManager(['bun.lock'])).toBe('bun')
  expect(detectManager(['package-lock.json'])).toBe('npm')
  expect(detectManager([], 'pnpm@9.1.0')).toBe('pnpm')
  expect(detectManager([])).toBe('npm')
})

const PACKAGE = JSON.stringify({
  name: 'web',
  scripts: {
    build: 'vite build',
    dev: 'vite --port 5173',
    'dev:api': 'PORT=4000 node server/index.js',
    start: 'npm run dev',
    preview: 'vite preview',
    'start:prod': 'node dist/server.js',
    test: 'vitest',
    'devtools': 'echo nope',
  },
})

test('reads the server scripts of package.json, with their ports', () => {
  expect(parsePackageJson(PACKAGE, 'pnpm')).toEqual([
    { name: 'dev', command: 'pnpm run dev', source: 'package.json', port: 5173, matchText: 'vite --port 5173' },
    { name: 'dev:api', command: 'pnpm run dev:api', source: 'package.json', port: 4000, matchText: 'PORT=4000 node server/index.js' },
    // start only calls dev: it is matched by dev's command line, its port read from its own.
    { name: 'start', command: 'pnpm run start', source: 'package.json', port: null, matchText: 'vite --port 5173' },
    { name: 'preview', command: 'pnpm run preview', source: 'package.json', port: null, matchText: 'vite preview' },
    { name: 'start:prod', command: 'pnpm run start:prod', source: 'package.json', port: null, matchText: 'node dist/server.js' },
  ])
  expect(parsePackageJson('{ not json', 'npm')).toEqual([])
})

test('reads .claude/launch.json configurations, comments and trailing commas allowed', () => {
  const launch = `{
    // started by the preview tool
    "version": "0.0.1",
    "configurations": [
      { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 },
      { "name": "docs", "runtimeExecutable": "python3", "runtimeArgs": ["-m", "http.server", "8001"], },
      { "name": "attach", "url": "http://localhost:9000" },
    ],
  }`
  expect(parseLaunchJson(launch)).toEqual([
    { name: 'web', command: 'npm run dev', source: 'launch.json', port: 5173, matchText: 'npm run dev' },
    { name: 'docs', command: 'python3 -m http.server 8001', source: 'launch.json', port: 8001, matchText: 'python3 -m http.server 8001' },
  ])
  expect(parseLaunchJson('nope')).toEqual([])
})

test('reads Procfile lines', () => {
  expect(parseProcfile('# processes\nweb: bundle exec rails server -p 3000\nworker:  bundle exec sidekiq\n\n')).toEqual([
    { name: 'web', command: 'bundle exec rails server -p 3000', source: 'Procfile', port: 3000, matchText: 'bundle exec rails server -p 3000' },
    { name: 'worker', command: 'bundle exec sidekiq', source: 'Procfile', port: null, matchText: 'bundle exec sidekiq' },
  ])
})

test('finds ports and script calls in command lines', () => {
  expect(portFromCommand('vite --port 5173')).toBe(5173)
  expect(portFromCommand('next dev --port=3001')).toBe(3001)
  expect(portFromCommand('rails server -p 3000')).toBe(3000)
  expect(portFromCommand('PORT=4000 node server.js')).toBe(4000)
  expect(portFromCommand('gunicorn app:app --bind 0.0.0.0:8000')).toBe(8000)
  expect(portFromCommand('python manage.py runserver 0.0.0.0:8080')).toBe(8080)
  expect(portFromCommand('tsc -p tsconfig.json')).toBeNull()
  expect(scriptCalled('npm run dev')).toBe('dev')
  expect(scriptCalled('npm start')).toBe('start')
  expect(scriptCalled('pnpm dev:api')).toBe('dev:api')
  expect(scriptCalled('yarn dev')).toBe('dev')
  expect(scriptCalled('bun run dev')).toBe('dev')
  expect(scriptCalled('npm install')).toBeNull()
  expect(scriptCalled('vite')).toBeNull()
})

test('merges the sources: launch.json first, scripts it runs not repeated, names unique', () => {
  const entries = knownEntries({
    packageJson: PACKAGE,
    launchJson: '{"configurations":[{"name":"web","runtimeExecutable":"npm","runtimeArgs":["run","dev"]}]}',
    procfile: 'preview: npm run preview\nweb: node server.js\n',
    manager: 'npm',
  })
  expect(entries.map(entry => [entry.id, entry.name, entry.source, entry.port])).toEqual([
    ['web', 'web', 'launch.json', 5173],
    ['preview', 'preview', 'Procfile', null],
    ['web-procfile', 'web (Procfile)', 'Procfile', null],
    ['dev-api', 'dev:api', 'package.json', 4000],
    ['start', 'start', 'package.json', null],
    ['start-prod', 'start:prod', 'package.json', null],
  ])
  // The launch.json entry runs `npm run dev`; it is matched by dev's own command line.
  expect(entries[0]?.matchText).toBe('vite --port 5173')
})

test('matches a command line to a start command', () => {
  expect(programName('/usr/local/bin/python3.12')).toBe('python')
  expect(commandScore('vite --port 5173', 'node /Users/me/project/node_modules/.bin/vite --port 5173')).toBe(2)
  expect(commandScore('vite', 'node /Users/me/project/node_modules/.bin/vite --port 5174')).toBe(2)
  expect(commandScore('next dev', 'next-server (v14.2.3)')).toBe(1)
  expect(commandScore('PORT=4000 node server/index.js', 'node server/index.js')).toBe(2)
  expect(commandScore('node server/index.js', 'node /Users/me/project/server/index.js')).toBe(2)
  // An interpreter alone is no match: its script must be the same.
  expect(commandScore('node server/index.js', 'node other.js')).toBe(0)
  expect(commandScore('uvicorn app.main:app --reload', '/Users/me/project/.venv/bin/python3 /Users/me/project/.venv/bin/uvicorn app.main:app --reload')).toBe(2)
  expect(commandScore('vite', 'webpack serve')).toBe(0)
})

const entry = (over: Partial<KnownEntry> & Pick<KnownEntry, 'id'>): KnownEntry => ({
  name: over.id,
  command: `npm run ${over.id}`,
  source: 'package.json',
  port: null,
  matchText: over.id,
  ...over,
})

const server = (over: Partial<Server> & Pick<Server, 'pid'>): Server => ({
  name: 'node',
  entryId: null,
  ports: [],
  cwd: '/Users/me/project',
  upSeconds: 60,
  commandLine: 'node',
  ...over,
})

test('names running servers by port first, then by command line, and lists the rest as stopped', () => {
  const entries = [
    entry({ id: 'web', source: 'launch.json', port: 3000, matchText: 'next dev' }),
    entry({ id: 'dev', matchText: 'vite --port 5173', port: 5173 }),
    entry({ id: 'api', matchText: 'node server/index.js' }),
    entry({ id: 'preview', matchText: 'vite preview' }),
  ]
  const result = matchServers(
    [
      server({ pid: 1, ports: [3000], commandLine: 'next-server (v14.2.3)' }),
      server({ pid: 2, ports: [5174], commandLine: 'node /Users/me/project/node_modules/.bin/vite --port 5173' }),
      server({ pid: 3, ports: [9229], commandLine: 'node --inspect other.js' }),
    ],
    entries,
  )
  expect(result.servers.map(one => [one.pid, one.name, one.entryId])).toEqual([
    [1, 'web', 'web'],
    [2, 'dev', 'dev'],
    [3, 'node', null],
  ])
  expect(result.stopped.map(one => one.id)).toEqual(['api', 'preview'])
})

test('the status line lists project ports, and clears with none', () => {
  expect(statusLine([server({ pid: 1, ports: [5173, 24678] }), server({ pid: 2, ports: [4000] })])).toBe(
    'servers: :4000 :5173 :24678',
  )
  expect(statusLine([])).toBeUndefined()
  expect(serverLine(server({ pid: 4242, name: 'dev', ports: [5173], upSeconds: 7300 }))).toBe('dev · :5173 · pid 4242 · up 2h')
})

test('builds the detached start command and its log path', () => {
  const log = logPath('/Users/me/.claude/dev-servers/', '/Users/me/project', { id: 'dev-api' })
  expect(log).toBe(`/Users/me/.claude/dev-servers/${projectKey('/Users/me/project')}/dev-api.log`)
  expect(projectKey('/Users/me/project')).toMatch(/^project-[0-9a-z]+$/)
  expect(projectKey('/Users/me/project')).not.toBe(projectKey('/Users/me/other/project'))
  expect(expandHome('~/.claude/dev-servers', '/Users/me')).toBe('/Users/me/.claude/dev-servers')
  expect(startScript('/Users/me/my project', 'pnpm run dev', '/Users/me/logs/dev.log')).toBe(
    "mkdir -p /Users/me/logs && cd '/Users/me/my project' && nohup pnpm run dev > /Users/me/logs/dev.log 2>&1 < /dev/null &",
  )
  expect(startScript('/r', 'cd api && node server.js', '/l/web.log')).toBe(
    "mkdir -p /l && cd /r && nohup sh -c 'cd api && node server.js' > /l/web.log 2>&1 < /dev/null &",
  )
})

test('finds port conflicts in command output', () => {
  expect(findConflict("Error: listen EADDRINUSE: address already in use :::4000\n    at Server.setupListenHandle")).toEqual({ port: 4000 })
  expect(findConflict('error when starting dev server:\nError: Port 5173 is already in use')).toEqual({ port: 5173 })
  expect(findConflict('listen tcp :8080: bind: address already in use')).toEqual({ port: 8080 })
  expect(findConflict('Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)')).toEqual({ port: 3000 })
  expect(findConflict('OSError: [Errno 48] Address already in use')).toEqual({ port: null })
  expect(findConflict('Compiled successfully on port 3000')).toBeNull()
  expect(holderNote(4000, { pid: 123, command: 'node', upSeconds: 7200, cwd: '/Users/me/other' })).toBe(
    'Port 4000 is held by node (pid 123, up 2h, in /Users/me/other)',
  )
  expect(holderNote(4000, { pid: 123, command: 'node', upSeconds: null, cwd: null })).toBe('Port 4000 is held by node (pid 123)')
})

test('keeps the last lines of a log, colours stripped', () => {
  expect(lastLines('one\n\u001b[32mtwo\u001b[39m\n\nthree\nfour\n', 3)).toEqual(['two', 'three', 'four'])
})

test('/servers text lists running, stopped and other listeners', () => {
  expect(
    describeSnapshot({
      root: '/Users/me/project',
      servers: [server({ pid: 4242, name: 'dev', ports: [5173], upSeconds: 120 })],
      stopped: [entry({ id: 'api' })],
      others: 1,
    }),
  ).toBe(
    'Running in /Users/me/project:\n  dev · :5173 · pid 4242 · up 2m\nNot running: api (npm run api)\n1 other listener on this machine.',
  )
})

// ---------------------------------------------------------------------------
// The listen scan without lsof: netstat (macOS) and ss (Linux)
// ---------------------------------------------------------------------------

const NETSTAT = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs',
  'tcp4       0      0  127.0.0.1.5173         *.*                    LISTEN                 0            0  131072  131072             node:4242   00100 00000006 00000000012be366 00000001 00000800      1      0 000000',
  'tcp6       0      0  ::1.5173               *.*                    LISTEN                 0            0  131072  131072             node:4242   00100 00000006 00000000012be367 00000001 00000800      1      0 000000',
  'tcp4       0      0  *.24678                *.*                    LISTEN                 0            0  131072  131072             node:4242   00100 00000006 00000000012be368 00000001 00000800      1      0 000000',
  'tcp4       0      0  127.0.0.1.54677        *.*                    LISTEN                 0            0  131072  131072     Notes Helper:1024   00100 00000106 00000000012d9e01 00000001 00000800      1      0 000000',
  'tcp46      0      0  *.5432                 *.*                    LISTEN                 0            0  131072  131072         postgres:986   00100 00000006 00000000012c0001 00000001 00000800      1      0 000000',
  'tcp4       0      0  10.0.0.5.55135         93.184.216.34.443      ESTABLISHED         2664        25531  131072  131072           node:4242  00102 00000000 00000000012e05f2 00000081 04000900      2      0 000000',
  'tcp6       0      0  2001:db8:1:2:.55132    2001:db8::10.443       CLOSE_WAIT         13732          932  131072  131768           claude:19207  00122 00000000 00000000012e05c2 00000080 04000900      2      0 000000',
  '',
].join('\n')

/** Older macOS: a bare `pid` column (and `epid`), no process name. */
const NETSTAT_OLD = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat  shiwat    pid   epid  state  options           gencnt    flags   flags1 usecnt rtncnt fltrs',
  'tcp4       0      0  127.0.0.1.5173         *.*                    LISTEN      131072  131072   4242      0 00100 00000006 00000000012be366 00000001 00000800      1      0 000000',
  'tcp4       0      0  10.0.0.5.55135         93.184.216.34.443      ESTABLISHED 131072  131072   4242      0 00102 00000000 00000000012e05f2 00000081 04000900      2      0 000000',
].join('\n')

/** GNU netstat: another table altogether, which is how a Linux box is told to try ss. */
const NETSTAT_LINUX = [
  'Active Internet connections (servers and established)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  'tcp        0      0 0.0.0.0:3000            0.0.0.0:*               LISTEN      123/node',
].join('\n')

test('reads LISTEN rows from netstat -anv -p tcp: the port after the last dot, the pid after the process name', () => {
  expect(parseNetstat(NETSTAT)).toEqual([
    { pid: 4242, command: 'node', ports: [5173, 24678] },
    { pid: 1024, command: 'Notes Helper', ports: [54677] },
    { pid: 986, command: 'postgres', ports: [5432] },
  ])
  expect(parseNetstat(NETSTAT_OLD)).toEqual([{ pid: 4242, command: '', ports: [5173] }])
  // The header alone is a table with no listeners; anything else is not this table.
  expect(parseNetstat(NETSTAT.split('\n').slice(0, 2).join('\n'))).toEqual([])
  expect(parseNetstat(NETSTAT_LINUX)).toBeNull()
  expect(parseNetstat('')).toBeNull()
})

const SS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      511    0.0.0.0:3000        0.0.0.0:*         users:(("node",pid=123,fd=18))',
  'LISTEN 0      511    [::1]:5173          [::]:*            users:(("node",pid=123,fd=19))',
  'LISTEN 0      4096   127.0.0.1:5432      0.0.0.0:*         users:(("postgres",pid=456,fd=5))',
  'LISTEN 0      128    *:8080              *:*               users:(("java",pid=789,fd=100),("java",pid=790,fd=100))',
  'LISTEN 0      128    127.0.0.1%lo:631    0.0.0.0:*',
  '',
].join('\n')

test('reads LISTEN rows from ss -ltnp: every pid of a socket, rows without a process skipped', () => {
  expect(parseSs(SS)).toEqual([
    { pid: 123, command: 'node', ports: [3000, 5173] },
    { pid: 456, command: 'postgres', ports: [5432] },
    { pid: 789, command: 'java', ports: [8080] },
    { pid: 790, command: 'java', ports: [8080] },
  ])
  expect(parseSs(SS.split('\n')[0] ?? '')).toEqual([])
  expect(parseSs('')).toBeNull()
  expect(parseSs(NETSTAT)).toBeNull()
})

test("tells Claude Code's own processes, the desktop app's engine and the CLI, which are never a project's servers", () => {
  // The desktop app's engine: its path has a space in it, so the whole line is read, not its first word.
  expect(
    isClaudeCode(
      '/Users/me/Library/Application Support/Claude/claude-code/2.1.299/4fa9694b7975/claude.app/Contents/MacOS/claude --output-format stream-json',
    ),
  ).toBe(true)
  // The CLI's versioned binaries, and the launcher that runs them.
  expect(isClaudeCode('/Users/me/.local/share/claude/versions/2.1.296')).toBe(true)
  expect(isClaudeCode('/Users/me/.local/share/claude/versions/2.1.295 --resume 1234')).toBe(true)
  expect(isClaudeCode('claude')).toBe(true)
  expect(isClaudeCode('claude --continue')).toBe(true)
  expect(isClaudeCode('/Users/me/.local/bin/claude -p hello')).toBe(true)
  // netstat's name alone: `claude` says enough; a bare version number does not until ps has answered.
  expect(isClaudeCode('2.1.296')).toBe(false)
  // The desktop app itself is not a session, and nothing merely named after Claude is one.
  expect(isClaudeCode('/Applications/Claude.app/Contents/MacOS/Claude')).toBe(false)
  expect(isClaudeCode('node /Users/me/claude-proxy/server.js')).toBe(false)
  expect(isClaudeCode('python3 claude_client.py --port 8000')).toBe(false)
  expect(isClaudeCode('/opt/homebrew/bin/postgres -D /x')).toBe(false)
  expect(isClaudeCode('')).toBe(false)
})

test("tells the system's own programs, whose folder is never asked, from a project's", () => {
  expect(isSystemProgram('/usr/libexec/rapportd')).toBe(true)
  expect(isSystemProgram('/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter')).toBe(true)
  expect(isSystemProgram('/Applications/Notes Helper.app/Contents/MacOS/Notes Helper --type=utility')).toBe(true)
  expect(isSystemProgram('/usr/lib/systemd/systemd-resolved')).toBe(true)
  expect(isSystemProgram('node /home/dev/app/node_modules/.bin/vite')).toBe(false)
  expect(isSystemProgram('/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql')).toBe(false)
  expect(isSystemProgram('/usr/local/bin/node server.js')).toBe(false)
  expect(isSystemProgram('')).toBe(false)
  expect(programOf('node /home/dev/app/node_modules/.bin/vite --port 5173')).toBe('node')
  expect(programOf('/opt/homebrew/bin/postgres -D /x')).toBe('postgres')
  expect(programOf('')).toBe('')
  expect(upSince(1_000_000 - 7_800_000, 1_000_000)).toBe(7800)
  expect(upSince(null, 1_000_000)).toBeNull()
  expect(upSince(2_000_000, 1_000_000)).toBe(0)
})

// ---------------------------------------------------------------------------
// Pacing: backoff, and the cache every session shares
// ---------------------------------------------------------------------------

test('a slow scan doubles the poll interval up to five minutes; a fast one resets it', () => {
  expect(SLOW_MS).toBe(2_000)
  expect(MAX_POLL_MS).toBe(300_000)
  expect(nextPollMs(15_000, 15_000, true)).toBe(30_000)
  expect(nextPollMs(30_000, 15_000, true)).toBe(60_000)
  expect(nextPollMs(240_000, 15_000, true)).toBe(MAX_POLL_MS)
  expect(nextPollMs(MAX_POLL_MS, 15_000, true)).toBe(MAX_POLL_MS)
  expect(nextPollMs(60_000, 15_000, false)).toBe(15_000)
  expect(nextPollMs(15_000, 15_000, false)).toBe(15_000)
})

test('reads the shared scan cache and lock, and knows when to use one and when to take the other', () => {
  const listener: CachedListener = {
    pid: 4242,
    command: 'node',
    ports: [5173],
    detail: { commandLine: 'node server.js', startedAt: 900_000, cwd: '/home/dev/app' },
  }
  const unknown: CachedListener = { pid: 986, command: 'postgres', ports: [5432], detail: null }
  const cache = parseScanCache(
    JSON.stringify({ ts: 990_000, by: 'session-b', data: { listeners: [listener, unknown, { bogus: true }, { pid: 'x', ports: [] }] } }),
  )
  expect(cache).toEqual({ ts: 990_000, by: 'session-b', data: { listeners: [listener, unknown] } })
  expect(parseScanCache(null)).toBeNull()
  expect(parseScanCache('{ not json')).toBeNull()
  expect(parseScanCache('{"ts":"soon","by":"x","data":{"listeners":[]}}')).toBeNull()
  expect(parseScanCache('{"ts":1,"by":"x","data":{}}')).toBeNull()
  expect(parseScanLock('{"ts":995000,"by":"session-b"}')).toEqual({ ts: 995_000, by: 'session-b' })
  expect(parseScanLock('[]')).toBeNull()
  expect(parseScanLock(null)).toBeNull()
  expect(isFresh(990_000, 1_000_000, 13_000)).toBe(true)
  expect(isFresh(985_000, 1_000_000, 13_000)).toBe(false)
  expect(isFresh(2_000_000, 1_000_000, 13_000)).toBe(false)
  // No lock, our own, or one older than a scan can take: scan. Another session's recent one: wait for it.
  expect(mayScan(null, 1_000_000, 'session-a', 19_000)).toBe(true)
  expect(mayScan({ ts: 999_000, by: 'session-a' }, 1_000_000, 'session-a', 19_000)).toBe(true)
  expect(mayScan({ ts: 999_000, by: 'session-b' }, 1_000_000, 'session-a', 19_000)).toBe(false)
  expect(mayScan({ ts: 980_000, by: 'session-b' }, 1_000_000, 'session-a', 19_000)).toBe(true)
})

test('the dev_servers tool text: running servers with their pane logs, stopped entries, the other listeners on request', () => {
  const snapshot = {
    root: '/home/dev/app',
    servers: [
      server({ pid: 4242, name: 'dev', entryId: 'dev', ports: [5173], upSeconds: 120 }),
      server({ pid: 7001, ports: [9229], upSeconds: 300, commandLine: 'node --inspect tools/mock.js' }),
    ],
    stopped: [entry({ id: 'api', port: 4000 }), entry({ id: 'preview' })],
    others: 2,
    otherListeners: [
      {
        pid: 986,
        command: 'postgres',
        ports: [5432],
        detail: { commandLine: '/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql', startedAt: null, cwd: '/opt/homebrew/var/postgresql' },
      },
      { pid: 646, command: 'rapportd', ports: [53480], detail: null },
    ],
    claudeSessions: 0,
    scannedAt: 1_000_000 - 12_000,
  }
  const logs = new Map([[4242, '/home/dev/.claude/dev-servers/app-1x2y3z/dev.log']])
  expect(toolText(snapshot, { all: false, logs, now: 1_000_000 })).toBe(
    [
      'Running in /home/dev/app:',
      '  dev · :5173 · pid 4242 · up 2m · log /home/dev/.claude/dev-servers/app-1x2y3z/dev.log',
      '  node · :9229 · pid 7001 · up 5m',
      'Not running: api (npm run api, :4000), preview (npm run preview).',
      '2 other listeners on this machine (all: true lists them).',
      "Scanned 12s ago. Starting, stopping and restarting are the Servers pane's buttons (/servers); this tool only lists.",
    ].join('\n'),
  )
  expect(toolText(snapshot, { all: true, logs: new Map(), now: 1_000_000 })).toContain(
    ['Other listeners on this machine:', '  :5432 · postgres · pid 986 · in /opt/homebrew/var/postgresql', '  :53480 · rapportd · pid 646'].join('\n'),
  )
  expect(toolText({ ...snapshot, servers: [], stopped: [], others: 0, otherListeners: [] }, { all: true, logs: new Map(), now: 1_000_000 })).toContain(
    'No dev servers are listening in /home/dev/app.\nNo other listeners on this machine.',
  )
  // Claude Code's own sessions are never listed, only counted, in one line after the others: nothing is left out silently.
  expect(toolText({ ...snapshot, claudeSessions: 3 }, { all: true, logs: new Map(), now: 1_000_000 })).toContain(
    '  :53480 · rapportd · pid 646\n(3 Claude Code sessions not listed)\nScanned 12s ago.',
  )
  expect(toolText({ ...snapshot, otherListeners: [], claudeSessions: 1 }, { all: true, logs: new Map(), now: 1_000_000 })).toContain(
    'No other listeners on this machine.\n(1 Claude Code session not listed)\n',
  )
  expect(toolText(snapshot, { all: true, logs: new Map(), now: 1_000_000 })).not.toContain('Claude Code')
  expect(toolText({ ...snapshot, claudeSessions: 3 }, { all: false, logs, now: 1_000_000 })).not.toContain('Claude Code')
})
