/**
 * TR-060..: the user's first day of the week (`users.week_start`, Sunday by
 * default — Trent, 2026-09-27: "Saturday at midnight is the changeover").
 *
 * - A weekly quota anchors to 00:00 on the user's first day of the week.
 * - An anchor that is not on that boundary (anchored under the old Monday-only
 *   rule, or the preference changed) closes at the NEXT boundary — a short
 *   period recorded with normal rollover semantics — and is aligned after.
 * - Progress logged after the new boundary, but before the rollover saw it,
 *   is carried into the new period rather than swept into the one closing.
 *
 * All in America/Chicago with a frozen clock. September 2026: Sun 20, Mon 21,
 * … Sat 26, Sun 27, Mon 28. CDT (UTC−5), so local midnight is 05:00Z.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, getTaskById, rolloverTrackedPeriods } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { effectiveProgress } from '@/lib/track'
import { quotaPeriodEnd, startOfWeek, coerceWeekStart } from '@/lib/week-start'
import { buildTaskStats } from '@/core/ai/quick-take'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** A local wall-clock instant in Chicago. */
function at(date: string, hour = 12, minute = 0): Date {
  return DateTime.fromISO(`${date}T00:00`, { zone: TEST_TIMEZONE }).set({ hour, minute }).toJSDate()
}

function setWeekStart(value: 'sunday' | 'monday') {
  getDb().prepare('UPDATE users SET week_start = ? WHERE id = ?').run(value, TEST_USER_ID)
}

function quota(target: number, rrule = 'FREQ=WEEKLY') {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Eggs', rrule, progress_target: target, is_tracked: true },
  })
}

/** A +1 logged at `when` (the clock is moved there, as a real tap would be). */
function logAt(taskId: number, when: Date, delta = 1) {
  vi.setSystemTime(when)
  incrementProgress({ userId: TEST_USER_ID, taskId, delta })
}

function anchor(taskId: number): string {
  return (
    getDb().prepare('SELECT progress_period_start AS a FROM tasks WHERE id = ?').get(taskId) as {
      a: string
    }
  ).a
}

function periods(taskId: number) {
  return getDb()
    .prepare(
      'SELECT period_start, period_end, logged, target, met FROM progress_periods WHERE task_id = ? ORDER BY period_start',
    )
    .all(taskId) as {
    period_start: string
    period_end: string
    logged: number
    target: number
    met: number
  }[]
}

function completions(taskId: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM completions WHERE task_id = ?').get(taskId) as {
      n: number
    }
  ).n
}

describe('startOfWeek / quotaPeriodEnd (pure)', () => {
  const local = (iso: string) => DateTime.fromISO(iso, { zone: TEST_TIMEZONE })

  test('Sunday and Monday week starts, from every day of the week', () => {
    // Wed 2026-09-23 → Sun 20 / Mon 21. Sun 27 → itself / Mon 21. Sat 26 → Sun 20.
    expect(startOfWeek(local('2026-09-23T15:00'), 'sunday').toISODate()).toBe('2026-09-20')
    expect(startOfWeek(local('2026-09-23T15:00'), 'monday').toISODate()).toBe('2026-09-21')
    expect(startOfWeek(local('2026-09-27T00:00'), 'sunday').toISODate()).toBe('2026-09-27')
    expect(startOfWeek(local('2026-09-27T23:59'), 'monday').toISODate()).toBe('2026-09-21')
    expect(startOfWeek(local('2026-09-26T23:59'), 'sunday').toISODate()).toBe('2026-09-20')
    expect(startOfWeek(local('2026-09-23T15:00'), 'sunday').hour).toBe(0)
  })

  test('an aligned anchor runs interval weeks; a misaligned one ends at the next boundary', () => {
    const sun = local('2026-09-20T00:00')
    const mon = local('2026-09-21T00:00')
    expect(quotaPeriodEnd(sun, 'weeks', 1, 'sunday').toISO()).toBe(
      local('2026-09-27T00:00').toISO(),
    )
    expect(quotaPeriodEnd(sun, 'weeks', 2, 'sunday').toISO()).toBe(
      local('2026-10-04T00:00').toISO(),
    )
    // Monday anchor, Sunday week: the 6-day stretch to Sunday 27.
    expect(quotaPeriodEnd(mon, 'weeks', 1, 'sunday').toISO()).toBe(
      local('2026-09-27T00:00').toISO(),
    )
    expect(quotaPeriodEnd(mon, 'weeks', 2, 'sunday').toISO()).toBe(
      local('2026-09-27T00:00').toISO(),
    )
    // Sunday anchor, Monday week: a 1-day stretch to Monday 21.
    expect(quotaPeriodEnd(sun, 'weeks', 1, 'monday').toISO()).toBe(
      local('2026-09-21T00:00').toISO(),
    )
    // Other units ignore the week start.
    expect(quotaPeriodEnd(mon, 'days', 1, 'sunday').toISODate()).toBe('2026-09-22')
    expect(quotaPeriodEnd(local('2026-09-01T00:00'), 'months', 1, 'sunday').toISODate()).toBe(
      '2026-10-01',
    )
  })

  test('unknown stored values read as the Sunday default', () => {
    expect(coerceWeekStart('monday')).toBe('monday')
    expect(coerceWeekStart('sunday')).toBe('sunday')
    expect(coerceWeekStart(null)).toBe('sunday')
    expect(coerceWeekStart('tuesday')).toBe('sunday')
  })
})

