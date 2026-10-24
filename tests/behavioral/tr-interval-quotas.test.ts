/**
 * TR-080..: interval quotas ("every 2 weeks", 2026-10-16).
 *
 * A quota's rule may carry INTERVAL (`FREQ=WEEKLY;INTERVAL=2`). The rollover
 * already honoured it; these pin what the interval-quota build added:
 * - the served period fields (`quotaPeriodFields`, on tasks and prompts):
 *   the window's end, its last day, and "by Oct 24" above interval 1;
 * - the anchor is stamped at create, and when a row becomes a quota;
 * - a FREQ or INTERVAL edit re-anchors to the current unit's start, carrying
 *   the taps logged since, as one undo entry (undo restores rule + anchor);
 * - the server's INTERVAL cap (days ≤ 30, weeks ≤ 12, months ≤ 12, yearly 1).
 *
 * Chicago, Sunday week start (the default). Tue 2026-10-13 is "today".
 */
import { WEEK_START_DEFAULT } from '@/lib/week-start'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, getTaskById, rolloverTrackedPeriods, updateTask } from '@/core/tasks'
import { bulkEdit } from '@/core/tasks/bulk'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaPromptsBySlot } from '@/core/tasks/quota-prompts'
import { executeRedo, executeUndo } from '@/core/undo'
import { QUOTA_INTERVAL_MESSAGE } from '@/core/validation'
import {
  groupByPeriod,
  intervalPeriodName,
  quotaIntervalAllowed,
  quotaPeriodFields,
  quotaRule,
  quotaWindow,
  taskPeriodLabel,
  trackSections,
} from '@/lib/track'
import { quotaCountAriaLabel, quotaSegmentWord } from '@/lib/quota-segments'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** A local wall-clock instant in Chicago. */
function at(date: string, hour = 12, minute = 0): Date {
  return DateTime.fromISO(`${date}T00:00`, { zone: TEST_TIMEZONE }).set({ hour, minute }).toJSDate()
}

/** Local midnight of `date` in Chicago, as the UTC ISO string an anchor is stored as. */
function midnight(date: string): string {
  return DateTime.fromISO(`${date}T00:00`, { zone: TEST_TIMEZONE }).toUTC().toISO() as string
}

function quota(rrule: string, target = 2, title = 'Water the ferns') {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, rrule, progress_target: target, is_tracked: true },
  })
}

function logAt(taskId: number, when: Date, delta = 1) {
  vi.setSystemTime(when)
  incrementProgress({ userId: TEST_USER_ID, taskId, delta })
}

function edit(taskId: number, input: Parameters<typeof updateTask>[0]['input']) {
  return updateTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId, input })
}

function periods(taskId: number) {
  return getDb()
    .prepare(
      'SELECT period_start, period_end, logged, met FROM progress_periods WHERE task_id = ? ORDER BY period_start',
    )
    .all(taskId)
}

beforeEach(() => {
  vi.setSystemTime(at('2026-10-13'))
  setupTestDb()
})
afterEach(() => {
  vi.useRealTimers()
  teardownTestDb()
})

