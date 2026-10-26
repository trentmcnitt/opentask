/**
 * Behavioral tests for Recurrence Anti-Drift (RD-001 through RD-013)
 *
 * These tests verify the core recurrence computation logic specified in SPEC.md.
 * RD-001 to RD-010: Core recurrence computation
 * RD-011 to RD-013: Recurrence changes via task updates
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  computeNextOccurrence,
  computeFirstOccurrence,
  buildRRule,
  parseRRule,
  isValidRRule,
  isRecurring,
  deriveAnchorFields,
  RRulePatterns,
} from '@/core/recurrence'
import { bulkEdit, createTask } from '@/core/tasks'
import { updateTask } from '@/core/tasks/update'
import { getTaskById } from '@/core/tasks/read'
import { getDb } from '@/core/db'
import { executeUndo } from '@/core/undo'
import { occurrenceIsPersonal, targetMoved } from '@/lib/task-segments'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
  madeBefore,
} from '../helpers/setup'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TIMEZONE = 'America/Chicago'

// Helper to create a Date from local time components
function localDate(
  year: number,
  month: number,
  day: number,
  hour: number = 0,
  minute: number = 0,
): Date {
  return DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone: TIMEZONE },
  ).toJSDate()
}

// Helper to get local hour/minute from a Date
function getLocalTime(date: Date): { hour: number; minute: number; day: number; month: number } {
  const dt = DateTime.fromJSDate(date).setZone(TIMEZONE)
  return {
    hour: dt.hour,
    minute: dt.minute,
    day: dt.day,
    month: dt.month,
  }
}

// Helper to get day of week (0=Mon..6=Sun)
function getLocalDow(date: Date): number {
  const dt = DateTime.fromJSDate(date).setZone(TIMEZONE)
  return dt.weekday - 1 // Luxon uses 1=Mon..7=Sun
}

describe('RD-001: Snooze Does Not Affect Recurrence', () => {
  test('snoozing a task does not modify rrule or anchor fields', () => {
    // This is a state/behavior test - snooze only changes due_at and original_due_at
    // The recurrence engine doesn't handle snooze - it just computes next occurrence
    // So we verify that deriveAnchorFields returns consistent results

    const rrule = RRulePatterns.daily(8, 0) // Daily at 8 AM
    const dueAt = localDate(2026, 1, 31, 8, 0).toISOString()

    const anchors = deriveAnchorFields(rrule, dueAt, TIMEZONE)

    expect(anchors.anchor_time).toBe('08:00')
    expect(anchors.anchor_dow).toBeNull() // Daily tasks don't have DOW anchor
    expect(anchors.anchor_dom).toBeNull() // Daily tasks don't have DOM anchor

    // Snoozing would change due_at to 14:00, but anchors derived from RRULE stay same
    const snoozedDueAt = localDate(2026, 1, 31, 14, 0).toISOString()
    const anchorsAfterSnooze = deriveAnchorFields(rrule, snoozedDueAt, TIMEZONE)

    // anchor_time comes from RRULE's BYHOUR, not due_at
    expect(anchorsAfterSnooze.anchor_time).toBe('08:00')
  })
})

describe('RD-002: Done Computes From RRULE, Not due_at', () => {
  test('snoozed daily task returns to anchor time after completion', () => {
    const rrule = RRulePatterns.daily(8, 0) // Daily at 8 AM

    // Task was snoozed to 14:00
    const completedAt = localDate(2026, 1, 31, 15, 0) // Completed at 3 PM

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '08:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be tomorrow at 8 AM, NOT tomorrow at 2 PM
    expect(nextLocal.hour).toBe(8)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(1) // Feb 1
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-003: Overdue Completed Before Anchor Today', () => {
  test('overdue daily task completed before anchor time advances to today anchor time', () => {
    const rrule = RRulePatterns.daily(8, 0) // Daily at 8 AM

    // Task was due yesterday at 8 AM, completed at 7:30 AM today
    const completedAt = localDate(2026, 1, 31, 7, 30)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '08:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be TODAY at 8 AM (the next occurrence after 7:30 AM)
    expect(nextLocal.hour).toBe(8)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(31) // Same day
    expect(nextLocal.month).toBe(1)
  })
})

describe('RD-004: Overdue Completed After Anchor Today', () => {
  test('overdue daily task completed after anchor time advances to tomorrow anchor time', () => {
    const rrule = RRulePatterns.daily(8, 0) // Daily at 8 AM

    // Task was due yesterday at 8 AM, completed at 10 AM today
    const completedAt = localDate(2026, 1, 31, 10, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '08:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be TOMORROW at 8 AM
    expect(nextLocal.hour).toBe(8)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(1) // Feb 1
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-005: Weekly DOW Preservation', () => {
  test('weekly task snoozed and completed on different day returns to correct DOW', () => {
    // Monday at 10 AM
    const rrule = RRulePatterns.weekly([0], 10, 0) // 0 = Monday

    // Task was due Monday, snoozed to Wednesday, completed Wednesday at 3 PM
    // Wednesday Jan 29, 2026 is a real Wednesday
    const completedAt = localDate(2026, 1, 29, 15, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '10:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Next occurrence should be NEXT Monday at 10 AM, NOT next Wednesday
    expect(nextLocal.hour).toBe(10)
    expect(nextLocal.minute).toBe(0)
    expect(nextDow).toBe(0) // Monday
    // Feb 2, 2026 is Monday
    expect(nextLocal.day).toBe(2)
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-006: Monthly DOM Preservation', () => {
  test('monthly task snoozed and completed on different day returns to correct DOM', () => {
    // 1st of month at 9 AM
    const rrule = RRulePatterns.monthly(1, 9, 0)

    // Task was due Jan 1, snoozed to Jan 5, completed Jan 5 at 2 PM
    const completedAt = localDate(2026, 1, 5, 14, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be Feb 1 at 9 AM, NOT Feb 5
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(1)
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-007: DOM Overflow / Last Day of Month', () => {
  test('BYMONTHDAY=-1 correctly lands on last day of February', () => {
    // Last day of month at 9 AM
    const rrule = 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0'

    // Completed after Jan 31
    const completedAt = localDate(2026, 1, 31, 10, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be Feb 28 at 9 AM (2026 is not a leap year)
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(28)
    expect(nextLocal.month).toBe(2)
  })

  test('BYMONTHDAY=-1 correctly lands on last day of April (30 days)', () => {
    const rrule = 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0'

    // Completed after March 31
    const completedAt = localDate(2026, 3, 31, 10, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be April 30 at 9 AM
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(30)
    expect(nextLocal.month).toBe(4)
  })
})

describe('RD-008: Multi-Day Weekly Pattern', () => {
  test('Mon/Wed/Fri pattern advances to next matching day, not next week', () => {
    // Mon, Wed, Fri at 9 AM
    const rrule = RRulePatterns.weekly([0, 2, 4], 9, 0) // 0=Mon, 2=Wed, 4=Fri

    // Completed Tuesday Jan 27, 2026 at 10 AM (Jan 27, 2026 is a Tuesday)
    const completedAt = localDate(2026, 1, 27, 10, 0) // Tuesday

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Next occurrence should be Wednesday Jan 28 at 9 AM (next M/W/F day after Tuesday)
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextDow).toBe(2) // Wednesday
    expect(nextLocal.day).toBe(28)
    expect(nextLocal.month).toBe(1)
  })

  test('Fri completion advances to Monday of next week', () => {
    // Mon, Wed, Fri at 9 AM
    const rrule = RRulePatterns.weekly([0, 2, 4], 9, 0)

    // Completed Friday Jan 31, 2026 at 10 AM
    const completedAt = localDate(2026, 1, 31, 10, 0) // Friday

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Next occurrence should be Monday Feb 2 at 9 AM
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextDow).toBe(0) // Monday
    expect(nextLocal.day).toBe(2)
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-009: Overdue Catch-Up Skips Missed', () => {
  test('task overdue by 5 days skips all missed and advances to next future occurrence', () => {
    const rrule = RRulePatterns.daily(9, 0) // Daily at 9 AM

    // Task was due 5 days ago, completed today at 10 AM
    // Due: Jan 26 at 9 AM, completed Jan 31 at 10 AM
    const completedAt = localDate(2026, 1, 31, 10, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)

    // Next occurrence should be Feb 1 at 9 AM (tomorrow)
    // NOT Jan 27, 28, 29, 30, or 31
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(1)
    expect(nextLocal.month).toBe(2)
  })
})

describe('RD-010: Non-Recurring Tasks Excluded', () => {
  test('isRecurring returns false for null rrule', () => {
    expect(isRecurring(null)).toBe(false)
  })

  test('isRecurring returns false for empty string rrule', () => {
    expect(isRecurring('')).toBe(false)
  })

  test('isRecurring returns true for valid rrule', () => {
    expect(isRecurring('FREQ=DAILY;BYHOUR=8')).toBe(true)
  })

  test('anchor derivation returns nulls for non-recurring task', () => {
    const anchors = deriveAnchorFields(null, '2026-01-31T14:00:00Z', TIMEZONE)

    expect(anchors.anchor_time).toBeNull()
    expect(anchors.anchor_dow).toBeNull()
    expect(anchors.anchor_dom).toBeNull()
  })
})

describe('from_completion mode', () => {
  test('daily from_completion adds interval days and snaps to anchor time', () => {
    const rrule = 'FREQ=DAILY;INTERVAL=1'
    const completedAt = localDate(2026, 1, 31, 14, 30) // 2:30 PM

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_completion',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      dayStart: CALENDAR_DAY_START,
    })

    const nextLocal = getLocalTime(next)

    // Next = tomorrow at 9 AM (anchor time), not 2:30 PM
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.minute).toBe(0)
    expect(nextLocal.day).toBe(1)
    expect(nextLocal.month).toBe(2)
  })

  test('weekly from_completion adds 7 days and snaps to anchor time', () => {
    const rrule = 'FREQ=WEEKLY;INTERVAL=1'
    // Jan 29, 2026 is a Thursday
    const completedAt = localDate(2026, 1, 29, 16, 0) // Thursday 4 PM

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_completion',
      anchorTime: '10:00',
      timezone: TIMEZONE,
      completedAt,
      dayStart: CALENDAR_DAY_START,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Next = 7 days later at 10 AM = Thursday Feb 5 at 10 AM
    expect(nextLocal.hour).toBe(10)
    expect(nextLocal.minute).toBe(0)
    expect(nextDow).toBe(3) // Thursday (0=Mon..6=Sun, so Thu=3)
    expect(nextLocal.day).toBe(5)
    expect(nextLocal.month).toBe(2)
  })
})

describe('Biweekly patterns', () => {
  test('every 2 weeks on Monday advances to next biweekly Monday', () => {
    const rrule = RRulePatterns.everyNWeeks(2, [0], 10, 0) // Every 2 weeks on Monday at 10 AM

    // Completed Monday Jan 26, 2026 at 11 AM (Jan 26 is a Monday)
    const completedAt = localDate(2026, 1, 26, 11, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '10:00',
      timezone: TIMEZONE,
      completedAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Next occurrence should be a Monday at 10 AM
    // The exact date depends on dtstart alignment, but it should be 2 weeks from a Monday
    expect(nextLocal.hour).toBe(10)
    expect(nextLocal.minute).toBe(0)
    expect(nextDow).toBe(0) // Monday

    // It should be either Feb 2 or Feb 9 depending on the biweekly cycle alignment
    // Feb 2 is 1 week later, Feb 9 is 2 weeks later
    // Since we completed on a Monday after 10 AM, next should be at least 1 week away
    expect(nextLocal.month).toBe(2) // February
    expect([2, 9]).toContain(nextLocal.day) // Either Feb 2 or Feb 9
  })
})

/**
 * RD-011 to RD-013: Recurrence changes via task updates
 *
 * These tests verify behavior when rrule is changed via updateTask,
 * particularly around overdue tasks and due_at handling.
 */
