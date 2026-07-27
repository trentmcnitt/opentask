/**
 * Read-Time Occurrence Derivation Tests (OC-001 through OC-014)
 *
 * Covers REDESIGN-V03 §4.6 — the rule that a recurring item's due-today-ness
 * comes from its schedule, not from `due_at` freshness.
 *
 * The headline case is OC-006: a weekly task whose `due_at` froze months ago
 * must NOT be treated as due every day. That is the failure this whole module
 * exists to prevent, and it only appears once the redesign reduces sweeping.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  todaysOccurrence,
  effectiveDueAt,
  isCurrentlyDue,
  type OccurrenceTask,
} from '@/core/recurrence/occurrence'

const TZ = 'America/Chicago'

// Thursday 2026-01-15, 10:00 local (16:00 UTC)
const NOW = new Date('2026-01-15T16:00:00Z')

function localIso(dayOffset: number, hour: number, minute = 0): string {
  return DateTime.fromISO('2026-01-15T00:00:00', { zone: TZ })
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function task(overrides: Partial<OccurrenceTask> = {}): OccurrenceTask {
  return {
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    ...overrides,
  }
}

describe('Read-time occurrence derivation', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * OC-001: One-offs are untouched — due_at remains the whole truth for them.
   */
  test('OC-001: a one-off uses due_at directly', () => {
    const t = task({ due_at: localIso(0, 8) })
    expect(effectiveDueAt(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 8))
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })

  /**
   * OC-002: A future one-off is not yet due.
   */
  test('OC-002: a future one-off is not due', () => {
    expect(isCurrentlyDue(task({ due_at: localIso(0, 18) }), TZ, NOW)).toBe(false)
  })

  /**
   * OC-003: A daily task's occurrence is derived for today at its anchor time,
   * regardless of how stale due_at is.
   */
  test('OC-003: a daily task derives today occurrence from the schedule', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00', due_at: localIso(-90, 7) })
    expect(todaysOccurrence(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 7))
  })

  /**
   * OC-004: ...and it is due, timed from TODAY's occurrence rather than the
   * frozen date. Without this the notifier's minutes-overdue math would be in
   * the tens of thousands.
   */
  test('OC-004: a daily task with a frozen due_at is due from today occurrence', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00', due_at: localIso(-90, 7) })
    expect(effectiveDueAt(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 7))
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })

  /**
   * OC-005: A daily task whose time hasn't arrived yet is not due.
   */
  test('OC-005: a daily task later today is not yet due', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '20:00', due_at: localIso(-90, 20) })
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(false)
  })

  /**
   * OC-006: THE headline case. A weekly task not scheduled today must not be
   * due today, however old its due_at is. Under the old due_at-only rule this
   * task nagged every day forever once sweeping stopped.
   */
  test('OC-006: a weekly task not scheduled today is NOT due despite a stale due_at', () => {
    // 2026-01-15 is a Thursday; this recurs Mondays.
    const t = task({
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      anchor_time: '09:00',
      due_at: localIso(-60, 9),
    })
    expect(todaysOccurrence(t, TZ, NOW)).toBeNull()
    expect(effectiveDueAt(t, TZ, NOW)).toBeNull()
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(false)
  })

  /**
   * OC-007: The same weekly task IS due on its own day.
   */
  test('OC-007: a weekly task is due on its scheduled day', () => {
    // Thursday task, evaluated on Thursday.
    const t = task({
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      anchor_time: '09:00',
      due_at: localIso(-60, 9),
    })
    expect(todaysOccurrence(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 9))
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })

  /**
   * OC-008: An explicit snooze — a future due_at — wins over the schedule.
   */
  test('OC-008: a future due_at (snooze) suppresses today occurrence', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00', due_at: localIso(0, 15) })
    expect(effectiveDueAt(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 15))
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(false)
  })

  /**
   * OC-009: ...but only for that day. Evaluated tomorrow, the schedule
   * reasserts itself and the snooze no longer applies.
   */
  test('OC-009: a snooze does not carry past its own day', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00', due_at: localIso(0, 15) })
    const tomorrow = new Date(localIso(1, 10))
    expect(effectiveDueAt(t, TZ, tomorrow)?.toISOString()).toBe(localIso(1, 7))
    expect(isCurrentlyDue(t, TZ, tomorrow)).toBe(true)
  })

  /**
   * OC-010: from_completion items have no derivable schedule, so due_at stays
   * authoritative — inventing an occurrence would assert a schedule they don't
   * have.
   */
  test('OC-010: from_completion recurrence falls back to due_at', () => {
    const t = task({
      rrule: 'FREQ=DAILY',
      recurrence_mode: 'from_completion',
      anchor_time: '07:00',
      due_at: localIso(-5, 7),
    })
    expect(todaysOccurrence(t, TZ, NOW)).toBeNull()
    expect(effectiveDueAt(t, TZ, NOW)?.toISOString()).toBe(localIso(-5, 7))
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })

  /**
   * OC-011: anchor_time carries time-of-day when the rrule has no BYHOUR.
   * Ignoring it would fire the notification at the wrong hour.
   */
  test('OC-011: anchor_time supplies time-of-day when BYHOUR is absent', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '06:30', due_at: localIso(-3, 6, 30) })
    expect(todaysOccurrence(t, TZ, NOW)?.toISOString()).toBe(localIso(0, 6, 30))
  })

  /**
   * OC-012: A recurring task with no due_at at all still derives from its
   * schedule — this is the state a migrated or newly created recurring item can
   * be in.
   */
  test('OC-012: a recurring task with no due_at still derives an occurrence', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00', due_at: null })
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })

  /**
   * OC-013: Timezone correctness. 07:00 Chicago is 13:00 UTC; deriving in UTC
   * would place the occurrence on the wrong side of "now".
   */
  test('OC-013: occurrences are derived in the user timezone', () => {
    const t = task({ rrule: 'FREQ=DAILY', anchor_time: '07:00' })
    const occurrence = todaysOccurrence(t, TZ, NOW)!
    expect(DateTime.fromJSDate(occurrence).setZone(TZ).hour).toBe(7)
  })

  /**
   * OC-014: The derivation never throws, and a schedule it cannot evaluate
   * falls back to due_at rather than going silent. Per L2, silence fails
   * dangerous — an item the user asked to be reminded about must still reach
   * them.
   */
  test('OC-014: an unevaluable schedule falls back to due_at instead of going silent', () => {
    const t = task({ rrule: 'FREQ=NONSENSE;BYDAY=ZZ', anchor_time: null, due_at: localIso(-1, 9) })
    expect(() => effectiveDueAt(t, TZ, NOW)).not.toThrow()
    expect(isCurrentlyDue(t, TZ, NOW)).toBe(true)
  })
})