describe('The served period (quotaWindow / quotaPeriodFields)', () => {
  const NOW = at('2026-10-13')
  const fields = (rrule: string, anchor: string | null) =>
    quotaPeriodFields(
      { rrule, progress_period_start: anchor, progress_target: 1, is_tracked: true },
      TEST_TIMEZONE,
      NOW,
      WEEK_START_DEFAULT,
      CALENDAR_DAY_START,
    )

  test('TR-080: every 2 weeks from Sun Oct 11 ends Oct 25 — last day Oct 24, "by Oct 24"', () => {
    expect(fields('FREQ=WEEKLY;INTERVAL=2', midnight('2026-10-11'))).toEqual({
      progress_period_end: midnight('2026-10-25'),
      period_interval: 2,
      period_last_day: '2026-10-24',
      period_label: 'by Oct 24',
    })
  })

  test('TR-081: interval 1 serves the end and last day but no label (clients keep "this week")', () => {
    expect(fields('FREQ=WEEKLY', midnight('2026-10-11'))).toEqual({
      progress_period_end: midnight('2026-10-18'),
      period_interval: 1,
      period_last_day: '2026-10-17',
      period_label: null,
    })
  })

  test('TR-082: every 2 months from Oct 1 is "by Nov 30"; every 3 days from Oct 12 is "by Oct 14"', () => {
    expect(fields('FREQ=MONTHLY;INTERVAL=2', midnight('2026-10-01')).period_label).toBe('by Nov 30')
    expect(fields('FREQ=DAILY;INTERVAL=3', midnight('2026-10-12')).period_label).toBe('by Oct 14')
  })

  test('TR-083: a window the cron has not closed yet already reads as the next one', () => {
    // Anchored Sep 27: Sep 27 – Oct 11 has ended; Oct 11 – Oct 25 is current.
    const w = quotaWindow(
      { rrule: 'FREQ=WEEKLY;INTERVAL=2', progress_period_start: midnight('2026-09-27') },
      TEST_TIMEZONE,
      NOW,
      WEEK_START_DEFAULT,
      CALENDAR_DAY_START,
    )!
    expect(w.start.toUTC().toISO()).toBe(midnight('2026-10-11'))
    expect(w.end.toUTC().toISO()).toBe(midnight('2026-10-25'))
  })

  test('TR-084: an unanchored quota reads from the start of the unit it is in', () => {
    expect(fields('FREQ=WEEKLY;INTERVAL=2', null).progress_period_end).toBe(midnight('2026-10-25'))
  })

  test("TR-085: a misaligned weekly anchor (week start flipped) shows the short period's real end", () => {
    // A Monday anchor under a Sunday week ends at the next Sunday boundary.
    expect(fields('FREQ=WEEKLY;INTERVAL=2', midnight('2026-10-12')).period_label).toBe('by Oct 17')
  })

  test('TR-086: not a quota → every field null', () => {
    expect(
      quotaPeriodFields(
        {
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          progress_period_start: null,
          progress_target: 1,
          is_tracked: false,
        },
        TEST_TIMEZONE,
        NOW,
        WEEK_START_DEFAULT,
        CALENDAR_DAY_START,
      ),
    ).toEqual({
      progress_period_end: null,
      period_interval: null,
      period_last_day: null,
      period_label: null,
    })
  })

  test('TR-087: quotaRule writes canonical order, INTERVAL only above 1', () => {
    expect(quotaRule('WEEKLY', 1)).toBe('FREQ=WEEKLY')
    expect(quotaRule('WEEKLY', 2)).toBe('FREQ=WEEKLY;INTERVAL=2')
  })
})

describe('Anchor at create, and the served fields on reads', () => {
  test("TR-090: create stamps this unit's start; the task read carries the period", () => {
    const q = quota('FREQ=WEEKLY;INTERVAL=2')
    const read = getTaskById(q.id)!
    expect(read.progress_period_start).toBe(midnight('2026-10-11'))
    expect(read.period_label).toBe('by Oct 24')
    expect(read.period_interval).toBe(2)
    expect(read.progress_period_end).toBe(midnight('2026-10-25'))
    // The rollover has nothing to anchor any more.
    expect(rolloverTrackedPeriods(at('2026-10-13'))).toEqual({ anchored: 0, rolled: 0 })
  })

  test('TR-091: a quota made at 23:58 on a Saturday belongs to THAT week, not the next', () => {
    vi.setSystemTime(at('2026-10-17', 23, 58))
    const q = quota('FREQ=WEEKLY;INTERVAL=2')
    vi.setSystemTime(at('2026-10-18', 0, 2))
    rolloverTrackedPeriods(at('2026-10-18', 0, 2))
    expect(getTaskById(q.id)!.progress_period_start).toBe(midnight('2026-10-11'))
    expect(getTaskById(q.id)!.period_label).toBe('by Oct 24')
  })

  test('TR-092: a monthly quota (interval 1) made mid-month is anchored to the 1st', () => {
    const q = quota('FREQ=MONTHLY')
    expect(getTaskById(q.id)!.progress_period_start).toBe(midnight('2026-10-01'))
    expect(getTaskById(q.id)!.period_label).toBeNull()
  })

  test('TR-093: a task that BECOMES a quota is anchored in the same write', () => {
    const t = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain task' },
    })
    expect(getTaskById(t.id)!.progress_period_start).toBeNull()
    edit(t.id, { is_tracked: true, rrule: 'FREQ=WEEKLY;INTERVAL=2' })
    expect(getTaskById(t.id)!.progress_period_start).toBe(midnight('2026-10-11'))
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)!.progress_period_start).toBeNull()
  })

  test('TR-094: prompts carry the interval, the end and the label', () => {
    const q = quota('FREQ=WEEKLY;INTERVAL=2')
    const prompts = [...getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE).values()].flat()
    const p = prompts.find((x) => x.task_id === q.id)!
    expect(p.period).toBe('WEEKLY')
    expect(p.period_interval).toBe(2)
    expect(p.period_end).toBe(midnight('2026-10-25'))
    expect(p.period_last_day).toBe('2026-10-24')
    expect(p.period_label).toBe('by Oct 24')
  })

  test('TR-095: prompting is unchanged for an interval quota — one prompt a day until met', () => {
    const q = quota('FREQ=WEEKLY;INTERVAL=2', 1)
    const today = () =>
      [...getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, new Date()).values()]
        .flat()
        .filter((x) => x.task_id === q.id)
    expect(today()).toHaveLength(1)
    vi.setSystemTime(at('2026-10-20'))
    expect(today()).toHaveLength(1)
    logAt(q.id, at('2026-10-20'))
    vi.setSystemTime(at('2026-10-21'))
    // Met: gone until the period resets (Oct 25).
    expect(today()).toHaveLength(0)
    vi.setSystemTime(at('2026-10-25', 9))
    expect(today()).toHaveLength(1)
  })
})