describe('Recurrence Changes via Task Update', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * RD-011: Overdue task + rrule change keeps due_at unchanged
   *
   * When changing the rrule of an overdue task, the due_at is preserved.
   * This prevents the task from "escaping" overdue status by silently
   * jumping to the future when only the schedule is changing.
   *
   * Task: due_at=yesterday (OVERDUE), rrule=FREQ=DAILY
   * Action: Change rrule to FREQ=WEEKLY;BYDAY=MO
   * Result: due_at unchanged (still overdue), original_due_at cleared
   */
  test('RD-011: Overdue task + rrule change keeps due_at unchanged', () => {
    // Create task that is already overdue (due yesterday at 8 AM)
    const yesterdayDueAt = localTime(8, 0, -1) // Yesterday at 8 AM
    // Made while that date was still ahead (a new repeat with a past date
    // would start at its next occurrence instead).
    const task = madeBefore(yesterdayDueAt, () =>
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Overdue daily task',
          due_at: yesterdayDueAt,
          rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
        },
      }),
    )

    // Verify task is overdue
    expect(new Date(task.due_at!).getTime()).toBeLessThan(Date.now())

    // Change rrule from daily to weekly
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
    })

    // due_at should be UNCHANGED (still yesterday, still overdue)
    expect(updatedTask.due_at).toBe(yesterdayDueAt)
    expect(new Date(updatedTask.due_at!).getTime()).toBeLessThan(Date.now())

    // Anchors should be re-derived from new rrule
    expect(updatedTask.anchor_time).toBe('09:00')
    expect(updatedTask.anchor_dow).toBe(0) // Monday
  })

  /**
   * RD-012: Non-overdue task + rrule change auto-computes due_at
   *
   * When changing the rrule of a non-overdue task (due_at in the future),
   * due_at is automatically computed to the next occurrence of the new pattern.
   *
   * Task: due_at=tomorrow, rrule=FREQ=DAILY
   * Action: Change rrule to FREQ=WEEKLY;BYDAY=MO
   * Result: due_at auto-computed to next occurrence
   */
  test('RD-012: Non-overdue task + rrule change auto-computes due_at', () => {
    // Create task due tomorrow at 8 AM (not overdue)
    const tomorrowDueAt = localTime(8, 0, 1) // Tomorrow at 8 AM
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Future daily task',
        due_at: tomorrowDueAt,
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    // Verify task is NOT overdue
    expect(new Date(task.due_at!).getTime()).toBeGreaterThan(Date.now())

    // Change rrule from daily to weekly at 9 AM
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
    })

    // due_at should be auto-computed to next occurrence
    // NOT the original tomorrow 8 AM
    expect(updatedTask.due_at).not.toBe(tomorrowDueAt)

    // Should be at the new anchor time (9:00)
    const dueAtDt = DateTime.fromISO(updatedTask.due_at!).setZone(TEST_TIMEZONE)
    expect(dueAtDt.hour).toBe(9)
    expect(dueAtDt.minute).toBe(0)

    // Should be on a Monday
    expect(dueAtDt.weekday).toBe(1) // Monday in Luxon
  })

  /**
   * RD-013: Task with null due_at + rrule change computes first occurrence
   *
   * When adding an rrule to a task that has no due_at, the due_at is
   * computed as the first occurrence from now.
   *
   * Task: no due_at
   * Action: Add rrule
   * Result: due_at computed from now
   */
  test('RD-013: Task with null due_at + rrule change computes first occurrence', () => {
    // Create task with no due date
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'No due date task',
        // No due_at, no rrule
      },
    })

    expect(task.due_at).toBeNull()
    expect(task.rrule).toBeNull()

    // Add rrule
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })

    // due_at should now be set (computed as first occurrence)
    expect(updatedTask.due_at).not.toBeNull()

    // Should be at the anchor time
    const dueAtDt = DateTime.fromISO(updatedTask.due_at!).setZone(TEST_TIMEZONE)
    expect(dueAtDt.hour).toBe(9)
    expect(dueAtDt.minute).toBe(0)

    // Should be in the future (next occurrence at 9 AM)
    expect(new Date(updatedTask.due_at!).getTime()).toBeGreaterThan(Date.now())

    // Anchors should be derived
    expect(updatedTask.anchor_time).toBe('09:00')
  })
})

