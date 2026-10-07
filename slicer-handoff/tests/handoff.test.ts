import { expect, test } from 'claude-code/testing'

import {
  contentPaths,
  countPids,
  expandWord,
  findSlicerOpens,
  fullSpectrumPattern,
  mentionsOpen,
  nameSaysFullSpectrum,
  parseSliceArgs,
  quitScript,
  rewriteOpens,
  slicerOfApp,
  slicerOfBundle,
  splitCommand,
} from '../hooks/handoff'
import type { OpenFile, Place } from '../hooks/handoff'

const PLACE: Place = { cwd: '/Users/me/printproj', home: '/Users/me' }
const SCRATCH = '/private/tmp/claude-501/-Users-me/abc/scratchpad'
const TIGER = 'tiger-150-fullspectrum-grey-v3-snapmaker-only.3mf'

/** What a test reads off each open: the slicer and every file's value and path. */
const summary = (command: string, place: Place = PLACE) =>
  findSlicerOpens(command, place).map(open => ({
    slicer: open.slicer,
    selector: open.selectorText,
    files: open.files.map(file => [file.written, file.path]),
  }))

const file = (written: string, path: string | null = null): OpenFile => ({ raw: written, written, path, copiedFrom: null })

test('splits compound commands on &&, ;, ||, | and newlines, keeping quoted text whole', () => {
  const words = splitCommand('a "x && y" && b \'c;d\'; e || f | g\nh 2>&1 &> /dev/null & i').map(segment =>
    segment.map(word => word.raw),
  )
  expect(words).toEqual([['a', '"x && y"'], ['b', "'c;d'"], ['e'], ['f'], ['g'], ['h', '2>&1', '&>', '/dev/null'], ['i']])
})

test('leaves out comments and heredoc bodies, and keeps $( ) inside its word', () => {
  const command = [
    '# open -a BambuStudio commented.3mf',
    'cat <<EOF > notes.txt',
    'open -a BambuStudio inside-heredoc.3mf',
    'EOF',
    'echo "$(ls *.3mf | head -1)" done',
  ].join('\n')
  expect(splitCommand(command).map(segment => segment.map(word => word.raw))).toEqual([
    ['cat', '<<EOF', '>', 'notes.txt'],
    ['echo', '"$(ls *.3mf | head -1)"', 'done'],
  ])
})

test('word offsets point back into the command', () => {
  const command = 'S=/x && open -a "Snapmaker Orca" "$S/f.3mf"'
  for (const segment of splitCommand(command)) {
    for (const word of segment) {
      expect(command.slice(word.start, word.end)).toBe(word.raw)
    }
  }
})

test('expands ~, $HOME and known variables, and says when a value stays open', () => {
  const vars = new Map<string, string | null>([
    ['S', SCRATCH],
    ['T', null],
  ])
  expect(expandWord('~/prints/a.3mf', vars, '/Users/me')).toEqual({ value: '/Users/me/prints/a.3mf', isResolved: true })
  expect(expandWord('"$HOME/a b.3mf"', vars, '/Users/me')).toEqual({ value: '/Users/me/a b.3mf', isResolved: true })
  expect(expandWord('"$S/b.3mf"', vars, null)).toEqual({ value: `${SCRATCH}/b.3mf`, isResolved: true })
  expect(expandWord('${S}/b.3mf', vars, null)).toEqual({ value: `${SCRATCH}/b.3mf`, isResolved: true })
  expect(expandWord("'$S/b.3mf'", vars, null)).toEqual({ value: '$S/b.3mf', isResolved: true })
  expect(expandWord('$SP/x.stl', vars, null)).toEqual({ value: '$SP/x.stl', isResolved: false })
  expect(expandWord('"$T/x.stl"', vars, null)).toEqual({ value: '$T/x.stl', isResolved: false })
  expect(expandWord('"$(pwd)/x.3mf"', vars, null).isResolved).toBe(false)
  expect(expandWord('*.3mf', vars, null).isResolved).toBe(false)
  expect(expandWord('a\\ b.3mf', vars, null)).toEqual({ value: 'a b.3mf', isResolved: true })
})