describe('Re-anchor on a period edit', () => {
  test('TR-100: weekly → monthly re-anchors to the 1st (the misaligned months fix)', () => {
    vi.setSystemTime(at('2026-10-04'))
    const q = quota('FREQ=WEEKLY', 5)
    logAt(q.id, at('2026-10-05')) // last week — closed by the rollover below
    rolloverTrackedPeriods(at('2026-10-18', 1))
    logAt(q.id, at('2026-10-18', 9))
    logAt(q.id, at('2026-10-19'))
    vi.setSystemTime(at('2026-10-19', 13))
    edit(q.id, { rrule: 'FREQ=MONTHLY' })
    const after = getTaskById(q.id)!
    expect(after.progress_period_start).toBe(midnight('2026-10-01'))
    // This week's two taps carry; the closed week's tap is not counted twice.
    expect(after.progress_current).toBe(2)
    expect(after.progress_period_end).toBe(midnight('2026-11-01'))
  })

  test("TR-101: monthly → weekly keeps only this week's taps", () => {
    const q = quota('FREQ=MONTHLY', 5)
    logAt(q.id, at('2026-10-05'))
    logAt(q.id, at('2026-10-12'))
    logAt(q.id, at('2026-10-13', 14))
    vi.setSystemTime(at('2026-10-13', 15))
    edit(q.id, { rrule: 'FREQ=WEEKLY' })
    const after = getTaskById(q.id)!
    expect(after.progress_period_start).toBe(midnight('2026-10-11'))
    expect(after.progress_current).toBe(2)
  })

  test('TR-102: weekly → every 2 weeks in week two starts the fortnight on this week', () => {
    vi.setSystemTime(at('2026-10-06'))
    const q = quota('FREQ=WEEKLY')
    logAt(q.id, at('2026-10-14'))
    vi.setSystemTime(at('2026-10-14', 13))
    edit(q.id, { rrule: 'FREQ=WEEKLY;INTERVAL=2' })
    const after = getTaskById(q.id)!
    expect(after.progress_period_start).toBe(midnight('2026-10-11'))
    expect(after.progress_current).toBe(1)
    expect(after.period_label).toBe('by Oct 24')
  })

  test('TR-103: undo puts the old rule, anchor and count back; redo re-applies them', () => {
    const q = quota('FREQ=MONTHLY', 5)
    logAt(q.id, at('2026-10-05'))
    logAt(q.id, at('2026-10-13', 9))
    vi.setSystemTime(at('2026-10-13', 10))
    edit(q.id, { rrule: 'FREQ=WEEKLY' })
    expect(getTaskById(q.id)!.progress_current).toBe(1)

    executeUndo(TEST_USER_ID)
    let t = getTaskById(q.id)!
    expect(t.rrule).toBe('FREQ=MONTHLY')
    expect(t.progress_period_start).toBe(midnight('2026-10-01'))
    expect(t.progress_current).toBe(2)

    executeRedo(TEST_USER_ID)
    t = getTaskById(q.id)!
    expect(t.rrule).toBe('FREQ=WEEKLY')
    expect(t.progress_period_start).toBe(midnight('2026-10-11'))
    expect(t.progress_current).toBe(1)
  })

  test('TR-104: a +1 before a period edit stays undoable once the edit is undone', () => {
    const q = quota('FREQ=MONTHLY', 5)
    logAt(q.id, at('2026-10-13', 9))
    vi.setSystemTime(at('2026-10-13', 10))
    edit(q.id, { rrule: 'FREQ=MONTHLY;INTERVAL=2' })
    executeUndo(TEST_USER_ID) // the edit
    executeUndo(TEST_USER_ID) // the +1: its period witness matches again
    expect(getTaskById(q.id)!.progress_current).toBe(0)
  })

  test('TR-105: editing anything else (title, target) leaves the anchor alone', () => {
    vi.setSystemTime(at('2026-10-04'))
    const q = quota('FREQ=WEEKLY;INTERVAL=2')
    vi.setSystemTime(at('2026-10-13'))
    edit(q.id, { title: 'Water the ferns well', progress_target: 3, rrule: q.rrule })
    expect(getTaskById(q.id)!.progress_period_start).toBe(midnight('2026-10-04'))
  })

  test('TR-106: an edit after the window ended (cron not run yet) records that period first', () => {
    vi.setSystemTime(at('2026-10-06'))
    const q = quota('FREQ=WEEKLY', 1)
    logAt(q.id, at('2026-10-07'))
    // Sunday Oct 11, 00:02 — the week has ended; the cron has not run.
    vi.setSystemTime(at('2026-10-11', 0, 2))
    edit(q.id, { rrule: 'FREQ=WEEKLY;INTERVAL=2' })
    expect(periods(q.id)).toEqual([
      {
        period_start: midnight('2026-10-04'),
        period_end: midnight('2026-10-11'),
        logged: 1,
        met: 1,
      },
    ])
    const t = getTaskById(q.id)!
    expect(t.progress_current).toBe(0)
    expect(t.progress_period_start).toBe(midnight('2026-10-11'))
  })

  test('TR-107: bulk edit re-anchors each quota, in one undo entry', () => {
    const a = quota('FREQ=WEEKLY', 2, 'Quota A')
    const b = quota('FREQ=WEEKLY', 2, 'Quota B')
    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [a.id, b.id],
      changes: { rrule: 'FREQ=MONTHLY;INTERVAL=3' },
    })
    for (const id of [a.id, b.id]) {
      expect(getTaskById(id)!.progress_period_start).toBe(midnight('2026-10-01'))
      expect(getTaskById(id)!.period_label).toBe('by Dec 31')
    }
    executeUndo(TEST_USER_ID)
    for (const id of [a.id, b.id]) {
      expect(getTaskById(id)!.rrule).toBe('FREQ=WEEKLY')
      expect(getTaskById(id)!.progress_period_start).toBe(midnight('2026-10-11'))
    }
  })
})

