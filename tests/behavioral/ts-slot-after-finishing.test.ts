/**
 * The Reminders pager moving on after a slot is finished (Trent, 2026-09-22,
 * refined 2026-09-23 to "the earliest undone"). Pure index arithmetic — the
 * panel supplies which slot was just finished and which one the clock is in.
 */
import { describe, expect, test } from 'vitest'
import { slotAfterFinishing } from '@/lib/time-slot-assign'

/** Slots by how many reminders are still waiting in each. */
const day = (...waiting: number[]) => waiting.map((n) => ({ reminders: Array(n).fill(0) }))

describe('slotAfterFinishing', () => {
  test('finishing the current slot goes back to the earliest undone one', () => {
    // early morning (3 left), morning (just finished, and it is morning now)
    expect(slotAfterFinishing(day(3, 0, 2, 1), 1, 1)).toBe(0)
  })

  test('finishing a past slot goes to the earliest undone, not just the next one', () => {
    // it is evening; early morning still waits; morning just finished
    expect(slotAfterFinishing(day(2, 0, 0, 1, 3), 1, 4)).toBe(0)
    // everything before is done: the next undone after it
    expect(slotAfterFinishing(day(0, 0, 2, 1, 3), 1, 4)).toBe(2)
  })

  test('everything up to now done: a finished past slot lands on the current one', () => {
    expect(slotAfterFinishing(day(0, 0, 0, 0, 0), 0, 4)).toBe(4)
  })

  test('everything up to now done and the current slot finished: stay put', () => {
    expect(slotAfterFinishing(day(0, 0, 0), 2, 2)).toBeNull()
  })

  test('never a slot that has not started', () => {
    expect(slotAfterFinishing(day(0, 0, 0, 5), 1, 2)).toBe(2)
    expect(slotAfterFinishing(day(0, 0, 0, 5), 2, 2)).toBeNull()
  })
})