test('maps app names, app paths and bundle ids to slicers', () => {
  expect(slicerOfApp('BambuStudio')).toBe('bambu')
  expect(slicerOfApp('Bambu Studio')).toBe('bambu')
  expect(slicerOfApp('/Applications/BambuStudio.app')).toBe('bambu')
  expect(slicerOfApp('/Applications/Snapmaker Orca.app/')).toBe('snapmaker')
  expect(slicerOfApp('Snapmaker Orca')).toBe('snapmaker')
  expect(slicerOfApp('OrcaSlicer')).toBe('orca')
  expect(slicerOfApp('Preview')).toBeNull()
  expect(slicerOfBundle('com.snapmaker.snapmaker-orca')).toBe('snapmaker')
  expect(slicerOfBundle('com.bambulab.bambu-studio')).toBe('bambu')
  expect(slicerOfBundle('com.orcaslicer.OrcaSlicer')).toBe('orca')
  expect(slicerOfBundle('com.apple.Preview')).toBeNull()
})

test('finds every open form Claude used, with the files resolved', () => {
  expect(summary(`S=${SCRATCH} && open -a BambuStudio "$S/x.3mf"`)).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [[`${SCRATCH}/x.3mf`, `${SCRATCH}/x.3mf`]] },
  ])
  expect(summary('open -a "Bambu Studio" x.stl')).toEqual([
    { slicer: 'bambu', selector: '-a "Bambu Studio"', files: [['x.stl', '/Users/me/printproj/x.stl']] },
  ])
  expect(summary('open -a /Applications/BambuStudio.app $SP/x.stl')).toEqual([
    { slicer: 'bambu', selector: '-a /Applications/BambuStudio.app', files: [['$SP/x.stl', null]] },
  ])
  expect(summary('open -b com.snapmaker.snapmaker-orca artifacts/multiview-eval/coupon/x.3mf')).toEqual([
    {
      slicer: 'snapmaker',
      selector: '-b com.snapmaker.snapmaker-orca',
      files: [['artifacts/multiview-eval/coupon/x.3mf', '/Users/me/printproj/artifacts/multiview-eval/coupon/x.3mf']],
    },
  ])
  expect(summary('open -a "Snapmaker Orca" x.3mf')).toEqual([
    { slicer: 'snapmaker', selector: '-a "Snapmaker Orca"', files: [['x.3mf', '/Users/me/printproj/x.3mf']] },
  ])
  expect(summary('open -a Snapmaker\\ Orca ~/x.3mf')).toEqual([
    { slicer: 'snapmaker', selector: '-a Snapmaker\\ Orca', files: [['/Users/me/x.3mf', '/Users/me/x.3mf']] },
  ])
})

test('reads a compound command: variables, a cp before the open, and the trailing sleep', () => {
  const command = `S=${SCRATCH} && cp artifacts/full-spectrum/a.3mf "$S/b.3mf" && open -a BambuStudio "$S/b.3mf" && echo opened; sleep 20`
  const [open, ...rest] = findSlicerOpens(command, PLACE)
  expect(rest).toEqual([])
  expect(open?.slicer).toBe('bambu')
  expect(open?.files).toEqual([
    {
      raw: '"$S/b.3mf"',
      written: `${SCRATCH}/b.3mf`,
      path: `${SCRATCH}/b.3mf`,
      copiedFrom: { written: 'artifacts/full-spectrum/a.3mf', path: '/Users/me/printproj/artifacts/full-spectrum/a.3mf' },
    },
  ])
})

