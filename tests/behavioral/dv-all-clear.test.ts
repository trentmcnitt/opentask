/**
 * Today's all-clear card's lines (2026-10-30, `src/lib/modes/all-clear.ts`):
 * the "Next" line — the next period with picked targets, else tomorrow's
 * decks, else nothing — and the counts line.
 */
import { describe, test, expect } from 'vitest'
import { allClearCounts, allClearNext } from '@/lib/modes/all-clear'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
// Friday 2026-01-16, 9:00 PM Chicago.
const NOW = new Date('2026-01-17T03:00:00Z')
const ctx = { now: NOW, timezone: TZ, dayStart: '03:00' }
const chicago = (local: string) => new Date(`${local}-06:00`).toISOString()
const slot = (id: number, label: string, start_time: string) =>
  ({ id, label, start_time, user_id: 1, sort_order: id, created_at: '' }) as TimeSlot
const SLOTS = [slot(1, 'Morning', '08:30'), slot(2, 'Midday', '12:00'), slot(3, 'Evening', '18:00')]
let nextId = 1
const task = (fields: Partial<Task>) =>
  ({
    id: nextId++,
    done: false,
    is_reminder: false,
    is_tracked: false,
    progress_target: null,
    due_at: null,
    target_auto: false,
    on_deck_day: null,
    queue_mark: false,
    ...fields,
  }) as unknown as Task

describe('all-clear: the Next line', () => {
  test("tomorrow's first period with targets, and how many fall in it", () => {
    const tasks = [
      task({ due_at: chicago('2026-01-17T09:00') }),
      task({ due_at: chicago('2026-01-17T10:15') }),
      task({ due_at: chicago('2026-01-17T13:00') }),
    ]
    expect(allClearNext(tasks, SLOTS, ctx)).toBe('Morning, 8:30 AM · 2 targets')
  })
  test('a later day says its weekday; one target is singular', () => {
    const tasks = [task({ due_at: chicago('2026-01-19T12:30') })]
    expect(allClearNext(tasks, SLOTS, ctx)).toBe('Mon · Midday, 12:00 PM · 1 target')
  })
  test("automatic targets, reminders, quotas and done tasks don't count", () => {
    const tasks = [
      task({ due_at: chicago('2026-01-17T09:00'), target_auto: true }),
      task({ due_at: chicago('2026-01-17T09:00'), is_reminder: true }),
      task({ due_at: chicago('2026-01-17T09:00'), is_tracked: true }),
      task({ due_at: chicago('2026-01-17T09:00'), done: true }),
    ]
    expect(allClearNext(tasks, SLOTS, ctx)).toBeNull()
  })
  test('a queue-marked target is not one: the rollover pulls it, it never nags', () => {
    const marked = task({ due_at: chicago('2026-01-17T03:00'), queue_mark: true })
    expect(allClearNext([marked], SLOTS, ctx)).toBeNull()
    const real = task({ due_at: chicago('2026-01-17T09:00') })
    expect(allClearNext([marked, real], SLOTS, ctx)).toBe('Morning, 8:30 AM · 1 target')
  })
  test("no targets ahead: tomorrow's decks, else nothing", () => {
    const decks = [task({ on_deck_day: '2026-01-17' }), task({ on_deck_day: '2026-01-17' })]
    expect(allClearNext(decks, SLOTS, ctx)).toBe('on deck tomorrow · 2')
    expect(allClearNext([], SLOTS, ctx)).toBeNull()
  })
})

describe('all-clear: the counts line', () => {
  test('a zero part is left out; both zero, no line', () => {
    expect(allClearCounts({ done: 4, moved: 2 })).toBe('4 done · 2 moved to tomorrow')
    expect(allClearCounts({ done: 4, moved: 0 })).toBe('4 done')
    expect(allClearCounts({ done: 0, moved: 1 })).toBe('1 moved to tomorrow')
    expect(allClearCounts({ done: 0, moved: 0 })).toBeNull()
  })
})
