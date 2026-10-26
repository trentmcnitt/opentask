/**
 * The creation day is day 0 (Trent, 2026-10-12; docs/TASK-MODEL.md §
 * Recurrence Model). A repeating task given its rule with no date, on a rule
 * whose phase floats (`phaseFloats`: INTERVAL > 1, or a bare WEEKLY / MONTHLY /
 * YEARLY with no day), takes its first occurrence from the day the rule is
 * set — that day itself if its time has not passed, else the next grid point —
 * and every later occurrence stays on that grid (`occurrence_at` anchors it).
 *
 * Rules that pin their own phase (FREQ=DAILY, BYDAY=SU, BYMONTHDAY=1 at
 * INTERVAL=1) are exactly as before. Every date is LOCAL America/Chicago.
 */
import { CALENDAR_DAY_START, openTaskDaySpan } from '@/lib/opentask-day'
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone, updateTask } from '@/core/tasks'
import { bulkEdit } from '@/core/tasks/bulk'
import { computeFirstOccurrence, computeNextOccurrence } from '@/core/recurrence'
import { todaysOccurrence } from '@/core/recurrence/occurrence'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function local(iso: string | Date | null): string {
  const d = typeof iso === 'string' ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso as Date)
  return d.setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm")
}
/** The first occurrence of `rrule` asked at local time `now`. */
function first(rrule: string, now: string, anchorTime: string | null = null): string {
  return local(computeFirstOccurrence(rrule, anchorTime, tz, new Date(at(now)), CALENDAR_DAY_START))
}

describe('RD-CDAY: the first occurrence of a floating rule starts on the creation day', () => {
  test('RD-CDAY-001: every 22 days, made Mon Oct 12 before its time → Oct 12; after it → Nov 3', () => {
    expect(first('FREQ=DAILY;INTERVAL=22;BYHOUR=20;BYMINUTE=0', '2026-10-12T10:00')).toBe(
      '2026-10-12T20:00',
    )
    expect(first('FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0', '2026-10-12T10:00')).toBe(
      '2026-11-03T09:00',
    )
    // The time from anchor_time (a PATCH passes it) counts the same.
    expect(first('FREQ=DAILY;INTERVAL=22', '2026-10-12T10:00', '20:00')).toBe('2026-10-12T20:00')
    // Was Oct 22: the 2020 epoch's grid.
  })

  test('RD-CDAY-002: every 7 days and a bare FREQ=WEEKLY made Sunday → Sundays', () => {
    for (const rrule of [
      'FREQ=DAILY;INTERVAL=7;BYHOUR=12;BYMINUTE=0',
      'FREQ=WEEKLY;BYHOUR=12;BYMINUTE=0',
    ]) {
      expect(first(rrule, '2026-10-11T10:00')).toBe('2026-10-11T12:00')
      expect(first(rrule, '2026-10-11T13:00')).toBe('2026-10-18T12:00')
    }
    // Bare every 2 weeks made Sunday after its time → two Sundays on.
    expect(first('FREQ=WEEKLY;INTERVAL=2;BYHOUR=12;BYMINUTE=0', '2026-10-11T13:00')).toBe(
      '2026-10-25T12:00',
    )
  })

  test('RD-CDAY-003: bare MONTHLY / YEARLY take the creation day of month / date', () => {
    expect(first('FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0', '2026-10-12T08:00')).toBe('2026-10-12T09:00')
    expect(first('FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0', '2026-10-12T10:00')).toBe('2026-11-12T09:00')
    expect(first('FREQ=MONTHLY;INTERVAL=3;BYHOUR=9;BYMINUTE=0', '2026-10-12T10:00')).toBe(
      '2027-01-12T09:00',
    )
    // Bare yearly: was always Jan 1 (the epoch's date).
    expect(first('FREQ=YEARLY;BYHOUR=9;BYMINUTE=0', '2026-10-12T08:00')).toBe('2026-10-12T09:00')
    expect(first('FREQ=YEARLY;BYHOUR=9;BYMINUTE=0', '2026-10-12T10:00')).toBe('2027-10-12T09:00')
  })

  test('RD-CDAY-004: every N on named days — day 0 is the first matching day on or after today', () => {
    const fortnightlyMonday = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0'
    // Made Sunday → tomorrow (never later than the weekly rule), then every 2 weeks.
    expect(first(fortnightlyMonday, '2026-10-11T10:00')).toBe('2026-10-12T09:00')
    // Made on a Monday before its time → today; after it → the next grid point.
    expect(first(fortnightlyMonday, '2026-10-12T08:00')).toBe('2026-10-12T09:00')
    expect(first(fortnightlyMonday, '2026-10-12T10:00')).toBe('2026-10-26T09:00')
    // Two days: made Wednesday → Thursday this week.
    expect(
      first('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0', '2026-10-14T10:00'),
    ).toBe('2026-10-15T09:00')
    // Every 3 months on the 1st, made Oct 12 → Nov 1 (the epoch said Jan 1).
    expect(
      first('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0', '2026-10-12T10:00'),
    ).toBe('2026-11-01T09:00')
  })

  test('RD-CDAY-005: no time of day is local midnight — always passed, so one period on', () => {
    expect(first('FREQ=DAILY;INTERVAL=22', '2026-10-12T10:00')).toBe('2026-11-03T00:00')
  })

  test('RD-CDAY-006: DST — the creation day keeps its wall-clock time across both changes', () => {
    // Made Sat Oct 31 after 9 AM: every 7 days → Sat Nov 7 9:00 CST, across Nov 1.
    expect(first('FREQ=DAILY;INTERVAL=7;BYHOUR=9;BYMINUTE=0', '2026-10-31T10:00')).toBe(
      '2026-11-07T09:00',
    )
    // Made on the fall-back day itself, before 9 → that day 9:00 CST.
    expect(first('FREQ=DAILY;INTERVAL=7;BYHOUR=9;BYMINUTE=0', '2026-11-01T08:00')).toBe(
      '2026-11-01T09:00',
    )
    // Made on the spring-forward day (Sun Mar 14 2027), after the change → 9:00 CDT,
    // then Sun Mar 21 at 9:00.
    const rule = 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0'
    const f = computeFirstOccurrence(
      rule,
      null,
      tz,
      new Date(at('2027-03-14T08:00')),
      CALENDAR_DAY_START,
    )
    expect(local(f)).toBe('2027-03-14T09:00')
    expect(f.toISOString()).toBe('2027-03-14T14:00:00.000Z')
    const n = computeNextOccurrence({
      rrule: rule,
      recurrenceMode: 'from_due',
      anchorTime: null,
      timezone: tz,
      completedAt: new Date(at('2027-03-17T12:00')),
      prevDueAt: f,
      anchorAt: f,
    })
    expect(local(n)).toBe('2027-03-21T09:00')
  })
})

