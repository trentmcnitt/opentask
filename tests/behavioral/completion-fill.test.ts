/**
 * `computeCompletionFill` — the dashboard's completion fill (§ITEM 2, Trent
 * 2026-09-23): a background fill behind the Today chip and each project chip,
 * proportional to done-today / (done-today + still-due-today), turning
 * "finished" (green + check) once nothing due today is left.
 */
import { describe, test, expect } from 'vitest'
import { computeCompletionFill } from '@/lib/completion-fill'

describe('computeCompletionFill', () => {
  test('null when done is undefined (no completion data yet)', () => {
    expect(computeCompletionFill(undefined, 3)).toBeNull()
  })

  test('null when remaining is undefined', () => {
    expect(computeCompletionFill(2, undefined)).toBeNull()
  })

  test('null when nothing is due today and nothing was done — no fill to show', () => {
    expect(computeCompletionFill(0, 0)).toBeNull()
  })

  test('partial progress: 1 done, 3 remaining is a 25% fraction, not finished', () => {
    const fill = computeCompletionFill(1, 3)
    expect(fill).toEqual({ fraction: 0.25, finished: false })
  })

  test('finished: everything due today is done', () => {
    const fill = computeCompletionFill(3, 0)
    expect(fill).toEqual({ fraction: 1, finished: true })
  })

  test('not finished when remaining is 0 but nothing was done either (nothing due today at all)', () => {
    // done=0, remaining=0 is covered above (null); this is the boundary where
    // remaining alone hitting 0 must NOT read as "finished" without any done work.
    expect(computeCompletionFill(0, 0)).toBeNull()
  })

  test('fraction is capped at 1 even if done somehow exceeds the total (defensive)', () => {
    const fill = computeCompletionFill(5, 0)
    expect(fill!.fraction).toBe(1)
    expect(fill!.finished).toBe(true)
  })

  test('fraction never goes negative for a negative done value (defensive)', () => {
    const fill = computeCompletionFill(-1, 2)
    expect(fill!.fraction).toBe(0)
  })
})