describe('The INTERVAL cap', () => {
  test('TR-110: the ranges — days 1–30, weeks 1–12, months 1–12, yearly 1', () => {
    expect(quotaIntervalAllowed('FREQ=DAILY;INTERVAL=30')).toBe(true)
    expect(quotaIntervalAllowed('FREQ=DAILY;INTERVAL=31')).toBe(false)
    expect(quotaIntervalAllowed('FREQ=WEEKLY;INTERVAL=12')).toBe(true)
    expect(quotaIntervalAllowed('FREQ=WEEKLY;INTERVAL=13')).toBe(false)
    expect(quotaIntervalAllowed('FREQ=MONTHLY;INTERVAL=13')).toBe(false)
    expect(quotaIntervalAllowed('FREQ=YEARLY')).toBe(true)
    expect(quotaIntervalAllowed('FREQ=YEARLY;INTERVAL=2')).toBe(false)
  })

  test('TR-111: create and edit refuse a quota rule past the range', () => {
    expect(() => quota('FREQ=DAILY;INTERVAL=45')).toThrow(QUOTA_INTERVAL_MESSAGE)
    expect(() => quota('FREQ=YEARLY;INTERVAL=2')).toThrow(QUOTA_INTERVAL_MESSAGE)
    const q = quota('FREQ=WEEKLY')
    expect(() => edit(q.id, { rrule: 'FREQ=WEEKLY;INTERVAL=13' })).toThrow()
    expect(() => edit(q.id, { rrule: 'FREQ=DAILY;INTERVAL=31' })).toThrow(QUOTA_INTERVAL_MESSAGE)
  })

  test('TR-112: a stored rule past the range stays editable while the edit leaves it alone', () => {
    const q = quota('FREQ=WEEKLY')
    getDb().prepare("UPDATE tasks SET rrule = 'FREQ=WEEKLY;INTERVAL=20' WHERE id = ?").run(q.id)
    edit(q.id, { title: 'Renamed' })
    expect(getTaskById(q.id)!.title).toBe('Renamed')
  })

  test('TR-113: the cap is a quota rule — a task may still repeat every 45 days', () => {
    const t = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Rotate the mattress', rrule: 'FREQ=DAILY;INTERVAL=45' },
    })
    expect(t.rrule).toContain('INTERVAL=45')
  })
})

