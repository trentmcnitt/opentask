/**
 * The horizon done square (`src/lib/horizon-square.ts`): the looks, unset
 * following `UNSET_HORIZON`, which rows the horizon governs, and the whole-
 * pixel geometry.
 */
import { describe, expect, test } from 'vitest'
import {
  HORIZON_SQUARE_LOOKS,
  horizonGoverns,
  horizonSquareHint,
  horizonSquareLook,
  isPlainLook,
  squarePaths,
} from '@/lib/horizon-square'
import { UNSET_HORIZON } from '@/lib/task-segments'
import { HORIZON_LABELS } from '@/lib/task-model-words'
import type { Task } from '@/types'

const task = (overrides: Partial<Task> = {}) =>
  ({
    title: 't',
    rrule: null,
    is_reminder: false,
    is_tracked: false,
    progress_target: 1,
    due_at: null,
    target_auto: false,
    deadline_at: null,
    horizon: null,
    ...overrides,
  }) as Task

describe('the square names its horizon', () => {
  test('a set horizon: "Horizon: Weeks. Hold to change."', () => {
    expect(horizonSquareHint('weeks')).toBe('Horizon: Weeks. Hold to change.')
    expect(horizonSquareHint('eventually')).toBe('Horizon: Eventually. Hold to change.')
  })
  test('unset names what it reads as, UNSET_HORIZON', () => {
    const reads = HORIZON_LABELS[UNSET_HORIZON]
    expect(horizonSquareHint(null)).toBe(`Horizon: ${reads} (unset). Hold to change.`)
    expect(horizonSquareHint(undefined)).toBe(horizonSquareHint(null))
  })
})

describe('horizon square looks', () => {
  test('unset looks like whatever unset means: LOOKS[UNSET_HORIZON]', () => {
    expect(horizonSquareLook(null)).toBe(HORIZON_SQUARE_LOOKS[UNSET_HORIZON])
    expect(horizonSquareLook(undefined)).toBe(HORIZON_SQUARE_LOOKS[UNSET_HORIZON])
  })

  test('Days is the plain checkbox; the other horizons are patterned', () => {
    expect(isPlainLook(horizonSquareLook('days'))).toBe(true)
    for (const h of ['weeks', 'months', 'eventually'] as const) {
      expect(isPlainLook(horizonSquareLook(h))).toBe(false)
    }
  })

  test('every side pattern is whole pixels, sums to the 12px side and is symmetric', () => {
    for (const look of Object.values(HORIZON_SQUARE_LOOKS)) {
      if (!look.side) continue
      expect(look.side.every((n) => Number.isInteger(n))).toBe(true)
      expect(look.side.reduce((a, b) => a + b, 0)).toBe(12)
    }
    // Symmetric dashes (the gaps mirror around the middle).
    expect(HORIZON_SQUARE_LOOKS.months.side).toEqual([1, 3, 4, 3, 1])
    expect(HORIZON_SQUARE_LOOKS.weeks.side).toEqual([4, 4, 4])
  })

  test('the 1x stroke sits on half-pixel lines; dotted corners are whole pixels', () => {
    const one = squarePaths(HORIZON_SQUARE_LOOKS.weeks, 1)
    expect(one.sides[0]).toBe('M5 0.5H17')
    const dots = squarePaths(HORIZON_SQUARE_LOOKS.eventually, 1)
    expect(dots.arcs).toEqual([])
    expect(dots.dots.map((d) => [d.x, d.y, d.size])).toEqual([
      [1, 1, 1],
      [20, 1, 1],
      [20, 20, 1],
      [1, 20, 1],
    ])
  })
})

describe('horizonGoverns: the square shows the horizon', () => {
  // Trent, 2026-10-29: "the checkbox always reflects the horizon, regardless
  // of whether it has a target" — every plain one-off with no deadline.
  test('every one-off: targeted or not, deadline or not, decked or not', () => {
    expect(horizonGoverns(task())).toBe(true)
    expect(horizonGoverns(task({ horizon: 'months' }))).toBe(true)
    expect(horizonGoverns(task({ due_at: '2026-11-05T15:00:00Z' }))).toBe(true)
    expect(horizonGoverns(task({ due_at: '2026-11-05T15:00:00Z', target_auto: true }))).toBe(true)
    expect(horizonGoverns(task({ on_deck_day: '2026-11-05' }))).toBe(true)
    expect(horizonGoverns(task({ deadline_at: '2026-11-05T15:00:00Z' }))).toBe(true)
  })

  test('the SET horizon, never the effective one: a near deadline does not change the look', () => {
    const near = task({ horizon: 'months', deadline_at: '2026-11-01T15:00:00Z' })
    expect(horizonSquareLook(near.horizon)).toBe(HORIZON_SQUARE_LOOKS.months)
  })

  test('not a repeat, a reminder, a quota or a done task', () => {
    expect(horizonGoverns(task({ rrule: 'FREQ=WEEKLY' }))).toBe(false)
    expect(horizonGoverns(task({ is_reminder: true }))).toBe(false)
    expect(horizonGoverns(task({ is_tracked: true, progress_target: 3 }))).toBe(false)
    expect(horizonGoverns(task({ done: true }))).toBe(false)
  })
})