test('follows cd, $PWD, ${VAR}, export, and a variable built from another', () => {
  expect(summary('cd /Volumes/prints/out && open -a OrcaSlicer y.3mf')).toEqual([
    { slicer: 'orca', selector: '-a OrcaSlicer', files: [['y.3mf', '/Volumes/prints/out/y.3mf']] },
  ])
  expect(summary('cd sub; open -a BambuStudio ../z.3mf', { cwd: null, home: '/Users/me' })).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [['../z.3mf', null]] },
  ])
  expect(summary(`export S=${SCRATCH}; SP=$S/parts && open -a BambuStudio "\${SP}/p.stl"`)).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [[`${SCRATCH}/parts/p.stl`, `${SCRATCH}/parts/p.stl`]] },
  ])
  expect(summary('cd artifacts && open -a "Snapmaker Orca" "$PWD/coupon/x.3mf"')).toEqual([
    {
      slicer: 'snapmaker',
      selector: '-a "Snapmaker Orca"',
      files: [['/Users/me/printproj/artifacts/coupon/x.3mf', '/Users/me/printproj/artifacts/coupon/x.3mf']],
    },
  ])
  expect(summary('S=$(mktemp -d) && open -a BambuStudio "$S/x.3mf"')).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [['$S/x.3mf', null]] },
  ])
})

test('reads flags, several files, redirections and --args around the files', () => {
  expect(summary('open -na "Snapmaker Orca" a.3mf b.3mf >/dev/null 2>&1')).toEqual([
    {
      slicer: 'snapmaker',
      selector: '-na "Snapmaker Orca"',
      files: [
        ['a.3mf', '/Users/me/printproj/a.3mf'],
        ['b.3mf', '/Users/me/printproj/b.3mf'],
      ],
    },
  ])
  expect(summary('open -g -a BambuStudio c.3mf --args --debug 3')).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [['c.3mf', '/Users/me/printproj/c.3mf']] },
  ])
  expect(summary('open -a BambuStudio d.3mf > /tmp/log & open -a "Snapmaker Orca" e.3mf')).toEqual([
    { slicer: 'bambu', selector: '-a BambuStudio', files: [['d.3mf', '/Users/me/printproj/d.3mf']] },
    { slicer: 'snapmaker', selector: '-a "Snapmaker Orca"', files: [['e.3mf', '/Users/me/printproj/e.3mf']] },
  ])
})

test('ignores what is not a slicer open', () => {
  expect(summary('echo "open -a BambuStudio x.3mf"')).toEqual([])
  expect(summary('open -a Preview render.png')).toEqual([])
  expect(summary('open x.3mf')).toEqual([])
  expect(summary('open -a BambuStudio')).toEqual([])
  expect(summary('# open -a BambuStudio x.3mf\nls')).toEqual([])
  expect(summary('cat <<EOF\nopen -a BambuStudio x.3mf\nEOF')).toEqual([])
  expect(summary('rg "open -a BambuStudio" notes.md')).toEqual([])
  expect(mentionsOpen('git status')).toBe(false)
  expect(mentionsOpen('ls; open -a BambuStudio x.3mf')).toBe(true)
  expect(mentionsOpen('/usr/bin/open -a BambuStudio x.3mf')).toBe(true)
})

test('tells full-spectrum files by name or folder, and not ordinary ones', () => {
  const pattern = fullSpectrumPattern(undefined)
  for (const name of [
    'tiger-150-fullspectrum-grey-v3-snapmaker-only.3mf',
    'seated-figure-120mm-fullspectrum-white-snapmaker-only.3mf',
    'sphere-20mm-snapmaker-fs.3mf',
    'figure2-tiger-u1.3mf',
    'figure2-tiger-u1-post.3mf',
    'coupon/full-spectrum/cmyk-ratio-coupon.3mf',
    '/Users/me/printproj/artifacts/Full_Spectrum/x.3mf',
  ]) {
    expect(nameSaysFullSpectrum(file(name), pattern)).toBe(true)
  }
  for (const name of ['boot-painted.3mf', 'cube-20mm.3mf', 'sphere-20mm.3mf', 'two-color-cube.3mf', 'menu1.3mf', 'fs-test.stl']) {
    expect(nameSaysFullSpectrum(file(name), pattern)).toBe(false)
  }
})

test('a copy source or a resolved folder can say full-spectrum for a neutral name', () => {
  const pattern = fullSpectrumPattern(undefined)
  expect(nameSaysFullSpectrum(file('b.3mf', '/x/full-spectrum/b.3mf'), pattern)).toBe(true)
  const copied: OpenFile = { ...file('$S/b.3mf'), copiedFrom: { written: 'figure2-tiger-u1.3mf', path: null } }
  expect(nameSaysFullSpectrum(copied, pattern)).toBe(true)
})