/**
 * RD-016…019 (PR 4a, 2026-10-22; plan RT-1, ruling A1): a rule change on a
 * TARGET-ANCHORED repeat whose target was MOVED this occurrence keeps the
 * target — the occurrence moves to the new rule's first, so the move stays a
 * move (the same rule as a deadline-anchored repeat's `targetFor`). An
 * occurrence on its schedule, or one waiting in the task queue, still moves
 * with the schedule. The clock: Thu Jan 15 2026, 10:00 Chicago.
 */
describe('RD-016: a moved target survives a rule change (target-anchored)', () => {
  const u = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }
  const FRIDAY_4PM = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'
  const THURSDAY_4PM = 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=16;BYMINUTE=0'
  const at = (local: string) => DateTime.fromISO(local, { zone: TEST_TIMEZONE }).toUTC().toISO()!

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /** Weekly Friday 4 PM (Fri Jan 16), its target moved to Sat Jan 17 10:00. */
  function movedFriday() {
    const t = createTask({ ...u, input: { title: 'Bins', rrule: FRIDAY_4PM } })
    expect(t.due_at).toBe(at('2026-01-16T16:00'))
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-01-17T10:00') } })
    const moved = getTaskById(t.id)!
    expect(targetMoved(moved, TEST_TIMEZONE)).toBe(true)
    expect(occurrenceIsPersonal(moved, TEST_TIMEZONE)).toBe('moved')
    return moved
  }

  test('RD-016: PATCH — the moved target stays, the occurrence takes the new rule; undo restores exactly', () => {
    const before = movedFriday()
    const { fieldsChanged } = updateTask({
      ...u,
      taskId: before.id,
      input: { rrule: THURSDAY_4PM },
    })
    expect(fieldsChanged).not.toContain('due_at')
    const after = getTaskById(before.id)!
    expect(after).toMatchObject({
      rrule: THURSDAY_4PM,
      due_at: at('2026-01-17T10:00'),
      occurrence_at: at('2026-01-15T16:00'),
      anchor_dow: 3,
    })
    expect(targetMoved(after, TEST_TIMEZONE)).toBe(true)
    // The same occurrence: its origin (the age clock) stays with it.
    expect(before.original_due_at).toBe(at('2026-01-16T16:00'))
    expect(after.original_due_at).toBe(before.original_due_at)
    expect(fieldsChanged).not.toContain('original_due_at')

    executeUndo(TEST_USER_ID)
    const undone = getTaskById(before.id)!
    for (const f of [
      'rrule',
      'due_at',
      'occurrence_at',
      'original_due_at',
      'anchor_time',
      'anchor_dow',
      'anchor_dom',
      'target_set_at',
      'on_deck_day',
    ] as const) {
      expect(undone[f], f).toEqual(before[f])
    }
  })

  test('RD-017: bulk edit — the same rule (collectFieldChanges is shared)', () => {
    const t = movedFriday()
    bulkEdit({ ...u, taskIds: [t.id], changes: { rrule: THURSDAY_4PM } })
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-01-17T10:00'),
      occurrence_at: at('2026-01-15T16:00'),
      original_due_at: t.original_due_at,
    })
    expect(t.original_due_at).not.toBeNull()
  })

  test('RD-018: an occurrence on its schedule still moves with it (and drops its origin, as before)', () => {
    const t = createTask({ ...u, input: { title: 'Bins', rrule: FRIDAY_4PM } })
    expect(occurrenceIsPersonal(t, TEST_TIMEZONE)).toBeNull()
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-01-16T16:00') } })
    getDb().prepare('UPDATE tasks SET original_due_at = due_at WHERE id = ?').run(t.id)
    updateTask({ ...u, taskId: t.id, input: { rrule: THURSDAY_4PM } })
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-01-15T16:00'),
      occurrence_at: at('2026-01-15T16:00'),
      original_due_at: null,
    })
  })

  test('RD-019: a repeat waiting in the queue is not a move: recomputed, out of the queue', () => {
    const t = createTask({ ...u, input: { title: 'Bins', rrule: FRIDAY_4PM } })
    // As the rollover leaves it (B3): the missed occurrence kept, the target
    // on the next one.
    getDb()
      .prepare('UPDATE tasks SET occurrence_at = ?, due_at = ?, queued_at = ? WHERE id = ?')
      .run(at('2026-01-09T16:00'), at('2026-01-16T16:00'), at('2026-01-15T06:30'), t.id)
    const queued = getTaskById(t.id)!
    expect(targetMoved(queued, TEST_TIMEZONE)).toBe(true)
    expect(occurrenceIsPersonal(queued, TEST_TIMEZONE)).toBeNull()
    updateTask({ ...u, taskId: t.id, input: { rrule: THURSDAY_4PM } })
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-01-15T16:00'),
      occurrence_at: at('2026-01-15T16:00'),
      queued_at: null,
    })
  })
})

