/**
 * The Defer button with a selection: defer only ever moves a target LATER
 * (Trent, 2026-10-26). Pure — no DB, no HTTP. `splitSelectionDefer` decides
 * which selected tasks are sent; the two message helpers word the toast.
 */

import { describe, test, expect } from 'vitest'
import {
  nothingToDeferMessage,
  selectionHeldBackSuffix,
  splitSelectionDefer,
} from '@/lib/defer-selection'
import type { Task } from '@/types'

const UNTIL = '2026-10-26T23:00:00.000Z'

function task(id: number, due_at: string | null, priority = 1): Task {
  return { id, due_at, priority } as Task
}

describe('splitSelectionDefer', () => {
  test('sends only targets before the defer time; counts later and undated', () => {
    const overdue = task(1, '2026-10-25T15:00:00.000Z')
    const earlierToday = task(2, '2026-10-26T22:59:00.000Z')
    const high = task(3, '2026-10-24T15:00:00.000Z', 3)
    const tomorrow = task(4, '2026-10-27T15:00:00.000Z')
    const undated = task(5, null)
    const split = splitSelectionDefer([overdue, earlierToday, high, tomorrow, undated], UNTIL)
    expect(split.movers.map((t) => t.id)).toEqual([1, 2, 3])
    expect(split.later).toBe(1)
    expect(split.undated).toBe(1)
  })

  test('a target exactly at the defer time is already later (nothing would move)', () => {
    const split = splitSelectionDefer([task(1, UNTIL)], UNTIL)
    expect(split.movers).toEqual([])
    expect(split.later).toBe(1)
  })
})

describe('the toast wording', () => {
  test('suffix after the server line', () => {
    expect(selectionHeldBackSuffix({ later: 0, undated: 0 })).toBe('')
    expect(selectionHeldBackSuffix({ later: 1, undated: 0 })).toBe(' · 1 already later')
    expect(selectionHeldBackSuffix({ later: 2, undated: 1 })).toBe(
      ' · 2 already later · 1 has no target',
    )
    expect(selectionHeldBackSuffix({ later: 0, undated: 2 })).toBe(' · 2 have no target')
  })

  test('nothing to defer says why', () => {
    expect(nothingToDeferMessage({ later: 1, undated: 0 })).toBe(
      'Nothing to defer: 1 already later',
    )
    expect(nothingToDeferMessage({ later: 1, undated: 2 })).toBe(
      'Nothing to defer: 1 already later, 2 have no target',
    )
  })
})