describe('The web helpers: grouping, sections and words key on (FREQ, INTERVAL)', () => {
  const q = (rrule: string, label: string | null = null, current = 0, target = 1) =>
    ({
      title: rrule,
      rrule,
      progress_current: current,
      progress_target: target,
      period_label: label,
    }) as Task

  test('TR-120: each interval gets its own group, after its unit, shortest first', () => {
    const groups = groupByPeriod([
      q('FREQ=MONTHLY'),
      q('FREQ=WEEKLY;INTERVAL=3'),
      q('FREQ=WEEKLY'),
      q('FREQ=WEEKLY;INTERVAL=2'),
      q('FREQ=DAILY;INTERVAL=2'),
    ])
    expect(groups.map((g) => g.key)).toEqual([
      'DAILY/2',
      'WEEKLY',
      'WEEKLY/2',
      'WEEKLY/3',
      'MONTHLY',
    ])
    expect(groups.map((g) => g.period)).toEqual([
      'every 2 days',
      'this week',
      'every 2 weeks',
      'every 3 weeks',
      'this month',
    ])
  })

  test('TR-121: an interval section has a bar and a count but no clock', () => {
    const [week, fortnight] = trackSections(
      [q('FREQ=WEEKLY', null, 1, 2), q('FREQ=WEEKLY;INTERVAL=2', 'by Oct 24', 1, 1)],
      TEST_TIMEZONE,
      at('2026-10-13'),
      WEEK_START_DEFAULT,
      CALENDAR_DAY_START,
    )
    expect(week.timeLeft).not.toBeNull()
    expect(week.elapsedFraction).not.toBeNull()
    expect(fortnight).toMatchObject({
      key: 'WEEKLY/2',
      freq: 'WEEKLY',
      interval: 2,
      heading: 'every 2 weeks',
      timeLeft: null,
      elapsedFraction: null,
      barAriaLabel: '100% done',
      allMet: true,
    })
  })

  test("TR-122: one quota's words — the served label above interval 1, its FREQ's at 1", () => {
    expect(taskPeriodLabel(q('FREQ=WEEKLY'))).toBe('this week')
    expect(taskPeriodLabel(q('FREQ=WEEKLY;INTERVAL=2', 'by Oct 24'))).toBe('by Oct 24')
    // No served label (a row built by hand): the period's name, never "this week".
    expect(taskPeriodLabel(q('FREQ=WEEKLY;INTERVAL=2'))).toBe('every 2 weeks')
    expect(intervalPeriodName('DAILY', 3)).toBe('every 3 days')
    expect(intervalPeriodName('MONTHLY', 1)).toBe('this month')
  })

  test("TR-123: the segments' word and accessible name take the served label", () => {
    expect(quotaSegmentWord('WEEKLY')).toBe('week')
    expect(quotaSegmentWord('WEEKLY', 'by Oct 24')).toBe('by Oct 24')
    expect(quotaCountAriaLabel(1, 2, 'WEEKLY', 'by Oct 24')).toBe('1 of 2 by Oct 24')
    expect(quotaCountAriaLabel(1, 2, 'WEEKLY')).toBe('1 of 2 this week')
  })
})