test('only resolved 3MF paths are content-checked, the file before its copy source', () => {
  expect(contentPaths(file('a.3mf', '/p/a.3mf'))).toEqual(['/p/a.3mf'])
  expect(contentPaths(file('a.stl', '/p/a.stl'))).toEqual([])
  expect(contentPaths(file('$S/a.3mf'))).toEqual([])
  expect(contentPaths({ ...file('b.3mf', '/s/b.3mf'), copiedFrom: { written: 'a.3mf', path: '/p/a.3mf' } })).toEqual([
    '/s/b.3mf',
    '/p/a.3mf',
  ])
})

test('a custom pattern is used, and a broken one falls back to the default', () => {
  expect(nameSaysFullSpectrum(file('x-cmyk.3mf'), fullSpectrumPattern('cmyk'))).toBe(true)
  expect(nameSaysFullSpectrum(file('x-fullspectrum.3mf'), fullSpectrumPattern('cmyk'))).toBe(false)
  expect(nameSaysFullSpectrum(file('x-fullspectrum.3mf'), fullSpectrumPattern('(unclosed'))).toBe(true)
  expect(nameSaysFullSpectrum(file('x-fullspectrum.3mf'), fullSpectrumPattern(''))).toBe(true)
})

test('rewrites only the matching open and keeps every other byte', () => {
  const command = `S=${SCRATCH} && cp a "$S/${TIGER}" && open -a BambuStudio "$S/${TIGER}" && echo opened; sleep 20`
  const opens = findSlicerOpens(command, PLACE)
  expect(rewriteOpens(command, opens, 'snapmaker')).toBe(
    `S=${SCRATCH} && cp a "$S/${TIGER}" && open -b com.snapmaker.snapmaker-orca "$S/${TIGER}" && echo opened; sleep 20`,
  )

  const two = 'open -a "Bambu Studio" cube-20mm.3mf; open -a /Applications/BambuStudio.app  figure2-tiger-u1.3mf >/dev/null 2>&1'
  const [, second] = findSlicerOpens(two, PLACE)
  expect(rewriteOpens(two, second ? [second] : [], 'snapmaker')).toBe(
    'open -a "Bambu Studio" cube-20mm.3mf; open -b com.snapmaker.snapmaker-orca  figure2-tiger-u1.3mf >/dev/null 2>&1',
  )

  const flags = 'open -na BambuStudio x-fullspectrum.3mf'
  expect(rewriteOpens(flags, findSlicerOpens(flags, PLACE), 'snapmaker')).toBe(
    'open -n -b com.snapmaker.snapmaker-orca x-fullspectrum.3mf',
  )
  expect(rewriteOpens(flags, [], 'snapmaker')).toBe(flags)
})

test('counts pgrep pids and builds a normal quit', () => {
  expect(countPids('4242\n4343\n')).toBe(2)
  expect(countPids('')).toBe(0)
  expect(quitScript('snapmaker')).toBe('quit app id "com.snapmaker.snapmaker-orca"')
  expect(quitScript('bambu')).toBe('quit app id "com.bambulab.bambu-studio"')
})

test('/slice arguments: the file, resolved, and an optional slicer', () => {
  expect(parseSliceArgs('artifacts/x.3mf', PLACE)).toEqual({
    file: { raw: 'artifacts/x.3mf', written: 'artifacts/x.3mf', path: '/Users/me/printproj/artifacts/x.3mf', copiedFrom: null },
    wanted: null,
  })
  expect(parseSliceArgs('~/a b.3mf snapmaker', PLACE).file?.path).toBe('/Users/me/a b.3mf')
  expect(parseSliceArgs('~/a b.3mf snapmaker', PLACE).wanted).toBe('snapmaker')
  expect(parseSliceArgs('"/p/my model.3mf" bambu', PLACE)).toEqual({
    file: { raw: '"/p/my model.3mf"', written: '/p/my model.3mf', path: '/p/my model.3mf', copiedFrom: null },
    wanted: 'bambu',
  })
  expect(parseSliceArgs('', PLACE)).toEqual({ file: null, wanted: null })
})
