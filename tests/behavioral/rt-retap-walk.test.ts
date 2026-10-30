/**
 * The tab's re-tap walk (2026-10-29, src/lib/retap-walk.ts): which stop a
 * re-tap goes to next.
 */
import { describe, expect, test } from 'vitest'
import { retapOrder, stepWalk, taskGroupNeedsYou, type WalkState } from '@/lib/retap-walk'

const NOW = new Date('2026-01-15T16:00:00Z')
const past = '2026-01-15T14:00:00Z'
const later = '2026-01-15T20:00:00Z'

describe('retapOrder: one period, then one task segment (Trent’s final rule)', () => {
  // Periods 0..3 (the clock in 2), then segments 4..6.
  test('RT-01: the clock’s period while it waits, then the topmost waiting segment', () => {
    expect(retapOrder([2, 0, 3, 5, 1, 0, 4], 4, 2)).toEqual([2, 4])
  })

  test('RT-02: the clock’s period finished: the earliest unfinished started one', () => {
    expect(retapOrder([1, 2, 0, 0, 0, 3], 4, 2)).toEqual([0, 5])
  })

  test('RT-03: a period that has not started is never a stop', () => {
    expect(retapOrder([0, 0, 0, 5, 1], 4, 2)).toEqual([4])
  })

  test('RT-04: no segment waiting: the period alone; nothing at all: no stops', () => {
    expect(retapOrder([0, 2, 0, 0], 2, 1)).toEqual([1])
    expect(retapOrder([0, 0, 0, 0], 2, 1)).toEqual([])
  })
})

describe('stepWalk: the cycle', () => {
  test('RT-10: stop 1, stop 2, …, then the top, then stop 1 again', () => {
    let state: WalkState = { kind: 'start' }
    const goes: (number | 'top')[] = []
    for (let i = 0; i < 5; i++) {
      const step = stepWalk(state, 2)
      goes.push(step.go)
      state = step.next
    }
    expect(goes).toEqual([0, 1, 'top', 0, 1])
  })

  test('RT-11: a scroll by hand: the next tap goes to the top, the one after to stop 1', () => {
    const top = stepWalk({ kind: 'hand' }, 3)
    expect(top.go).toBe('top')
    expect(stepWalk(top.next, 3).go).toBe(0)
  })

  test('RT-12: nothing needs you: every tap is the top', () => {
    expect(stepWalk({ kind: 'start' }, 0).go).toBe('top')
    expect(stepWalk({ kind: 'at', at: 1 }, 0).go).toBe('top')
  })
})

describe('taskGroupNeedsYou', () => {
  const t = (due_at: string | null) => ({ due_at, progress_target: 1, is_tracked: false })

  test('RT-30: Late and On deck whenever they have rows', () => {
    expect(taskGroupNeedsYou('late', [t(past)], NOW)).toBe(true)
    expect(taskGroupNeedsYou('on-deck', [t(null)], NOW)).toBe(true)
    expect(taskGroupNeedsYou('on-deck', [], NOW)).toBe(false)
  })

  test('RT-31: any other group while one of its rows is over target', () => {
    expect(taskGroupNeedsYou('today', [t(later), t(past)], NOW)).toBe(true)
    expect(taskGroupNeedsYou('today', [t(later)], NOW)).toBe(false)
    expect(taskGroupNeedsYou(undefined, [t(null)], NOW)).toBe(false)
  })
})
