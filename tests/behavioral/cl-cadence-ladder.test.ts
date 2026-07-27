/**
 * Cadence Ladder Tests (CL-001 through CL-008)
 *
 * Covers REDESIGN-V03 §4.1. Before this, P0/P1/P2 all fell through to a single
 * shared interval, which is a large part of why priority behaved as a binary
 * "matters" flag rather than a ladder. CL-002 and CL-003 are the rungs that
 * previously didn't exist.
 */

import { describe, test, expect } from 'vitest'
import { isNotificationBoundary } from '@/core/notifications/overdue-checker'
import { NOTIFICATION_THREADS, threadIdForPriority } from '@/core/notifications/apns'

const BASE = {
  id: 1,
  title: 'Test',
  due_at: '2026-01-15T10:00:00.000Z',
  effective_due_at: '2026-01-15T10:00:00.000Z',
  user_id: 1,
  auto_snooze_minutes: null,
  user_auto_snooze_minutes: 30,
  user_auto_snooze_urgent_minutes: 5,
  user_auto_snooze_high_minutes: 15,
  user_auto_snooze_low_minutes: 240,
  user_auto_snooze_medium_minutes: 60,
  critical_alert_volume: 1.0,
  rrule: null,
  recurrence_mode: 'from_due' as const,
  anchor_time: null,
  timezone: 'America/Chicago',
}

/** Does a task of this priority fire `minutes` after becoming due? */
function firesAt(priority: number, minutes: number): boolean {
  const now = new Date(new Date(BASE.effective_due_at).getTime() + minutes * 60_000)
  return isNotificationBoundary({ ...BASE, priority }, now)
}

describe('Cadence ladder', () => {
  /**
   * CL-001: P0 keeps 30 min. Unchanged deliberately — unset means nobody stated
   * a priority (L1), and per L2 silence fails dangerous, so an
   * urgent-but-unclassified item must still reach the user.
   */
  test('CL-001: P0 repeats every 30 minutes', () => {
    expect(firesAt(0, 30)).toBe(true)
    expect(firesAt(0, 60)).toBe(true)
    expect(firesAt(0, 45)).toBe(false)
  })

  /**
   * CL-002: P1 is rare — a few times a day — but never silent.
   */
  test('CL-002: P1 repeats every 240 minutes', () => {
    expect(firesAt(1, 240)).toBe(true)
    expect(firesAt(1, 480)).toBe(true)
    expect(firesAt(1, 30)).toBe(false)
    expect(firesAt(1, 60)).toBe(false)
  })

  /**
   * CL-003: P2 is hourly and explicitly NOT notify-once. One missed glance —
   * phone face-down, in a meeting — would lose it permanently, which fails
   * dangerous for something rated moderately important.
   */
  test('CL-003: P2 repeats hourly rather than firing once', () => {
    expect(firesAt(2, 60)).toBe(true)
    expect(firesAt(2, 120)).toBe(true)
    expect(firesAt(2, 30)).toBe(false)
  })

  /**
   * CL-004 / CL-005: the upper rungs are unchanged.
   */
  test('CL-004: P3 repeats every 15 minutes', () => {
    expect(firesAt(3, 15)).toBe(true)
    expect(firesAt(3, 30)).toBe(true)
    expect(firesAt(3, 20)).toBe(false)
  })

  test('CL-005: P4 repeats every 5 minutes', () => {
    expect(firesAt(4, 5)).toBe(true)
    expect(firesAt(4, 10)).toBe(true)
    expect(firesAt(4, 7)).toBe(false)
  })

  /**
   * CL-006: The rungs are genuinely distinct. Previously P0, P1 and P2 shared
   * one value, so this is the assertion that would have failed before.
   */
  test('CL-006: P0, P1 and P2 no longer share one interval', () => {
    // 240 min is a P1 boundary but not a P2 one... and both differ from P0.
    expect(firesAt(1, 240)).toBe(true)
    expect(firesAt(2, 90)).toBe(false)
    expect(firesAt(0, 90)).toBe(true)
  })

  /**
   * CL-007: A per-task override still wins over every tier.
   */
  test('CL-007: per-task auto_snooze_minutes overrides the tier', () => {
    const now = new Date(new Date(BASE.effective_due_at).getTime() + 10 * 60_000)
    expect(isNotificationBoundary({ ...BASE, priority: 1, auto_snooze_minutes: 10 }, now)).toBe(
      true,
    )
  })

  /**
   * CL-008: An override of 0 disables notifications entirely. Verified in
   * source but effectively untested in production (§4.1's warning), so it is
   * pinned here.
   */
  test('CL-008: an auto_snooze_minutes of 0 silences the task', () => {
    for (const minutes of [5, 30, 60, 240]) {
      const now = new Date(new Date(BASE.effective_due_at).getTime() + minutes * 60_000)
      expect(isNotificationBoundary({ ...BASE, priority: 4, auto_snooze_minutes: 0 }, now)).toBe(
        false,
      )
    }
  })

  /**
   * CL-009: §4.2 — urgent gets its own visible stack so it can't be lost among
   * routine items.
   */
  test('CL-009: urgent tasks thread separately from ordinary ones', () => {
    expect(threadIdForPriority(4)).toBe(NOTIFICATION_THREADS.urgent)
    expect(threadIdForPriority(3)).toBe(NOTIFICATION_THREADS.tasks)
    expect(threadIdForPriority(0)).toBe(NOTIFICATION_THREADS.tasks)
    expect(NOTIFICATION_THREADS.urgent).not.toBe(NOTIFICATION_THREADS.tasks)
    expect(NOTIFICATION_THREADS.reminders).not.toBe(NOTIFICATION_THREADS.tasks)
  })
})