function withTestDb() {
  beforeEach(() => {
    vi.setSystemTime(at('2026-09-23'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('Weekly quota periods by week start', () => {
  withTestDb()

  test('TR-060: by default a week is Sunday 00:00 to Saturday midnight', () => {
    const q = quota(2)
    expect(rolloverTrackedPeriods(at('2026-09-23'))).toEqual({ anchored: 1, rolled: 0 })
    expect(anchor(q.id)).toBe('2026-09-20T05:00:00.000Z') // Sun 20, 00:00 CDT
    logAt(q.id, at('2026-09-24'))
    logAt(q.id, at('2026-09-26', 22))

    // Saturday 23:59 — still this week.
    expect(rolloverTrackedPeriods(at('2026-09-26', 23, 59)).rolled).toBe(0)
    // Sunday 00:01 — the week has turned.
    expect(rolloverTrackedPeriods(at('2026-09-27', 0, 1)).rolled).toBe(1)
    expect(periods(q.id)).toEqual([
      {
        period_start: '2026-09-20T05:00:00.000Z',
        period_end: '2026-09-27T05:00:00.000Z',
        logged: 2,
        target: 2,
        met: 1,
      },
    ])
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(anchor(q.id)).toBe('2026-09-27T05:00:00.000Z')
  })

  test('TR-061: a Monday week start anchors to Monday and turns at Monday 00:00', () => {
    setWeekStart('monday')
    const q = quota(2)
    rolloverTrackedPeriods(at('2026-09-23'))
    expect(anchor(q.id)).toBe('2026-09-21T05:00:00.000Z')
    expect(rolloverTrackedPeriods(at('2026-09-27', 23)).rolled).toBe(0)
    expect(rolloverTrackedPeriods(at('2026-09-28', 0, 1)).rolled).toBe(1)
    expect(periods(q.id)[0].period_end).toBe('2026-09-28T05:00:00.000Z')
  })

  test('TR-062: the Monday→Sunday switch closes the Mon–Sat stretch at Sunday 00:00; Sunday taps stay in the new week', () => {
    // Before the change ships: anchored Monday 21 under the old rule.
    setWeekStart('monday')
    const met = quota(2)
    const short = quota(3)
    rolloverTrackedPeriods(at('2026-09-23'))
    expect(anchor(met.id)).toBe('2026-09-21T05:00:00.000Z')
    logAt(met.id, at('2026-09-22'))
    logAt(met.id, at('2026-09-25'))
    logAt(short.id, at('2026-09-24'))
    // Sunday morning, still on the old code: the +1 goes into the Monday week.
    logAt(met.id, at('2026-09-27', 9))
    logAt(short.id, at('2026-09-27', 9, 30))
    expect(getTaskById(met.id)!.progress_current).toBe(3)

    // The change ships at Sunday noon (the migration's default is 'sunday').
    setWeekStart('sunday')
    // Before the rollover runs, the expired stretch already reads as the new week's count.
    const now = at('2026-09-27', 12)
    expect(effectiveProgress(getTaskById(met.id)!, TEST_TIMEZONE, now, 'sunday')).toBe(0)
    expect(rolloverTrackedPeriods(now)).toEqual({ anchored: 0, rolled: 2 })

    // Met: Mon 21 → Sun 27, 2 of 2 — a completion. The Sunday tap is carried.
    expect(periods(met.id)).toEqual([
      {
        period_start: '2026-09-21T05:00:00.000Z',
        period_end: '2026-09-27T05:00:00.000Z',
        logged: 2,
        target: 2,
        met: 1,
      },
    ])
    expect(completions(met.id)).toBe(1)
    expect(getTaskById(met.id)!.completion_count).toBe(1)
    expect(getTaskById(met.id)!.progress_current).toBe(1)
    expect(anchor(met.id)).toBe('2026-09-27T05:00:00.000Z')

    // Short: 1 of 3 recorded, no completion; its Sunday tap carried too.
    expect(periods(short.id)).toEqual([expect.objectContaining({ logged: 1, target: 3, met: 0 })])
    expect(completions(short.id)).toBe(0)
    expect(getTaskById(short.id)!.progress_current).toBe(1)

    // Aligned from here on: next turn is Sunday Oct 4, not Monday.
    expect(rolloverTrackedPeriods(at('2026-10-03', 23, 59)).rolled).toBe(0)
    expect(rolloverTrackedPeriods(at('2026-10-04', 0, 1)).rolled).toBe(2)
    expect(periods(met.id)[1]).toMatchObject({
      period_start: '2026-09-27T05:00:00.000Z',
      period_end: '2026-10-04T05:00:00.000Z',
      logged: 1,
    })
  })

  test('TR-063: the on-write rollover closes the stretch first, so a Sunday tap after the switch lands in the new week', () => {
    setWeekStart('monday')
    const q = quota(2)
    rolloverTrackedPeriods(at('2026-09-23'))
    logAt(q.id, at('2026-09-22'))
    setWeekStart('sunday')
    // No cron yet; the tap itself closes the Mon–Sat stretch.
    logAt(q.id, at('2026-09-27', 8))
    expect(periods(q.id)).toEqual([
      expect.objectContaining({ period_end: '2026-09-27T05:00:00.000Z', logged: 1, met: 0 }),
    ])
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })

  test('TR-064: flipping Sunday→Monday mid-week ends the week at the Monday just gone; Mon–Wed taps carry', () => {
    const q = quota(5)
    rolloverTrackedPeriods(at('2026-09-27', 1))
    expect(anchor(q.id)).toBe('2026-09-27T05:00:00.000Z')
    logAt(q.id, at('2026-09-27', 12)) // Sunday
    logAt(q.id, at('2026-09-29', 12)) // Tuesday
    logAt(q.id, at('2026-09-30', 8)) // Wednesday

    setWeekStart('monday')
    expect(rolloverTrackedPeriods(at('2026-09-30', 10), TEST_USER_ID).rolled).toBe(1)
    expect(periods(q.id)).toEqual([
      {
        period_start: '2026-09-27T05:00:00.000Z',
        period_end: '2026-09-28T05:00:00.000Z',
        logged: 1,
        target: 5,
        met: 0,
      },
    ])
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(anchor(q.id)).toBe('2026-09-28T05:00:00.000Z')
    // And now it turns on Mondays.
    expect(rolloverTrackedPeriods(at('2026-10-04', 23)).rolled).toBe(0)
    expect(rolloverTrackedPeriods(at('2026-10-05', 0, 1)).rolled).toBe(1)
  })

  test('TR-065: INTERVAL=2 — the misaligned stretch ends at the next boundary, then fortnights run from it', () => {
    setWeekStart('monday')
    const q = quota(4, 'FREQ=WEEKLY;INTERVAL=2')
    rolloverTrackedPeriods(at('2026-09-23'))
    expect(anchor(q.id)).toBe('2026-09-21T05:00:00.000Z')
    logAt(q.id, at('2026-09-24'))

    setWeekStart('sunday')
    expect(rolloverTrackedPeriods(at('2026-09-27', 12)).rolled).toBe(1)
    expect(periods(q.id)[0]).toMatchObject({
      period_start: '2026-09-21T05:00:00.000Z',
      period_end: '2026-09-27T05:00:00.000Z',
      logged: 1,
    })
    // A full two weeks from Sunday 27: Sun Oct 4 is mid-period, Oct 11 ends it.
    expect(rolloverTrackedPeriods(at('2026-10-04', 12)).rolled).toBe(0)
    expect(rolloverTrackedPeriods(at('2026-10-11', 0, 1)).rolled).toBe(1)
    expect(periods(q.id)[1]).toMatchObject({
      period_start: '2026-09-27T05:00:00.000Z',
      period_end: '2026-10-11T05:00:00.000Z',
    })
  })
})

describe('Week start: DST, catch-up, Quick Take', () => {
  withTestDb()

  test('TR-066: a DST week (fall back Nov 1) still turns at Sunday 00:00 local', () => {
    // Anchor Sun Nov 1 00:00 CDT (05:00Z); the clocks fall back at 02:00 that
    // day, so the week is 169 real hours and ends Sun Nov 8 00:00 CST (06:00Z).
    vi.setSystemTime(at('2026-11-03'))
    const q = quota(1)
    rolloverTrackedPeriods(at('2026-11-03'))
    expect(anchor(q.id)).toBe('2026-11-01T05:00:00.000Z')
    expect(rolloverTrackedPeriods(at('2026-11-07', 23, 59)).rolled).toBe(0)
    expect(rolloverTrackedPeriods(at('2026-11-08', 0, 1)).rolled).toBe(1)
    const [p] = periods(q.id)
    expect(p.period_end).toBe('2026-11-08T06:00:00.000Z')
    expect(DateTime.fromISO(p.period_end).setZone(TEST_TIMEZONE).toFormat('ccc HH:mm')).toBe(
      'Sun 00:00',
    )
  })

  test('TR-067: a server down across the switch catches up — the stretch, then whole Sunday weeks', () => {
    setWeekStart('monday')
    const q = quota(1)
    rolloverTrackedPeriods(at('2026-09-23'))
    logAt(q.id, at('2026-09-23', 13))
    setWeekStart('sunday')
    logAt(q.id, at('2026-10-01')) // lands after the stretch closed (on-write rollover)
    // Nothing else until Oct 12.
    expect(rolloverTrackedPeriods(at('2026-10-12')).rolled).toBe(2)
    expect(periods(q.id).map((p) => [p.period_start, p.period_end, p.logged, p.met])).toEqual([
      ['2026-09-21T05:00:00.000Z', '2026-09-27T05:00:00.000Z', 1, 1],
      ['2026-09-27T05:00:00.000Z', '2026-10-04T05:00:00.000Z', 1, 1],
      ['2026-10-04T05:00:00.000Z', '2026-10-11T05:00:00.000Z', 0, 0],
    ])
  })

  test('TR-068: Quick Take counts "due this week" over the user\'s week', () => {
    // Wednesday Sep 23. Due Sun 20 is in a Sunday week but not a Monday one;
    // due Sun 27 is the reverse.
    const tasks = [
      { due: '2026-09-20T15:00:00Z' },
      { due: '2026-09-24T15:00:00Z' },
      { due: '2026-09-27T15:00:00Z' },
    ].map((t) => ({
      title: 't',
      project_name: null,
      due_at: t.due,
      priority: 0,
      labels: [],
      rrule: null,
    }))
    expect(buildTaskStats(tasks, TEST_TIMEZONE, 'sunday').dueThisWeek).toBe(2)
    expect(buildTaskStats(tasks, TEST_TIMEZONE, 'monday').dueThisWeek).toBe(2)
    const sundayOnly = [tasks[0]]
    expect(buildTaskStats(sundayOnly, TEST_TIMEZONE, 'sunday').dueThisWeek).toBe(1)
    expect(buildTaskStats(sundayOnly, TEST_TIMEZONE, 'monday').dueThisWeek).toBe(0)
  })
})
