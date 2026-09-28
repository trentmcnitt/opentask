/**
 * Just-added previews (`src/lib/just-added.ts`): for 10 minutes after a task
 * is created, a read-only preview of it sits at the top of the dashboard's
 * Inbox (or list), newest first, unless its real row is already right there.
 * Pure selection logic, frozen clock.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  JUST_ADDED_WINDOW_MS,
  formatJustAddedBadge,
  isJustAdded,
  nextJustAddedExpiry,
  selectJustAddedPreviews,
  selectJustAddedTasks,
} from '@/lib/just-added'
import type { Task } from '@/types'

// Jan 15, 2026 at 10am Chicago.
const NOW = new Date('2026-01-15T16:00:00Z').getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

function makeTask(overrides: Partial<Task> & { id: number; created_at: string }): Task {
  return {
    user_id: 1,
    project_id: 1,
    title: `Task ${overrides.id}`,
    done: false,
    done_at: null,
    progress_target: 1,
    is_reminder: false,
    is_tracked: false,
    progress_period_start: null,
    quota_prompt_config: null,
    quota_day_state: null,
    progress_current: 0,
    skip_count: 0,
    priority: 0,
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    anchor_dow: null,
    anchor_dom: null,
    original_title: null,
    short_title: null,
    original_due_at: null,
    last_notified_at: null,
    last_critical_alert_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    completion_count: 0,
    snooze_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    notes: null,
    updated_at: overrides.created_at,
    ...overrides,
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isJustAdded', () => {
  test('the window is 10 minutes, and exactly 10 minutes old is out', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(0) }), NOW)).toBe(true)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(9 * MIN + 59_000) }), NOW)).toBe(true)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(10 * MIN) }), NOW)).toBe(false)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(HOUR) }), NOW)).toBe(false)
  })

  test('a created_at a little ahead of this clock (server/client skew) is in', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(-5000) }), NOW)).toBe(true)
  })

  test('an unparseable created_at is never pinned', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: 'garbage' }), NOW)).toBe(false)
  })
})

describe('nextJustAddedExpiry', () => {
  test('is the earliest moment a task in the window turns 10 minutes old', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(2 * MIN) }),
      makeTask({ id: 2, created_at: ago(7 * MIN) }), // ages out first, in 3 minutes
      makeTask({ id: 3, created_at: ago(HOUR) }), // already out — no timer for it
    ]
    expect(nextJustAddedExpiry(tasks, NOW)).toBe(NOW + 3 * MIN)
  })

  test('null when nothing is in the window, so no timer is scheduled', () => {
    expect(nextJustAddedExpiry([makeTask({ id: 1, created_at: ago(HOUR) })], NOW)).toBeNull()
    expect(nextJustAddedExpiry([], NOW)).toBeNull()
  })

  test('advancing to each expiry walks the tasks out one by one', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(1 * MIN) }),
      makeTask({ id: 2, created_at: ago(4 * MIN) }),
    ]
    const first = nextJustAddedExpiry(tasks, NOW)!
    expect(first).toBe(NOW + 6 * MIN)
    expect(tasks.filter((t) => isJustAdded(t, first)).map((t) => t.id)).toEqual([1])
    const second = nextJustAddedExpiry(tasks, first)!
    expect(second).toBe(NOW + 9 * MIN)
    expect(tasks.filter((t) => isJustAdded(t, second))).toEqual([])
    expect(nextJustAddedExpiry(tasks, second)).toBeNull()
    expect(first).toBe(Date.parse(tasks[1].created_at) + JUST_ADDED_WINDOW_MS)
  })
})

describe('selectJustAddedTasks', () => {
  test('only the window, newest first; a same-second tie goes to the higher id', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(HOUR) }),
      makeTask({ id: 2, created_at: ago(5 * MIN) }),
      makeTask({ id: 3, created_at: ago(MIN) }),
      makeTask({ id: 4, created_at: ago(MIN) }),
      makeTask({ id: 5, created_at: ago(11 * MIN) }),
    ]
    expect(selectJustAddedTasks(tasks, NOW).map((t) => t.id)).toEqual([4, 3, 2])
  })
})

describe('selectJustAddedPreviews', () => {
  const old = (id: number) => makeTask({ id, created_at: ago(HOUR) })
  const fresh = (id: number, minutesAgo: number) =>
    makeTask({ id, created_at: ago(minutesAgo * MIN) })

  test('every new task gets a preview when none of them is already on top', () => {
    const a = fresh(8, 1)
    const b = fresh(9, 2)
    const hostRows = [old(1), a, old(2), b]
    expect(selectJustAddedPreviews([old(1), a, old(2), b], hostRows, NOW).map((t) => t.id)).toEqual(
      [8, 9],
    )
  })

  test('no preview for a new task whose real row already tops the host', () => {
    const a = fresh(8, 1)
    const source = [a, old(1)]
    expect(selectJustAddedPreviews(source, [a, old(1)], NOW)).toEqual([])
  })

  test('the leading run of new rows is on top; a new row below an old one is not', () => {
    const a = fresh(7, 1)
    const b = fresh(8, 2)
    const c = fresh(9, 3)
    const hostRows = [b, a, old(1), c]
    expect(selectJustAddedPreviews([a, b, c, old(1)], hostRows, NOW).map((t) => t.id)).toEqual([9])
  })

  test('a new task outside the host (another project, or not in this view) is previewed', () => {
    const elsewhere = fresh(9, 1)
    expect(selectJustAddedPreviews([elsewhere], [old(1)], NOW).map((t) => t.id)).toEqual([9])
    // No host rows at all (folded, empty or absent host): everything new is previewed.
    expect(selectJustAddedPreviews([elsewhere], [], NOW).map((t) => t.id)).toEqual([9])
  })

  test('previews leave at 10 minutes', () => {
    const a = fresh(9, 1)
    const later = nextJustAddedExpiry([a], NOW)!
    expect(selectJustAddedPreviews([a], [], later)).toEqual([])
  })
})

describe('formatJustAddedBadge', () => {
  test('"just now" under a minute, whole minutes after', () => {
    expect(formatJustAddedBadge(makeTask({ id: 1, created_at: ago(20_000) }), NOW)).toBe(
      'New · just now',
    )
    expect(formatJustAddedBadge(makeTask({ id: 1, created_at: ago(3 * MIN + 40_000) }), NOW)).toBe(
      'New · 3m',
    )
    // Skew: a created_at ahead of this clock is "just now", never negative.
    expect(formatJustAddedBadge(makeTask({ id: 1, created_at: ago(-5000) }), NOW)).toBe(
      'New · just now',
    )
  })
})
