import { expect, test } from 'claude-code/testing'

import type { KnownEntry, Server } from '../types'
import {
  commandScore,
  describe as describeSnapshot,
  detectManager,
  expandHome,
  findConflict,
  formatUptime,
  holderNote,
  isInside,
  knownEntries,
  lastLines,
  logPath,
  matchServers,
  parseCwds,
  parseEtime,
  parseLaunchJson,
  parseListeners,
  parsePackageJson,
  parsePortTable,
  parseProcesses,
  parseProcfile,
  portFromCommand,
  programName,
  projectKey,
  scriptCalled,
  serverLine,
  startScript,
  statusLine,
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
    'Running in /Users/me/project:\n  dev · :5173 · pid 4242 · up 2m\nNot running: api (npm run api)\n1 other listener on this Mac.',
  )
})
