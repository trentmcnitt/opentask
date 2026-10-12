import { describe, expect, it } from 'vitest'
import { naturalPageIndex, pageAfterFinishing } from '@/lib/time-slot-assign'

/**
 * The dashboard reminders panel pages through the slots, then the task
 * segments (2026-10-11). `waiting` is each page's waiting count in pager
 * order; the first `slotCount` pages are slots.
 */
describe('naturalPageIndex', () => {
  it('opens on the natural slot while a slot up to now still waits', () => {
    // Slots 0..2, natural = 1; slot 0 still waits; a task segment waits too.
    expect(naturalPageIndex([2, 0, 3, 4], 3, 1)).toBe(1)
    // The natural slot itself waits.
    expect(naturalPageIndex([0, 1, 3, 4], 3, 1)).toBe(1)
  })

  it('opens on the first waiting task segment once the day so far is done', () => {
    // Slots 0..1 done, slot 2 is later (not counted), task pages 3 (done) and 4.
    expect(naturalPageIndex([0, 0, 5, 0, 2], 3, 1)).toBe(4)
  })

  it('stays on the natural slot when nothing waits anywhere', () => {
    expect(naturalPageIndex([0, 0, 0, 0], 3, 2)).toBe(2)
  })

  it('with no slots, opens on the first waiting task segment', () => {
    expect(naturalPageIndex([0, 3], 0, 0)).toBe(1)
    expect(naturalPageIndex([0, 0], 0, 0)).toBe(0)
  })
})

describe('pageAfterFinishing', () => {
  it('an earlier unfinished slot wins over a waiting task segment', () => {
    expect(pageAfterFinishing([1, 0, 0, 3], 3, 1, 1)).toBe(0)
  })

  it('finishing the day so far moves to the first waiting task segment', () => {
    expect(pageAfterFinishing([0, 0, 4, 3], 3, 1, 1)).toBe(3)
  })

  it('finishing a task segment moves to the next one still waiting', () => {
    expect(pageAfterFinishing([0, 0, 0, 2], 2, 2, 1)).toBe(3)
  })

  it('finishing a task segment with nothing else waiting stays put', () => {
    expect(pageAfterFinishing([0, 0, 0, 0], 2, 3, 1)).toBeNull()
  })

  it('a finished past slot with nothing waiting goes to the natural slot', () => {
    expect(pageAfterFinishing([0, 0, 0], 3, 0, 2)).toBe(2)
  })

  it('a later slot never counts as undone', () => {
    // Slot 2 is after the natural slot (1): not yet due, so skipped.
    expect(pageAfterFinishing([0, 0, 5], 3, 1, 1)).toBeNull()
  })
})
