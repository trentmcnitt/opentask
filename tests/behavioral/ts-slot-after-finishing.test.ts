/**
 * The Reminders pager moving on after a past slot is finished (Trent,
 * 2026-09-22). Pure index arithmetic — the panel supplies which slot was just
 * finished and which one the clock is in.
 */
import { describe, expect, test } from 'vitest'
import { slotAfterFinishing } from '@/lib/time-slot-assign'

/** Slots by how many reminders are still waiting in each. */
const day = (...waiting: number[]) => waiting.map((n) => ({ reminders: Array(n).fill(0) }))

describe('slotAfterFinishing', () => {
  test('a past slot finished: the next one after it with something waiting', () => {
    // early morning (just finished), morning (done), midday (2 left), afternoon, evening (now)
    expect(slotAfterFinishing(day(0, 0, 2, 1, 3), 0, 4)).toBe(2)
  })

  test('everything between is done: the slot the day is in', () => {
    expect(slotAfterFinishing(day(0, 0, 0, 0, 3), 0, 4)).toBe(4)
    // …even when that one is finished too — it is where the pager opens anyway.
    expect(slotAfterFinishing(day(0, 0, 0), 0, 2)).toBe(2)
  })

  test('never past the slot the day is in: a slot that has not started is not due', () => {
    expect(slotAfterFinishing(day(0, 0, 0, 5), 0, 2)).toBe(2)
  })

  test('finishing the current slot, or a later one, stays put', () => {
    expect(slotAfterFinishing(day(1, 0, 2), 1, 1)).toBeNull()
    expect(slotAfterFinishing(day(1, 0, 0), 2, 1)).toBeNull()
  })
})
