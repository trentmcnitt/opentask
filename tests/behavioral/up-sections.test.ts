/**
 * UP-120+: Upcoming's two sections ON THE WEB (2026-10-25, the Upcoming split
 * PR B; docs/TASK-MODEL.md § Upcoming) — the pure pieces the page draws with:
 * the split into Tomorrow then Later (`upcomingSections`), the row cap across
 * both (`capAcrossSections`), a Tomorrow row's time-only meta (`upcomingGap`
 * with a section), and the section words.
 *
 * UP-116: the late-night order the server sends (PR A lacked it) — with the
 * day starting at 03:00, a Tomorrow target at 02:00 (yesterday's OpenTask
 * day, by the calendar the day after) still sorts before a Later deck row
 * whose anchor instant is EARLIER: only the section rank puts it first.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import { deckTasks } from '@/core/tasks/deck'
import { getTaskSegments } from '@/core/tasks/task-segments'
import { updatePreferences } from '@/core/users/preferences'
import { upcomingGap, type SegmentState, type UpcomingSection } from '@/lib/task-segments'
import { capAcrossSections, upcomingSections } from '@/lib/upcoming-sections'
import { UPCOMING_SECTION_TITLES } from '@/lib/task-model-words'
import type { SegmentRow } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const tz = TEST_TIMEZONE

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}

function row(id: number, state: SegmentState, section?: UpcomingSection): SegmentRow {
  return {
    task: { id } as Task,
    state,
    recurring: false,
    ...(section ? { section } : {}),
  }
}

describe('Upcoming sections on the web (pure)', () => {
  test('UP-120: Tomorrow first, then Later; waiting and handled apart; counts per section', () => {
    const rows = [
      row(1, 'waiting', 'tomorrow'),
      row(2, 'considered', 'tomorrow'),
      row(3, 'waiting', 'later'),
      row(4, 'deferred', 'later'),
      row(5, 'waiting', 'later'),
    ]
    const [tomorrow, later] = upcomingSections(rows)
    expect(tomorrow.section).toBe('tomorrow')
    expect(tomorrow.waiting.map((r) => r.task.id)).toEqual([1])
    expect(tomorrow.handled.map((r) => r.task.id)).toEqual([2])
    expect(tomorrow.counts).toEqual({ handled: 1, total: 2 })
    expect(tomorrow.empty).toBe(false)
    expect(later.section).toBe('later')
    expect(later.waiting.map((r) => r.task.id)).toEqual([3, 5])
    expect(later.handled.map((r) => r.task.id)).toEqual([4])
    expect(later.counts).toEqual({ handled: 1, total: 3 })
  })

  test('UP-121: both sections always come back; an empty one is empty (Nothing today ✓)', () => {
    const none = upcomingSections([])
    expect(none.map((s) => [s.section, s.empty, s.counts.total])).toEqual([
      ['tomorrow', true, 0],
      ['later', true, 0],
    ])
    // All handled is not empty: "1 of 1 ✓", its considered row behind the toggle.
    const [tomorrow, later] = upcomingSections([row(7, 'considered', 'later')])
    expect(tomorrow.empty).toBe(true)
    expect(later.empty).toBe(false)
    expect(later.waiting).toEqual([])
    expect(later.counts).toEqual({ handled: 1, total: 1 })
  })

  test('UP-122: a row with no section reads as Later', () => {
    const [tomorrow, later] = upcomingSections([row(9, 'waiting')])
    expect(tomorrow.empty).toBe(true)
    expect(later.waiting.map((r) => r.task.id)).toEqual([9])
  })

  test('UP-123: the row cap is one budget across both sections, Tomorrow first', () => {
    const rows = [
      ...[1, 2, 3].map((id) => row(id, 'waiting', 'tomorrow')),
      ...[4, 5, 6, 7].map((id) => row(id, 'waiting', 'later')),
    ]
    const sections = upcomingSections(rows)
    expect(capAcrossSections(sections, 5)).toEqual([
      { visible: 3, offset: 0 },
      { visible: 2, offset: 3 },
    ])
    expect(capAcrossSections(sections, 2)).toEqual([
      { visible: 2, offset: 0 },
      { visible: 0, offset: 3 },
    ])
    expect(capAcrossSections(sections, null)).toEqual([
      { visible: 3, offset: 0 },
      { visible: 4, offset: 3 },
    ])
  })

  test('UP-124: a Tomorrow row says only the time ("Target 9:00 AM") — a deck "On deck tomorrow"; Later says the day', () => {
    const t = { due_at: at('2026-11-03T09:00'), deadline_at: at('2026-11-07T23:59') }
    expect(upcomingGap(t, tz, CALENDAR_DAY_START, 'tomorrow')).toEqual({
      target: 'Target 9:00 AM',
      deadline: 'deadline Sat Nov 7',
    })
    expect(upcomingGap(t, tz, CALENDAR_DAY_START, 'later')).toEqual({
      target: 'Target Tue Nov 3',
      deadline: 'deadline Sat Nov 7',
    })
    const deck = { due_at: null, deadline_at: null, on_deck_day: '2026-10-31' }
    // A deck has no time to say: its day, "tomorrow" (2026-10-27).
    expect(upcomingGap(deck, tz, CALENDAR_DAY_START, 'tomorrow').target).toBe('On deck tomorrow')
    expect(upcomingGap(deck, tz, CALENDAR_DAY_START, 'later').target).toBe('On deck Sat Oct 31')
    expect(upcomingGap(deck, tz, CALENDAR_DAY_START).target).toBe('On deck Sat Oct 31')
  })

  test('UP-125: the section words', () => {
    expect(UPCOMING_SECTION_TITLES).toEqual({ tomorrow: 'Tomorrow', later: 'Later' })
  })
})

describe('UP-116: the late-night order (day start 03:00)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(at('2026-10-20T12:00')))
    setupTestDb()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    updatePreferences(TEST_USER_ID, { day_start_time: '03:00', day_start_slot_id: null })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    teardownTestDb()
  })

  test('UP-116: a Tomorrow target at 02:00 sorts before a Later deck whose anchor instant is earlier', () => {
    const u = { userId: TEST_USER_ID, userTimezone: tz }
    // Today is Tue Oct 20 (OpenTask day). Thu Oct 22 02:00 is WEDNESDAY's
    // OpenTask day (the day starts at 03:00), so its Tomorrow is today.
    const late = createTask({
      ...u,
      input: { title: 'Synthetic late target', due_at: at('2026-10-22T02:00') },
    })
    // On deck Thu Oct 22 (anchor: local midnight, BEFORE 02:00), lead 2 →
    // Later on Tue Oct 20 = today; set yesterday so the day after set is ≤ it.
    const decked = createTask({ ...u, input: { title: 'Synthetic deck', lead_days: 2 } })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [decked.id], day: '2026-10-22' })
    const stamp = getDb().prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
    stamp.run(at('2026-10-10T12:00'), late.id)
    stamp.run(at('2026-10-19T12:00'), decked.id)

    const seg = getTaskSegments(TEST_USER_ID, tz, new Date(), { deckRows: true }).find(
      (s) => s.horizon === 'upcoming',
    )!
    const ours = seg.tasks.filter((r) => r.task.id === late.id || r.task.id === decked.id)
    expect(ours.map((r) => [r.task.id, r.section])).toEqual([
      [late.id, 'tomorrow'],
      [decked.id, 'later'],
    ])
    // By anchor instant alone the deck (local midnight Oct 22) would come
    // first: the target is 02:00 that calendar day.
    expect(ours[1].task.on_deck_day).toBe('2026-10-22')
    expect(Date.parse(at('2026-10-22T00:00'))).toBeLessThan(Date.parse(ours[0].task.due_at!))
  })
})
