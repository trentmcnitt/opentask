/**
 * The Tasks page's clock (src/lib/dashboard-clock.ts) and the Overdue
 * auto-clear rule.
 *
 * Bug (2026-09-27): two tasks crossed their due time while the dashboard was
 * open. The rows turned red, but the top bar's overdue pill, the pinned
 * Overdue chip and the jump button never appeared: their counts were memoized
 * on the task list and read "now" only when it changed. The fix advances one
 * `now` at exactly the instants an answer can change; these tests pin those
 * instants, and that a count computed at the tick sees the crossing.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MAX_TIMEOUT_MS,
  SOON_WINDOW_MS,
  clockTickDelay,
  nextClockTick,
  sameViewScope,
  shouldAutoClearOverdueFilter,
} from '@/lib/dashboard-clock'
import { countTasks } from '@/lib/task-counts'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
// Thursday 2026-01-15, 19:00 Chicago (01:00 UTC on the 16th).
const NOW = new Date('2026-01-16T01:00:00Z')
// The next local midnight: 2026-01-16 00:00 Chicago = 06:00 UTC.
const MIDNIGHT = new Date('2026-01-16T06:00:00Z')

type ClockTask = Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>
const due = (iso: string | null, extra: Partial<ClockTask> = {}): ClockTask => ({
  due_at: iso,
  progress_target: 1,
  is_tracked: false,
  ...extra,
})
const at = (ms: number) => new Date(ms).toISOString()

describe('nextClockTick', () => {
  test('with nothing due, wakes at the next local midnight (day buckets roll over)', () => {
    expect(nextClockTick([], NOW, TZ)).toEqual(MIDNIGHT)
    expect(nextClockTick([due(null)], NOW, TZ)).toEqual(MIDNIGHT)
  })

  test('wakes 1ms AFTER the earliest future due time — isOverdue is strict', () => {
    const in30m = NOW.getTime() + 30 * 60_000
    const in60m = NOW.getTime() + 60 * 60_000
    // Both are already inside the Soon window, so only the overdue crossings remain.
    const tick = nextClockTick([due(at(in60m)), due(at(in30m))], NOW, TZ)
    expect(tick.getTime()).toBe(in30m + 1)
  })

  test('a task sitting exactly at its due instant is picked up 1ms later, not at midnight', () => {
    // Fake timers land exactly on the scheduled instant: at `due`, the task is
    // not yet overdue, so the next tick must still be for it.
    const tick = nextClockTick([due(at(NOW.getTime()))], NOW, TZ)
    expect(tick.getTime()).toBe(NOW.getTime() + 1)
  })

  test('wakes when a task enters the Soon window (due within 2h)', () => {
    const in3h = NOW.getTime() + 3 * 60 * 60_000
    const tick = nextClockTick([due(at(in3h))], NOW, TZ)
    expect(tick.getTime()).toBe(in3h - SOON_WINDOW_MS + 1)
  })

  test('ignores past-due tasks (already overdue) and quotas (never late)', () => {
    const past = due(at(NOW.getTime() - 60_000))
    const quota = due(at(NOW.getTime() + 60_000), { progress_target: 3, is_tracked: true })
    expect(nextClockTick([past, quota], NOW, TZ)).toEqual(MIDNIGHT)
  })

  test('a due time after midnight does not delay the midnight tick', () => {
    const tomorrowNoon = new Date('2026-01-16T18:00:00Z')
    expect(nextClockTick([due(tomorrowNoon.toISOString())], NOW, TZ)).toEqual(MIDNIGHT)
  })

  test('is always strictly after now', () => {
    const tasks = [due(at(NOW.getTime())), due(at(NOW.getTime() - 1)), due(null)]
    expect(nextClockTick(tasks, NOW, TZ).getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe('clockTickDelay', () => {
  test('is the distance to the target', () => {
    expect(clockTickDelay(new Date(NOW.getTime() + 1234), NOW)).toBe(1234)
  })

  test('clamps to the setTimeout maximum (larger delays fire immediately)', () => {
    const far = new Date(NOW.getTime() + 40 * 24 * 60 * 60_000)
    expect(clockTickDelay(far, NOW)).toBe(MAX_TIMEOUT_MS)
  })

  test('never goes negative', () => {
    expect(clockTickDelay(new Date(NOW.getTime() - 5000), NOW)).toBe(0)
  })
})

describe('a count recomputed at the tick sees the crossing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('the scheduled timeout fires once the due time has passed, and the task counts as overdue', () => {
    const tasks = [due(at(NOW.getTime() + 60_000))]
    expect(countTasks(tasks, TZ, new Date()).overdue).toBe(0)

    // What useDashboardNow does: one timeout for the next tick, then re-read the clock.
    let ticked: Date | null = null
    const target = nextClockTick(tasks, new Date(), TZ)
    setTimeout(() => (ticked = new Date()), clockTickDelay(target, new Date()))

    vi.advanceTimersByTime(60_000)
    expect(ticked).toBeNull() // at exactly `due`: not yet
    vi.advanceTimersByTime(1)
    expect(ticked).not.toBeNull()
    expect(countTasks(tasks, TZ, ticked!).overdue).toBe(1)
  })
})

describe('shouldAutoClearOverdueFilter', () => {
  test('clears on the transition from some overdue to none while the filter is on', () => {
    expect(shouldAutoClearOverdueFilter(2, 0, true)).toBe(true)
    expect(shouldAutoClearOverdueFilter(1, 0, true)).toBe(true)
  })

  test('leaves the filter alone while overdue tasks remain', () => {
    expect(shouldAutoClearOverdueFilter(3, 2, true)).toBe(false)
    expect(shouldAutoClearOverdueFilter(0, 1, true)).toBe(false)
  })

  test('never fights a deliberate selection with nothing overdue (0 → 0, e.g. a deep link)', () => {
    expect(shouldAutoClearOverdueFilter(null, 0, true)).toBe(false)
    expect(shouldAutoClearOverdueFilter(0, 0, true)).toBe(false)
  })

  test('does nothing when the Overdue filter is not selected', () => {
    expect(shouldAutoClearOverdueFilter(2, 0, false)).toBe(false)
  })
})

describe('sameViewScope', () => {
  test('the same criteria object, search and grouping: the same view', () => {
    const criteria = { selectedProjects: [1] }
    expect(sameViewScope([criteria, null, 'slot'], [criteria, null, 'slot'])).toBe(true)
  })

  test('a new criteria object (a filter changed), a search or a grouping: a new view', () => {
    const criteria = { selectedProjects: [1] }
    expect(sameViewScope([criteria, null, 'slot'], [{ ...criteria }, null, 'slot'])).toBe(false)
    expect(sameViewScope([criteria, null, 'slot'], [criteria, 'query', 'slot'])).toBe(false)
    expect(sameViewScope([criteria, null, 'slot'], [criteria, null, 'recent'])).toBe(false)
  })
})
