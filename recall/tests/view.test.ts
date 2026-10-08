import { describe, expect, test } from 'claude-code/testing'

import { asHit } from '../hooks/format'
import { bySession } from '../hooks/view'

const hit = (ref: string, session: string | null, source = 'claude') => asHit({ ref, session, source, kind: 'memory', snippet: ref })

describe('bySession', () => {
  test('hits by session in the order of their best; a hit from no session stands alone', () => {
    const groups = bySession([hit('d1', 's1'), hit('d2', null, 'memory'), hit('d3', 's2'), hit('d4', 's1'), hit('d5', null, 'memory')])
    expect(groups.map(group => group.map(one => one.ref))).toEqual([['d1', 'd4'], ['d2'], ['d3'], ['d5']])
  })

  test('the same id from two sources is two sessions', () => {
    expect(bySession([hit('d1', 'x', 'claude'), hit('d2', 'x', 'codex')])).toHaveLength(2)
  })
})
