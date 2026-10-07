import { expect, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

import {
  DEFAULT_EXTENSIONS,
  attachedText,
  bandLine,
  bandNames,
  byArrival,
  displayFolder,
  expandFolder,
  extensionOf,
  folderName,
  formatSize,
  isBlankTree,
  isMatching,
  isPartialName,
  listText,
  markKey,
  mention,
  mentions,
  newCandidates,
  newest,
  parseAction,
  parseExtensions,
  parsePicks,
  pruneMarks,
  sameFiles,
  settle,
  shortAge,
  shortName,
  toDropFile,
} from '../hooks/drop'
import type { DropFile, DropSeen } from '../types'

const DIR = '/Users/me/Downloads'
const START = 1_700_000_000_000
const MIN = 60_000
const EXTENSIONS = parseExtensions(DEFAULT_EXTENSIONS)

const file = (name: string, mtimeMs: number, size = 1000): FsEntry => ({ name, kind: 'file', size, mtimeMs, isLink: false })
const drop = (name: string, mtimeMs: number, size = 1000): DropFile => toDropFile(DIR, file(name, mtimeMs, size))

const RULES = { extensions: EXTENSIONS, since: START, now: START + 10 * MIN, maxAgeMs: 120 * MIN, cleared: [] }

const names = (entries: readonly { name: string }[]): string[] => entries.map(entry => entry.name)

test('extensions parse loosely and match case-insensitively', () => {
  expect(parseExtensions(' pdf, .MD;3mf  *.STL,pdf ')).toEqual(['pdf', 'md', '3mf', 'stl'])
  expect(EXTENSIONS).toContain('3mf')
  expect(EXTENSIONS).toContain('heic')
  expect(extensionOf('Model-B.3MF')).toBe('3mf')
  expect(extensionOf('archive.tar.gz')).toBe('gz')
  expect(extensionOf('README')).toBe('')
  expect(extensionOf('.bashrc')).toBe('')
  expect(isMatching(file('Paper.PDF', START), ['pdf'])).toBe(true)
  expect(isMatching(file('notes.docx', START), ['pdf'])).toBe(false)
  expect(isMatching(file('notes.docx', START), ['*'])).toBe(true)
  expect(isMatching({ ...file('photos.zip', START), kind: 'dir' }, ['zip'])).toBe(false)
  expect(isMatching({ ...file('link.pdf', START), kind: 'other', isLink: true }, ['pdf'])).toBe(false)
})

test('partial downloads and hidden files never match', () => {
  for (const name of ['paper.pdf.crdownload', 'Unconfirmed 4821.crdownload', 'model.3mf.download', 'clip.mp4.part', 'x.tmp', 'y.zip.opdownload']) {
    expect(isPartialName(name)).toBe(true)
    expect(isMatching(file(name, START), ['*'])).toBe(false)
  }
  expect(isMatching(file('.DS_Store', START), ['*'])).toBe(false)
  expect(isMatching(file('.hidden.pdf', START), ['pdf'])).toBe(false)
  expect(isPartialName('partial-results.pdf')).toBe(false)
})

test('new means modified after the start, within the age limit, wanted, non-empty and not cleared', () => {
  const entries = [
    file('before-start.pdf', START - 1000),
    file('at-start.pdf', START),
    file('model-a.3mf', START + MIN),
    file('Painted model (v2).3mf', START + 2 * MIN),
    file('report.docx', START + MIN),
    file('.secret.pdf', START + MIN),
    file('scan.pdf.crdownload', START + MIN),
    file('empty.txt', START + MIN, 0),
    { ...file('folder.zip', START + MIN), kind: 'dir' as const },
  ]
  expect(names(newCandidates(entries, RULES))).toEqual(['model-a.3mf', 'Painted model (v2).3mf'])

  // Older than maxAgeMinutes never counts, whenever the session started.
  const late = { ...RULES, since: 0, now: START + 200 * MIN }
  expect(names(newCandidates([file('old.pdf', START), file('fresh.pdf', START + 150 * MIN)], late))).toEqual([
    'fresh.pdf',
  ])

  // A file attached or dismissed stays away until it is modified again.
  const cleared = [{ name: 'model-a.3mf', mtimeMs: START + MIN }]
  expect(names(newCandidates(entries, { ...RULES, cleared }))).toEqual(['Painted model (v2).3mf'])
  const rewritten = [file('model-a.3mf', START + 3 * MIN)]
  expect(names(newCandidates(rewritten, { ...RULES, cleared }))).toEqual(['model-a.3mf'])
})

test("a file beside its own partial download (Firefox's placeholder) waits", () => {
  const writing = [file('scan.pdf', START + MIN, 1), file('scan.pdf.part', START + MIN, 52_000)]
  expect(newCandidates(writing, RULES)).toEqual([])
  expect(names(newCandidates([file('scan.pdf', START + MIN, 98_000)], RULES))).toEqual(['scan.pdf'])
})

test('a file is ready once two checks in a row see the same size and time', () => {
  const first = settle([file('big.zip', START + MIN, 100)], new Map())
  expect(first.ready).toEqual([])
  expect(first.seen.get('big.zip')).toEqual({ size: 100, mtimeMs: START + MIN })

  // Still growing: the size moved since the last check.
  const growing = settle([file('big.zip', START + MIN + 5000, 400)], first.seen)
  expect(growing.ready).toEqual([])

  const steady = settle([file('big.zip', START + MIN + 5000, 400)], growing.seen)
  expect(names(steady.ready)).toEqual(['big.zip'])

  // Touched again with the same size: the time moved, so it waits one more check.
  const touched: Map<string, DropSeen> = settle([file('big.zip', START + MIN + 9000, 400)], steady.seen).seen
  expect(settle([file('big.zip', START + MIN + 9000, 400)], touched).ready).toHaveLength(1)

  // A file that left the folder is forgotten.
  expect(settle([], steady.seen).seen.size).toBe(0)
})

test('the band names three files, then +N more, and the newest age', () => {
  const two = [drop('model-a.3mf', START), drop('model-b.3mf', START + 1000)]
  expect(bandLine(two, START + 1000 + 2 * MIN + 5000, 'Downloads')).toBe(
    'New in Downloads: model-a.3mf, model-b.3mf · 2m ago',
  )
  const five = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'].map((name, i) => drop(name, START + i * 1000))
  expect(bandNames(five)).toBe('a.pdf, b.pdf, c.pdf +2 more')
  expect(bandLine(five, START + 4000, 'Downloads')).toBe('New in Downloads: a.pdf, b.pdf, c.pdf +2 more · just now')
  expect(bandNames(five.slice(0, 3))).toBe('a.pdf, b.pdf, c.pdf')

  const long = 'a-very-long-research-paper-title-from-some-preprint-server-v3.pdf'
  expect(shortName(long)).toHaveLength(40)
  expect(shortName(long).endsWith('ver-v3.pdf')).toBe(true)
  expect(shortName('short.pdf')).toBe('short.pdf')
})

test('ages and sizes read short', () => {
  expect(shortAge(0)).toBe('just now')
  expect(shortAge(59_000)).toBe('just now')
  expect(shortAge(2 * MIN + 30_000)).toBe('2m ago')
  expect(shortAge(5 * 60 * MIN)).toBe('5h ago')
  expect(shortAge(72 * 60 * MIN)).toBe('3d ago')
  expect(shortAge(-5000)).toBe('just now')

  expect(formatSize(512)).toBe('512 B')
  expect(formatSize(8_100)).toBe('8.1 KB')
  expect(formatSize(812_000)).toBe('812 KB')
  expect(formatSize(999_900)).toBe('1.0 MB')
  expect(formatSize(2_400_000)).toBe('2.4 MB')
  expect(formatSize(3_200_000_000)).toBe('3.2 GB')
})

test('paths are quoted as @"…" mentions, spaces and all', () => {
  expect(mention('/Users/me/Downloads/Painted model (v2).3mf')).toBe('@"/Users/me/Downloads/Painted model (v2).3mf" ')
  expect(mentions([drop('paper.pdf', START), drop('my notes.md', START)])).toBe(
    '@"/Users/me/Downloads/paper.pdf" @"/Users/me/Downloads/my notes.md" ',
  )
  expect(toDropFile('/Users/me/Downloads/', file('a b.pdf', START)).path).toBe('/Users/me/Downloads/a b.pdf')
  expect(attachedText([drop('a b.pdf', START)], 'filled')).toBe('Put 1 file in the prompt: a b.pdf')
  const two = [drop('a.pdf', START), drop('b c.pdf', START)]
  const paste = 'Paste these instead:\n@"/Users/me/Downloads/a.pdf" @"/Users/me/Downloads/b c.pdf"'
  expect(attachedText(two, 'no_composer')).toBe(
    `There is no prompt box in this session, so the files were not put in it. ${paste}`,
  )
  expect(attachedText(two, 'dialog')).toBe(`A dialog has the keys, so the files were not put in the prompt. ${paste}`)
  expect(attachedText(two, 'refused')).toBe(`The prompt box did not take the files. ${paste}`)
})

test('the folder setting expands ~ and shows back as ~', () => {
  expect(expandFolder('~/Downloads', '/Users/me')).toBe('/Users/me/Downloads')
  expect(expandFolder('~/Downloads/', '/Users/me/')).toBe('/Users/me/Downloads')
  expect(expandFolder('~', '/Users/me')).toBe('/Users/me')
  expect(expandFolder('Desktop/inbox', '/Users/me')).toBe('/Users/me/Desktop/inbox')
  expect(expandFolder('/Volumes/Share/drop/', undefined)).toBe('/Volumes/Share/drop')
  expect(expandFolder('', '/Users/me')).toBe('/Users/me/Downloads')
  expect(expandFolder('~/Downloads', undefined)).toBeNull()
  expect(displayFolder('/Users/me/Downloads', '/Users/me')).toBe('~/Downloads')
  expect(displayFolder('/Users/meg/Downloads', '/Users/me')).toBe('/Users/meg/Downloads')
  expect(folderName('/Users/me/Downloads')).toBe('Downloads')
})

test('the listing is the newest matching files, numbered, the new ones marked', () => {
  const entries = [
    file('old.pdf', START - 60 * MIN, 812_000),
    file('sphere.3mf', START + MIN, 2_400_000),
    file('.DS_Store', START + 2 * MIN),
    file('half.zip.crdownload', START + 2 * MIN),
    file('report.docx', START + 2 * MIN),
  ]
  const files = newest(entries, EXTENSIONS).map(entry => toDropFile(DIR, entry))
  expect(names(files)).toEqual(['sphere.3mf', 'old.pdf'])
  const text = listText(files, new Set([markKey(files[0] ?? drop('x', 0))]), START + 4 * MIN, '~/Downloads')
  expect(text.split('\n')).toEqual([
    'Newest in ~/Downloads (/downloads attach 1 3 puts files in the prompt):',
    '  1. sphere.3mf · 2.4 MB · 3m ago · new',
    '  2. old.pdf · 812 KB · 1h ago',
  ])
  const many = Array.from({ length: 14 }, (_, i) => file(`f${i}.pdf`, START + i))
  expect(names(newest(many, EXTENSIONS))).toEqual(Array.from({ length: 10 }, (_, i) => `f${13 - i}.pdf`))
})

test('/downloads arguments and picks parse', () => {
  expect(parseAction('')).toEqual({ kind: 'list' })
  expect(parseAction('  list ')).toEqual({ kind: 'list' })
  expect(parseAction('attach 1 3')).toEqual({ kind: 'attach', picks: '1 3' })
  expect(parseAction('ATTACH')).toEqual({ kind: 'attach', picks: '' })
  expect(parseAction('2,4')).toEqual({ kind: 'attach', picks: '2,4' })
  expect(parseAction('clear')).toEqual({ kind: 'clear' })
  expect(parseAction('frobnicate')).toEqual({ kind: 'help' })

  expect(parsePicks('1 3', 10)).toEqual({ picks: [1, 3] })
  expect(parsePicks('3,1 3', 10)).toEqual({ picks: [3, 1] })
  expect(parsePicks('2-4', 10)).toEqual({ picks: [2, 3, 4] })
  expect(parsePicks('11', 10)).toEqual({ error: 'There is no file 11; the list has 10.' })
  expect(parsePicks('0', 10)).toEqual({ error: 'There is no file 0; the list has 10.' })
  expect(parsePicks('two', 10)).toEqual({ error: '"two" is not a file number.' })
  expect(parsePicks('4-2', 10)).toEqual({ error: '"4-2" is not a range from low to high.' })
  expect('error' in parsePicks('', 10)).toBe(true)
})

test('marks, ordering and comparison', () => {
  const marks = [
    { name: 'gone.pdf', mtimeMs: START - 1 },
    { name: 'kept.pdf', mtimeMs: START + MIN },
    { name: 'aged.pdf', mtimeMs: START + MIN },
  ]
  expect(pruneMarks(marks, START, START + MIN + 120 * MIN, 120 * MIN).map(mark => mark.name)).toEqual([
    'kept.pdf',
    'aged.pdf',
  ])
  expect(pruneMarks(marks, START, START + MIN + 120 * MIN + 1, 120 * MIN)).toEqual([])

  const a = drop('a.pdf', START + 2000)
  const b = drop('b.pdf', START + 1000)
  expect(names(byArrival([a, b]))).toEqual(['b.pdf', 'a.pdf'])
  expect(sameFiles([a, b], [drop('a.pdf', START + 2000), drop('b.pdf', START + 1000)])).toBe(true)
  expect(sameFiles([a, b], [a])).toBe(false)
  expect(sameFiles([a], [drop('a.pdf', START + 2000, 5)])).toBe(false)
})

test('an empty band beneath counts as nothing to keep', () => {
  expect(isBlankTree({ type: 'engine', ref: 0 })).toBe(true)
  expect(isBlankTree({ type: 'Box' })).toBe(true)
  expect(isBlankTree({ type: 'Box', children: [] })).toBe(true)
  expect(isBlankTree({ type: 'Box', children: ['repo-brief'] })).toBe(false)
  expect(isBlankTree({ type: 'Text', children: [] })).toBe(false)
})
