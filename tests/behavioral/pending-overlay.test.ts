/**
 * The retirement rule for optimistic changes (src/lib/pending-overlay.ts,
 * 2026-10-26): a tap's change is drawn until a payload requested AFTER its
 * write answered is on screen — never dropped against an older payload.
 */
import { describe, expect, it } from 'vitest'
import {
  activePending,
  addPending,
  dropPending,
  nextPendingToken,
  settlePending,
  type PendingMap,
} from '@/lib/pending-overlay'
import { createLatestRequestGuard } from '@/lib/refresh-guards'

const empty = (): PendingMap<number, string> => new Map()

describe('pending overlay', () => {
  it('draws a change while its write is out, whatever payload is on screen', () => {
    const t = nextPendingToken()
    const map = addPending(empty(), [1], 'considered', t)
    expect(activePending(map, 0).get(1)).toBe('considered')
    expect(activePending(map, 99).get(1)).toBe('considered')
  })

  it('keeps it after the write answers until a payload requested after that lands', () => {
    const guard = createLatestRequestGuard()
    const before = guard.begin() // a refresh out before the tap answered
    const t = nextPendingToken()
    let map: PendingMap<number, string> = addPending(empty(), [1], 'considered', t)
    map = settlePending(map, [1], t, guard.latest())
    // The older payload lands: it predates the write, so the change stays.
    expect(activePending(map, before).get(1)).toBe('considered')
    // The refresh the answer started: it includes the write, so it retires.
    const after = guard.begin()
    expect(activePending(map, after).has(1)).toBe(false)
  })

  it('the burst: no tap is dropped against the payload from before the burst', () => {
    const guard = createLatestRequestGuard()
    const beforeBurst = guard.begin()
    let map: PendingMap<number, string> = empty()
    const tokens = [1, 2, 3].map((id) => {
      const t = nextPendingToken()
      map = addPending(map, [id], 'considered', t)
      return t
    })
    // Each answer starts a refresh; each is superseded by the next, so the
    // payload on screen is still the one from before the burst.
    ;[1, 2, 3].forEach((id, i) => {
      map = settlePending(map, [id], tokens[i], guard.latest())
      guard.begin()
    })
    expect([...activePending(map, beforeBurst).keys()]).toEqual([1, 2, 3])
    // The last refresh lands: every change is in it.
    expect(activePending(map, guard.latest()).size).toBe(0)
  })

  it('a failed write drops its change at once', () => {
    const t = nextPendingToken()
    const map = dropPending(addPending(empty(), [1, 2], 'gone', t), [1, 2], t)
    expect(map.size).toBe(0)
  })

  it("a later tap on the same row is not settled or dropped by an earlier tap's answer", () => {
    const first = nextPendingToken()
    const second = nextPendingToken()
    let map: PendingMap<number, string> = addPending(empty(), [1], 'considered', first)
    map = addPending(map, [1], 'waiting', second) // put back
    map = settlePending(map, [1], first, 5)
    expect(map.get(1)?.settledAt).toBeNull()
    map = dropPending(map, [1], first)
    expect(activePending(map, 99).get(1)).toBe('waiting')
  })

  it('takes a value per id', () => {
    const t = nextPendingToken()
    const map = addPending(empty(), [1, 2], (id) => (id === 1 ? 'a' : 'b'), t)
    expect([...activePending(map, 0).values()]).toEqual(['a', 'b'])
  })
})
