/**
 * Snooze Guard Behavioral Tests (SG-001 through SG-012)
 *
 * Covers REDESIGN-V03 §4.3: the two confirmation prompts on the single-task
 * interactive snooze UI.
 *
 * The guard's job is to WARN, never to reinterpret. These tests pin the
 * detection logic; the UI's obligation to keep "snooze anyway" as a real,
 * first-class choice is covered by the E2E suite.
 *
 * Time is frozen so the schedule math is deterministic regardless of when the
 * suite runs.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  evaluateSnoozeGuard,
  nextScheduledOccurrence,
  type SnoozeGuardTask,
} from '@/lib/snooze-guard'
import { isValidRRule } from '@/core/recurrence/rrule-builder'

const TZ = 'America/Chicago'

/** Build a UTC ISO string for a local wall-clock time on a given day offset. */
function localIso(dayOffset: number, hour: number, minute = 0): string {
  return DateTime.fromISO('2026-01-15T00:00:00', { zone: TZ })
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function task(overrides: Partial<SnoozeGuardTask> = {}): SnoozeGuardTask {
  return {
    due_at: localIso(0, 9),
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    ...overrides,
  }
}

describe('Snooze Guard', () => {
  beforeEach(() => {
    // Jan 15 2026, 08:00 local (14:00 UTC) — before the 09:00 due time
    vi.setSystemTime(new Date('2026-01-15T14:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * SG-001: A task with no due date warns that snoozing creates one.
   */
  test('SG-001: no due date returns the no-due-date guard', () => {
    const result = evaluateSnoozeGuard(task({ due_at: null }), localIso(1, 9), TZ)
    expect(result).toEqual({ kind: 'no-due-date' })
  })

  /**
   * SG-002: The no-due-date guard fires regardless of recurrence — an undated
   * recurring task still gains a due date from a snooze.
   */
  test('SG-002: no due date guards even when the task recurs', () => {
    const result = evaluateSnoozeGuard(
      task({ due_at: null, rrule: 'FREQ=DAILY' }),
      localIso(1, 9),
      TZ,
    )
    expect(result).toEqual({ kind: 'no-due-date' })
  })

  /**
   * SG-003: A plain one-off snooze needs no confirmation. This is the common
   * case and must stay frictionless.
   */
  test('SG-003: non-recurring task with a due date returns no guard', () => {
    const result = evaluateSnoozeGuard(task(), localIso(30, 9), TZ)
    expect(result).toBeNull()
  })

  /**
   * SG-004: Snoozing a daily task into tomorrow swallows tomorrow's occurrence.
   */
  test('SG-004: snooze past the next daily occurrence is guarded', () => {
    const result = evaluateSnoozeGuard(
      task({ rrule: 'FREQ=DAILY', anchor_time: '09:00' }),
      localIso(2, 9),
      TZ,
    )
    expect(result).toMatchObject({ kind: 'past-next-occurrence' })
    expect(result && 'nextOccurrence' in result && result.nextOccurrence).toBe(localIso(1, 9))
  })

  /**
   * SG-005: Snoozing within the same period is the normal case — no guard.
   */
  test('SG-005: snooze before the next occurrence is not guarded', () => {
    const result = evaluateSnoozeGuard(
      task({ rrule: 'FREQ=DAILY', anchor_time: '09:00' }),
      localIso(0, 17),
      TZ,
    )
    expect(result).toBeNull()
  })

  /**
   * SG-006: Landing exactly ON the next occurrence still consumes it, so the
   * boundary is at-or-after rather than strictly after.
   */
  test('SG-006: snooze landing exactly on the next occurrence is guarded', () => {
    const result = evaluateSnoozeGuard(
      task({ rrule: 'FREQ=DAILY', anchor_time: '09:00' }),
      localIso(1, 9),
      TZ,
    )
    expect(result).toMatchObject({ kind: 'past-next-occurrence' })
  })

  /**
   * SG-007: A weekly task's next occurrence is a week out, so a two-day snooze
   * is well within the period and must not nag.
   */
  test('SG-007: weekly task tolerates a multi-day snooze inside its period', () => {
    const result = evaluateSnoozeGuard(
      task({ rrule: 'FREQ=WEEKLY;BYDAY=TH', anchor_time: '09:00' }),
      localIso(2, 9),
      TZ,
    )
    expect(result).toBeNull()
  })

  /**
   * SG-008: from_completion tasks have no scheduled next occurrence until they
   * are completed. Inventing one would assert a schedule the task doesn't have.
   */
  test('SG-008: from_completion recurrence yields no guard', () => {
    const result = evaluateSnoozeGuard(
      task({ rrule: 'FREQ=DAILY', recurrence_mode: 'from_completion', anchor_time: '09:00' }),
      localIso(30, 9),
      TZ,
    )
    expect(result).toBeNull()
  })

  /**
   * SG-009: KNOWN DEFECT (pre-existing, not introduced by §4.3) —
   * `isValidRRule` accepts arbitrary garbage.
   *
   * `parseRRule` seeds its result with `{ freq: 'DAILY' }` and ignores keys it
   * doesn't recognize, so an unparseable string yields a valid-looking DAILY
   * component set and `validateComponents` passes it. A task created with
   * rrule "banana" silently becomes a task that recurs every day.
   *
   * This is asserted rather than fixed because the fix touches every write path
   * (`validation/task.ts`, `core/ai/types.ts`) and belongs to a decision Trent
   * should make — see .tmp/v03-progress.md. It is squarely against the
   * redesign's "never silently reinterpret an explicit instruction" principle.
   *
   * The assertion pins CURRENT behavior. When the hole is closed this test will
   * fail, which is the intended prompt to update it.
   */
  test('SG-009: isValidRRule currently accepts garbage (known defect)', () => {
    expect(isValidRRule('THIS IS NOT AN RRULE')).toBe(true)
    expect(isValidRRule('FREQ=DAILY')).toBe(true)
  })

  /**
   * SG-010b: The guard never throws, whatever it is handed. A crash in the
   * snooze path would be worse than a missed warning.
   */
  test('SG-010b: guard does not throw on an unvalidated rrule', () => {
    expect(() =>
      evaluateSnoozeGuard(task({ rrule: 'THIS IS NOT AN RRULE' }), localIso(30, 9), TZ),
    ).not.toThrow()
  })

  /**
   * SG-010: An invalid target time fails open rather than throwing.
   */
  test('SG-010: invalid snooze target fails open', () => {
    const result = evaluateSnoozeGuard(task({ rrule: 'FREQ=DAILY' }), 'not-a-date', TZ)
    expect(result).toBeNull()
  })

  /**
   * SG-011: anchor_time carries the time-of-day when the rrule has no BYHOUR
   * (§4.6). If the guard ignored it, the computed occurrence would drift to the
   * wrong hour and the warning would quote a time the user never set.
   */
  test('SG-011: next occurrence honours anchor_time over a missing BYHOUR', () => {
    const next = nextScheduledOccurrence(
      task({ due_at: localIso(0, 7), rrule: 'FREQ=DAILY', anchor_time: '07:00' }),
      TZ,
    )
    expect(next).not.toBeNull()
    expect(next!.toISOString()).toBe(localIso(1, 7))
  })

  /**
   * SG-012: Non-recurring tasks have no next occurrence at all.
   */
  test('SG-012: non-recurring task has no next scheduled occurrence', () => {
    expect(nextScheduledOccurrence(task(), TZ)).toBeNull()
  })
})
