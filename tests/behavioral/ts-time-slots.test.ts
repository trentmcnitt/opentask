/**
 * Time Slot Behavioral Tests (TS-001 through TS-012)
 *
 * Covers REDESIGN-V03 §6.0. The assignment rule is "latest start_time <= the
 * item's time of day", with two consequences worth pinning: `anchor_time` wins
 * over `due_at` (§4.6 — a recurring item's due_at is only fresh while the user
 * keeps sweeping), and anything without a time of day lands in the un-slotted
 * group rather than disappearing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  listTimeSlots,
  seedDefaultTimeSlots,
  createTimeSlot,
  deleteTimeSlot,
  assignSlot,
  groupBySlot,
  itemTimeOfDayMinutes,
  parseHHMM,
  DEFAULT_TIME_SLOTS,
  type TimeSlot,
} from '@/core/time-slots'
import { ValidationError } from '@/core/errors'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { getDb } from '@/core/db'

/** Mirrors the startup backfill: install defaults for any user lacking slots. */
function backfillTimeSlotsForTest() {
  seedDefaultTimeSlots(TEST_USER_ID)
}

/** UTC ISO for a local wall-clock time today. */
function localUtc(hour: number, minute = 0): string {
  return DateTime.fromISO('2026-01-15T00:00:00', { zone: TEST_TIMEZONE })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

describe('Time Slots', () => {
  let slots: TimeSlot[]

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    slots = listTimeSlots(TEST_USER_ID)
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * TS-001: Users get the production-derived defaults, not an empty screen.
   */
  test('TS-001: default slots are seeded at user creation', () => {
    expect(slots).toHaveLength(DEFAULT_TIME_SLOTS.length)
    expect(slots.map((s) => s.start_time)).toEqual(['07:00', '09:00', '12:00', '16:00', '20:30'])
  })

  /**
   * TS-002: Re-seeding must not clobber boundaries the user has customised.
   */
  test('TS-002: seeding is idempotent and preserves customisation', () => {
    createTimeSlot(TEST_USER_ID, 'Night shift', '23:00', 99)
    seedDefaultTimeSlots(TEST_USER_ID)
    const after = listTimeSlots(TEST_USER_ID)
    expect(after).toHaveLength(DEFAULT_TIME_SLOTS.length + 1)
    expect(after.filter((s) => s.label === 'Early morning')).toHaveLength(1)
  })

  /**
   * TS-003: The core rule — latest boundary at or before the item's time.
   */
  test('TS-003: an item lands in the latest slot at or before its time', () => {
    const slot = assignSlot({ anchor_time: '13:30', due_at: null }, slots, TEST_TIMEZONE)
    expect(slot?.label).toBe('Midday')
  })

  /**
   * TS-004: Landing exactly on a boundary belongs to that slot, not the one
   * before it.
   */
  test('TS-004: an item exactly on a boundary joins that slot', () => {
    const slot = assignSlot({ anchor_time: '09:00', due_at: null }, slots, TEST_TIMEZONE)
    expect(slot?.label).toBe('Morning')
  })

  /**
   * TS-005: Earlier than every boundary means un-slotted, not "first slot".
   * Forcing it into Early morning would assert a life-moment the user never
   * defined.
   */
  test('TS-005: an item before the first boundary is un-slotted', () => {
    expect(assignSlot({ anchor_time: '05:00', due_at: null }, slots, TEST_TIMEZONE)).toBeNull()
  })

  /**
   * TS-006: Past the last boundary stays in the last slot.
   */
  test('TS-006: a late-night item stays in the last slot', () => {
    expect(assignSlot({ anchor_time: '23:45', due_at: null }, slots, TEST_TIMEZONE)?.label).toBe(
      'Evening',
    )
  })

  /**
   * TS-007: No time of day at all → un-slotted. These are mostly Track items,
   * and §7.3 requires they stay visible on the front door.
   */
  test('TS-007: an item with neither anchor_time nor due_at is un-slotted', () => {
    expect(assignSlot({ anchor_time: null, due_at: null }, slots, TEST_TIMEZONE)).toBeNull()
  })

  /**
   * TS-008: due_at is UTC and must be read through the user's timezone.
   * Reading its UTC hour directly would put a 07:00 Chicago task in the
   * afternoon — the exact bug this test exists to prevent.
   */
  test('TS-008: due_at is interpreted in the user timezone, not UTC', () => {
    const slot = assignSlot({ anchor_time: null, due_at: localUtc(7, 30) }, slots, TEST_TIMEZONE)
    expect(slot?.label).toBe('Early morning')
  })

  /**
   * TS-009: anchor_time wins over due_at. Per §4.6 a recurring item's due_at
   * drifts once the user stops sweeping, so the anchor is the intended time.
   */
  test('TS-009: anchor_time takes precedence over due_at', () => {
    const slot = assignSlot({ anchor_time: '07:15', due_at: localUtc(21, 0) }, slots, TEST_TIMEZONE)
    expect(slot?.label).toBe('Early morning')
  })

  /**
   * TS-010: Grouping keeps slot order and puts un-slotted items last.
   */
  test('TS-010: groupBySlot orders slots by time with un-slotted last', () => {
    const items = [
      { anchor_time: '21:00', due_at: null },
      { anchor_time: null, due_at: null },
      { anchor_time: '07:30', due_at: null },
    ]
    const groups = groupBySlot(items, slots, TEST_TIMEZONE)

    expect(groups[groups.length - 1].slot).toBeNull()
    expect(groups[groups.length - 1].items).toHaveLength(1)

    const morning = groups.find((g) => g.slot?.label === 'Early morning')
    expect(morning?.items).toHaveLength(1)
  })

  /**
   * TS-011: Empty slots are retained — a slot the user defined is part of how
   * they read their day, so the view's shape shouldn't change with the data.
   */
  test('TS-011: empty slots are still present in the grouping', () => {
    const groups = groupBySlot([{ anchor_time: '07:30', due_at: null }], slots, TEST_TIMEZONE)
    expect(groups).toHaveLength(slots.length + 1)
    expect(groups.filter((g) => g.items.length === 0).length).toBeGreaterThan(0)
  })

  /**
   * TS-012: Malformed boundaries are rejected at write time rather than
   * silently sorting to an arbitrary position later.
   */
  test('TS-012: an invalid start_time is rejected', () => {
    expect(() => createTimeSlot(TEST_USER_ID, 'Bad', '25:00')).toThrow(ValidationError)
    expect(() => createTimeSlot(TEST_USER_ID, 'Bad', 'morning')).toThrow(ValidationError)
    expect(parseHHMM('24:00')).toBeNull()
    expect(parseHHMM('09:60')).toBeNull()
    expect(parseHHMM('09:30')).toBe(570)
  })

  /**
   * TS-016: Users who existed before slots shipped get them via the startup
   * backfill. Without it their dashboard would put every item in the un-slotted
   * group, which reads as broken rather than empty.
   */
  test('TS-016: existing users are backfilled with default slots', () => {
    // Simulate a pre-existing user: delete their slots, then re-run init.
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    expect(listTimeSlots(TEST_USER_ID)).toHaveLength(0)

    backfillTimeSlotsForTest()
    expect(listTimeSlots(TEST_USER_ID)).toHaveLength(DEFAULT_TIME_SLOTS.length)
  })

  test('TS-013: deleting a slot removes it', () => {
    const slot = createTimeSlot(TEST_USER_ID, 'Temp', '22:00')
    expect(deleteTimeSlot(TEST_USER_ID, slot.id)).toBe(true)
    expect(listTimeSlots(TEST_USER_ID).find((s) => s.id === slot.id)).toBeUndefined()
  })

  test('TS-014: itemTimeOfDayMinutes falls back to due_at when anchor is absent', () => {
    expect(
      itemTimeOfDayMinutes({ anchor_time: null, due_at: localUtc(16, 45) }, TEST_TIMEZONE),
    ).toBe(16 * 60 + 45)
  })
})