describe('RD-014: prevDueAt advances past early completion', () => {
  test('completing a weekly-Thursday task on Wednesday advances to the FOLLOWING Thursday', () => {
    // rrule: weekly Thursday 9 AM
    const rrule = RRulePatterns.weekly([3], 9, 0) // 3 = Thursday
    // Task is due Thursday Apr 16, 2026 9 AM; user completes Wed Apr 15 3 PM (early).
    const prevDueAt = localDate(2026, 4, 16, 9, 0)
    const completedAt = localDate(2026, 4, 15, 15, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      prevDueAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Should advance to Thursday Apr 23 (the NEXT Thursday after the previous due),
    // NOT stay on Thursday Apr 16.
    expect(nextDow).toBe(3) // Thursday
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.day).toBe(23)
    expect(nextLocal.month).toBe(4)
  })

  test('completing the same task twice in quick succession advances by two cycles', () => {
    const rrule = RRulePatterns.weekly([3], 9, 0)
    // After 1st completion, due_at became Thu Apr 23 (per previous test).
    // User completes again immediately on Wed Apr 15 3 PM.
    const prevDueAt = localDate(2026, 4, 23, 9, 0)
    const completedAt = localDate(2026, 4, 15, 15, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      prevDueAt,
    })

    const nextLocal = getLocalTime(next)
    const nextDow = getLocalDow(next)

    // Should advance to Thursday Apr 30.
    expect(nextDow).toBe(3)
    expect(nextLocal.hour).toBe(9)
    expect(nextLocal.day).toBe(30)
    expect(nextLocal.month).toBe(4)
  })

  test('late completion (prevDueAt in the past) still uses completedAt as reference', () => {
    // Previous due was last week; user completes today late. Reference = now.
    const rrule = RRulePatterns.weekly([3], 9, 0)
    const prevDueAt = localDate(2026, 4, 9, 9, 0) // Thu Apr 9 (past)
    const completedAt = localDate(2026, 4, 15, 15, 0) // Wed Apr 15

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      prevDueAt,
    })

    const nextLocal = getLocalTime(next)
    // max(prev, completed) = completedAt → next Thursday = Apr 16.
    expect(nextLocal.day).toBe(16)
    expect(nextLocal.month).toBe(4)
    expect(nextLocal.hour).toBe(9)
  })

  test('from_completion mode ignores prevDueAt', () => {
    // Weekly from_completion, completed Wed; even with a future prevDueAt,
    // the reference is still the completion moment (semantics: interval from completion).
    const rrule = RRulePatterns.weekly([3], 9, 0)
    const prevDueAt = localDate(2026, 4, 30, 9, 0) // far in the future
    const completedAt = localDate(2026, 4, 15, 15, 0) // Wed

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_completion',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      dayStart: CALENDAR_DAY_START,
      prevDueAt,
    })

    const nextLocal = getLocalTime(next)
    // from_completion adds 1 week to completion, then snaps to anchor time (9 AM).
    // Wed Apr 15 + 1 week = Wed Apr 22 at 9 AM.
    expect(nextLocal.day).toBe(22)
    expect(nextLocal.month).toBe(4)
    expect(nextLocal.hour).toBe(9)
  })

  test('backwards compatibility: omitting prevDueAt falls back to completedAt only', () => {
    const rrule = RRulePatterns.weekly([3], 9, 0)
    const completedAt = localDate(2026, 4, 15, 15, 0)

    const next = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt,
      // prevDueAt omitted
    })

    const nextLocal = getLocalTime(next)
    expect(nextLocal.day).toBe(16) // Thu Apr 16
    expect(nextLocal.hour).toBe(9)
  })
})

