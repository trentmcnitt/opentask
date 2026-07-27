/**
 * Dashboard Slot View Tests (DV-001 through DV-009)
 *
 * Covers REDESIGN-V03 §7.3's grouping rules. The dashboard's own rendering is
 * E2E territory; what's pinned here is the pure grouping logic underneath it,
 * because that's where the failures are silent — an item quietly missing from
 * the front door looks identical to an empty day.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { groupBySlot, type TimeSlot } from '@/lib/time-slot-assign'
import { effectiveDueAt } from '@/core/recurrence/occurrence'

const TZ = 'America/Chicago'
const NOW = new Date('2026-01-15T16:00:00Z') // Thursday, 10:00 local

const SLOTS: TimeSlot[] = [
  { id: 1, user_id: 1, label: 'Early morning', start_time: '07:00', sort_order: 0, created_at: '' },
  { id: 2, user_id: 1, label: 'Before work', start_time: '09:00', sort_order: 1, created_at: '' },
  { id: 3, user_id: 1, label: 'Midday', start_time: '12:00', sort_order: 2, created_at: '' },
  { id: 4, user_id: 1, label: 'Evening', start_time: '20:30', sort_order: 3, created_at: '' },
]

function localIso(dayOffset: number, hour: number, minute = 0): string {
  return DateTime.fromISO('2026-01-15T00:00:00', { zone: TZ })
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

/** Mirrors groupByTimeSlot's today-filter in TaskList. */
function todaysOnly(
  items: { due_at: string | null; rrule: string | null; anchor_time: string | null }[],
) {
  const endOfToday = DateTime.fromJSDate(NOW).setZone(TZ).endOf('day').toJSDate()
  return items.filter((task) => {
    if (!task.due_at && !task.rrule) return true
    const effective = effectiveDueAt({ ...task, recurrence_mode: 'from_due' }, TZ, NOW)
    if (!effective) return false
    return effective.getTime() <= endOfToday.getTime()
  })
}

describe('Dashboard slot view', () => {
  beforeEach(() => vi.setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  /**
   * DV-001: Items land in the slot matching their time of day.
   */
  test('DV-001: tasks group into their time slot', () => {
    const items = [
      { anchor_time: '07:30', due_at: localIso(0, 7, 30), rrule: null },
      { anchor_time: '21:00', due_at: localIso(0, 21), rrule: null },
    ]
    const groups = groupBySlot(items, SLOTS, TZ)

    expect(groups.find((g) => g.slot?.label === 'Early morning')?.items).toHaveLength(1)
    expect(groups.find((g) => g.slot?.label === 'Evening')?.items).toHaveLength(1)
  })

  /**
   * DV-002: Un-slotted items go last, never dropped. §7.3 is explicit that
   * no-time-of-day items — mostly Track — must stay visible from the front door.
   */
  test('DV-002: items with no time of day land in the trailing un-slotted group', () => {
    const items = [
      { anchor_time: null, due_at: null, rrule: null },
      { anchor_time: '07:30', due_at: localIso(0, 7, 30), rrule: null },
    ]
    const groups = groupBySlot(items, SLOTS, TZ)
    const last = groups[groups.length - 1]

    expect(last.slot).toBeNull()
    expect(last.items).toHaveLength(1)
  })

  /**
   * DV-003: Slots keep chronological order regardless of input order.
   */
  test('DV-003: slots render in time order', () => {
    const groups = groupBySlot([], SLOTS, TZ)
    const labels = groups.filter((g) => g.slot).map((g) => g.slot!.label)
    expect(labels).toEqual(['Early morning', 'Before work', 'Midday', 'Evening'])
  })

  /**
   * DV-004: The front door is TODAY. A task due tomorrow is filtered out.
   */
  test('DV-004: tomorrow is excluded from the slot view', () => {
    const items = [
      { due_at: localIso(1, 9), rrule: null, anchor_time: null },
      { due_at: localIso(0, 9), rrule: null, anchor_time: null },
    ]
    expect(todaysOnly(items)).toHaveLength(1)
  })

  /**
   * DV-005: Overdue work still belongs to today — it's what "what now" means.
   */
  test('DV-005: overdue tasks remain in the today view', () => {
    const items = [{ due_at: localIso(-3, 9), rrule: null, anchor_time: null }]
    expect(todaysOnly(items)).toHaveLength(1)
  })

  /**
   * DV-006: A recurring item scheduled today appears even though its stored
   * due_at froze months ago — the §4.6 derivation, not raw due_at.
   */
  test('DV-006: a recurring task due today appears despite a stale due_at', () => {
    const items = [{ due_at: localIso(-90, 7), rrule: 'FREQ=DAILY', anchor_time: '07:00' }]
    expect(todaysOnly(items)).toHaveLength(1)
  })

  /**
   * DV-007: ...and one NOT scheduled today is absent, however stale it looks.
   * This is what stops the front door filling with items that aren't today's.
   */
  test('DV-007: a recurring task not scheduled today is excluded', () => {
    // Evaluated on a Thursday; recurs Mondays.
    const items = [
      { due_at: localIso(-60, 9), rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor_time: '09:00' },
    ]
    expect(todaysOnly(items)).toHaveLength(0)
  })

  /**
   * DV-008: Undated items are kept — they can't be "not today", and dropping
   * them would hide most Track items from the front door.
   */
  test('DV-008: undated items are kept in the today view', () => {
    const items = [{ due_at: null, rrule: null, anchor_time: null }]
    expect(todaysOnly(items)).toHaveLength(1)
  })

  /**
   * DV-009: Empty slots survive grouping — a slot the user defined is part of
   * how they read their day, so the view's shape follows their configuration
   * rather than the data.
   */
  test('DV-009: empty slots are retained when the day is not empty', () => {
    const groups = groupBySlot([{ anchor_time: '07:30', due_at: null }], SLOTS, TZ)
    expect(groups.filter((g) => g.slot).length).toBe(SLOTS.length)
  })
})