describe('RD-CDAY: rules that pin their own phase are exactly as before (regression)', () => {
  const PINNED = [
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    'FREQ=DAILY;INTERVAL=1;BYHOUR=21;BYMINUTE=30',
    'FREQ=DAILY',
    'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30',
    'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=7;BYMINUTE=0',
    'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0',
    'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
  ]
  test('RD-CDAY-010: the first occurrence is the epoch rule after now, as before', () => {
    let checked = 0
    for (const rrule of PINNED) {
      for (
        let t = Date.UTC(2026, 0, 3, 5);
        t < Date.UTC(2028, 0, 1);
        t += (5 * 24 + 7) * 3_600_000
      ) {
        const now = new Date(t)
        const before = computeNextOccurrence({
          rrule,
          recurrenceMode: 'from_due',
          anchorTime: null,
          timezone: tz,
          completedAt: now,
          prevDueAt: null,
        })
        expect(computeFirstOccurrence(rrule, null, tz, now, CALENDAR_DAY_START).toISOString()).toBe(
          before.toISOString(),
        )
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  test('RD-CDAY-011: a floating rule with no date at all still reads the epoch (unchanged)', () => {
    // A quota's bare period rule, or any repeating row with no date: nothing to
    // anchor at, so "is there one today?" is the epoch's answer, as before.
    const row = { rrule: 'FREQ=WEEKLY', anchor_time: null, due_at: null, occurrence_at: null }
    // Jan 1 2020 was a Wednesday.
    expect(
      todaysOccurrence(
        row,
        tz,
        openTaskDaySpan(new Date(at('2026-10-14T12:00')), tz, CALENDAR_DAY_START),
      ),
    ).not.toBeNull()
    expect(
      todaysOccurrence(
        row,
        tz,
        openTaskDaySpan(new Date(at('2026-10-11T12:00')), tz, CALENDAR_DAY_START),
      ),
    ).toBeNull()
  })
})

describe('RD-CDAY: every path that sets a rule without a date', () => {
  const u = { userId: TEST_USER_ID, userTimezone: tz }
  const EVERY_22 = 'FREQ=DAILY;INTERVAL=22;BYHOUR=20;BYMINUTE=0'

  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    vi.setSystemTime(new Date(at('2026-10-12T10:00')))
  })
  afterEach(() => vi.useRealTimers())

  test('RD-CDAY-020: createTask — today at its time; occurrence_at with it; done keeps the grid', () => {
    const t = createTask({ ...u, input: { title: 'Task', rrule: EVERY_22 } })
    expect(local(t.due_at)).toBe('2026-10-12T20:00')
    expect(t.occurrence_at).toBe(t.due_at)
    // Done two days late → Nov 3, on the grid (not Nov 5 + anything).
    vi.setSystemTime(new Date(at('2026-10-14T18:00')))
    const a = markDone({ ...u, taskId: t.id }).task
    expect(local(a.occurrence_at)).toBe('2026-11-03T20:00')
  })

  test('RD-CDAY-021: createTask with a date is untouched — its date is the anchor', () => {
    const t = createTask({
      ...u,
      input: { title: 'Task', rrule: EVERY_22, due_at: at('2026-10-20T20:00') },
    })
    expect(local(t.due_at)).toBe('2026-10-20T20:00')
    expect(t.occurrence_at).toBe(t.due_at)
  })

  test('RD-CDAY-022: a reminder made with an every-N rule starts today the same way', () => {
    const r = createTask({
      ...u,
      input: {
        title: 'Reminder',
        rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=18;BYMINUTE=0',
        is_reminder: true,
      },
    })
    expect(local(r.due_at)).toBe('2026-10-12T18:00')
    // Its today follows the grid from there: Oct 12, 15, 18.
    const on = (day: string) =>
      todaysOccurrence(r, tz, openTaskDaySpan(new Date(at(`${day}T12:00`)), tz, CALENDAR_DAY_START))
    expect(on('2026-10-13')).toBeNull()
    expect(local(on('2026-10-15'))).toBe('2026-10-15T18:00')
  })

  test('RD-CDAY-023: a quota gets no date (unchanged)', () => {
    const q = createTask({
      ...u,
      input: { title: 'Quota', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    expect(q.due_at).toBeNull()
    expect(q.occurrence_at).toBeNull()
  })

  test('RD-CDAY-024: PATCH adding the rule to a dateless task — the change day is day 0', () => {
    const t = createTask({ ...u, input: { title: 'Task' } })
    const r = updateTask({ ...u, taskId: t.id, input: { rrule: EVERY_22 } }).task
    expect(local(r.due_at)).toBe('2026-10-12T20:00')
    expect(r.occurrence_at).toBe(r.due_at)
    vi.setSystemTime(new Date(at('2026-10-12T21:00')))
    const late = createTask({ ...u, input: { title: 'Task' } })
    const r2 = updateTask({ ...u, taskId: late.id, input: { rrule: EVERY_22 } }).task
    expect(local(r2.due_at)).toBe('2026-11-03T20:00')
  })

  test('RD-CDAY-025: bulk edit adding the rule — the same first occurrence for each', () => {
    const a = createTask({ ...u, input: { title: 'A' } })
    const b = createTask({ ...u, input: { title: 'B' } })
    bulkEdit({ ...u, taskIds: [a.id, b.id], changes: { rrule: EVERY_22 } })
    const rows = getDb()
      .prepare('SELECT due_at, occurrence_at FROM tasks WHERE id IN (?, ?)')
      .all(a.id, b.id) as { due_at: string; occurrence_at: string }[]
    for (const row of rows) {
      expect(local(row.due_at)).toBe('2026-10-12T20:00')
      expect(row.occurrence_at).toBe(row.due_at)
    }
  })
})