/**
 * A yearly rule's month (BYMONTH) is part of the rule (2026-10-13). Until then
 * parseRRule dropped it, so FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1 ("every year
 * on March 1st") ran on the 1st of every month.
 */
describe('RD-015: yearly rules keep their month (BYMONTH)', () => {
  const MARCH_1ST = 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0'

  test('parse and build round-trip BYMONTH', () => {
    expect(parseRRule(MARCH_1ST).bymonth).toEqual([3])
    expect(buildRRule(parseRRule('FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1'))).toBe(
      'FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1',
    )
  })

  test('BYMONTH outside 1..12 is invalid', () => {
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1')).toBe(true)
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=13;BYMONTHDAY=1')).toBe(false)
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=0;BYMONTHDAY=1')).toBe(false)
  })

  test('the first occurrence is the next March 1st, not the next 1st of a month', () => {
    const first = computeFirstOccurrence(
      MARCH_1ST,
      null,
      TIMEZONE,
      localDate(2026, 10, 13, 10, 0),
      CALENDAR_DAY_START,
    )
    expect(DateTime.fromJSDate(first).setZone(TIMEZONE).toISO({ includeOffset: false })).toBe(
      '2027-03-01T09:00:00.000',
    )
  })

  test('done on March 1st → the March 1st a year on', () => {
    const next = computeNextOccurrence({
      rrule: MARCH_1ST,
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt: localDate(2027, 3, 1, 12, 0),
      prevDueAt: localDate(2027, 3, 1, 9, 0),
    })
    expect(DateTime.fromJSDate(next).setZone(TIMEZONE).toISO({ includeOffset: false })).toBe(
      '2028-03-01T09:00:00.000',
    )
  })

  test('several months: the next of them', () => {
    const next = computeNextOccurrence({
      rrule: 'FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
      recurrenceMode: 'from_due',
      anchorTime: '09:00',
      timezone: TIMEZONE,
      completedAt: localDate(2027, 3, 1, 12, 0),
      prevDueAt: localDate(2027, 3, 1, 9, 0),
    })
    expect(getLocalTime(next)).toMatchObject({ month: 9, day: 1, hour: 9 })
  })
})
