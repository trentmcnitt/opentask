/**
 * TQ-EV: "DAY STARTS AT" PR 2 — EVERYTHING USES THE OPENTASK DATE (Trent,
 * 2026-10-24). One pure function maps an instant to its OpenTask date
 * (`openTaskDayOf`); every surface does plain calendar maths on that date.
 * Target and deadline timestamps never move — only which day's list they are
 * on.
 *
 * Pinned at day starts 03:00 (the default), 06:30 and 23:00 (a start after
 * 12:00 names the day by the next date), against midnight
 * (`CALENDAR_DAY_START`, the task queue's switch off — unchanged), at
 * instants in the late night (01:30 with 03:00: Now, Today, Upcoming, the
 * check-in day, decks and the quota week all read the previous day) and on
 * both America/Chicago DST nights (fall back 2026-11-01, which is also a
 * Sunday and a month start; spring forward 2027-03-14, a Sunday).
 *
 * The last block is the database side: daily stats, the Today count's
 * server read, and the switch.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { CALENDAR_DAY_START, openTaskDayBoundaries } from '@/lib/opentask-day'
import { formatDueTimeParts, formatLastLogged } from '@/lib/format-date'
import { getDayLabel } from '@/lib/quick-select-dates'
import { countTasks } from '@/lib/task-counts'
import { isRelevantNow } from '@/lib/now-view'
import { deckIsToday, segmentState, targetIsToday, upcomingState } from '@/lib/task-segments'
import { deckMenuDays } from '@/lib/deck-menu'
import { computeSnoozeTime } from '@/lib/snooze'
import { periodDaysLeft, periodElapsedFraction, quotaUnitStart } from '@/lib/track'
import { anchorOnPeriodStart, quotaPeriodEnd } from '@/lib/week-start'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { nextClockTick } from '@/lib/dashboard-clock'
import { getDb } from '@/core/db'
import { incrementDailyStat, getStatsSummary } from '@/core/stats'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { createTask, rolloverTrackedPeriods } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaStats } from '@/core/tasks/quotas'
import { getTaskById } from '@/core/tasks/read'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const MIDNIGHT = CALENDAR_DAY_START

/** A local wall-clock moment in Chicago, as a Date. */
function at(local: string): Date {
  return DateTime.fromISO(local, { zone: TZ }).toJSDate()
}
const iso = (local: string) => at(local).toISOString()

let nextId = 1
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: nextId++,
    user_id: 1,
    project_id: 1,
    title: 'task',
    done: false,
    done_at: null,
    progress_target: 1,
    is_reminder: false,
    is_tracked: false,
    progress_period_start: null,
    quota_prompt_config: null,
    quota_day_state: null,
    progress_current: 0,
    skip_count: 0,
    priority: 0,
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    anchor_dow: null,
    anchor_dom: null,
    repeat_anchor: null,
    target_days_before: null,
    target_time: null,
    target_slot_id: null,
    repeat_count: null,
    repeat_count_used: 0,
    repeat_until: null,
    original_title: null,
    short_title: null,
    original_due_at: null,
    deadline_at: null,
    horizon: null,
    horizon_set_at: null,
    last_considered_at: null,
    segment_deferred_at: null,
    segment_targeted_at: null,
    target_set_at: null,
    occurrence_at: null,
    attempts: 0,
    attempts_counted_through: null,
    growth_kept_at: null,
    queue_mark: false,
    try_tomorrow: false,
    queued_at: null,
    queued_from_due_at: null,
    rolled_over_at: null,
    on_deck_day: null,
    queued_from_deck_day: null,
    lead_days: null,
    lead_from: null,
    target_auto: false,
    last_notified_at: null,
    last_critical_alert_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    completion_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    notes: null,
    created_at: iso('2026-10-19T09:00'),
    updated_at: iso('2026-10-19T09:00'),
    ...overrides,
  }
}

// Sat 2026-10-24 is a Saturday (the default check-in day); Sun 10-25.
const SAT_2200 = at('2026-10-24T22:00')
const SUN_0130 = at('2026-10-25T01:30')

describe('TQ-EV: the late night is the day before (3:00 AM)', () => {
  test('TQ-EV01: the day boundaries — at Sun 01:30 "today" began Sat 03:00 and ends Sun 03:00', () => {
    const b = openTaskDayBoundaries(TZ, '03:00', SUN_0130)
    expect(b.todayStart).toEqual(at('2026-10-24T03:00'))
    expect(b.tomorrowStart).toEqual(at('2026-10-25T03:00'))
    expect(b.yesterdayStart).toEqual(at('2026-10-23T03:00'))
    expect(b.nextWeekStart).toEqual(at('2026-10-31T03:00'))
    // Midnight: the calendar day, as before.
    expect(openTaskDayBoundaries(TZ, MIDNIGHT, SUN_0130).todayStart).toEqual(at('2026-10-25T00:00'))
  })

  test('TQ-EV02: the Today pill counts a 2:00 AM target on the evening it belongs to', () => {
    const tasks = [
      makeTask({ due_at: iso('2026-10-25T02:00') }),
      makeTask({ due_at: iso('2026-10-25T09:00') }),
    ]
    expect(countTasks(tasks, TZ, '03:00', SAT_2200).today).toBe(1)
    expect(countTasks(tasks, TZ, MIDNIGHT, SAT_2200).today).toBe(0)
    // At 01:30 the 2:00 AM one is still today's; 9:00 AM is tomorrow's.
    expect(countTasks(tasks, TZ, '03:00', SUN_0130).today).toBe(1)
    expect(countTasks(tasks, TZ, MIDNIGHT, SUN_0130).today).toBe(2)
  })

  test('TQ-EV03: "Today" / "Tomorrow" labels — at 01:30, 9:00 AM is tomorrow', () => {
    const nine = iso('2026-10-25T09:00')
    expect(formatDueTimeParts(nine, TZ, '03:00', SUN_0130).relative).toBe('Tomorrow 9:00 AM')
    expect(formatDueTimeParts(nine, TZ, MIDNIGHT, SUN_0130).relative).toBe('9:00 AM')
    expect(getDayLabel(nine, TZ, '03:00', SUN_0130)).toBe('Tomorrow')
    expect(getDayLabel(iso('2026-10-24T20:00'), TZ, '03:00', SUN_0130)).toBe('Today')
    expect(getDayLabel(iso('2026-10-24T20:00'), TZ, MIDNIGHT, SUN_0130)).toBe('Yesterday')
    // A quota tap at 23:00 is "today" at 01:30.
    expect(formatLastLogged(iso('2026-10-24T23:00'), TZ, '03:00', SUN_0130)).toBe('today 11:00 PM')
    expect(formatLastLogged(iso('2026-10-24T23:00'), TZ, MIDNIGHT, SUN_0130)).toBe(
      'yesterday 11:00 PM',
    )
  })

  test('TQ-EV04: Now — a 2:00 AM target is "targeted today" the evening before', () => {
    // Picked at 21:00 the same evening: no heads-up day (a wait of one day).
    const t = makeTask({ due_at: iso('2026-10-25T02:00'), target_set_at: iso('2026-10-24T21:00') })
    expect(targetIsToday(t.due_at, TZ, SAT_2200, '03:00')).toBe(true)
    expect(targetIsToday(t.due_at, TZ, SAT_2200, MIDNIGHT)).toBe(false)
    expect(isRelevantNow(t, TZ, SAT_2200, { dayStart: '03:00' })).toBe(true)
    expect(isRelevantNow(t, TZ, SAT_2200, { dayStart: MIDNIGHT })).toBe(false)
  })

  test('TQ-EV05: the check-in day (Saturday) is an OpenTask date — it starts at 3:00 and lasts until Sunday 3:00', () => {
    const weeks = makeTask({ horizon: 'weeks' })
    // Sat 02:00 is still Friday: the weeks segment has not come round yet.
    expect(segmentState(weeks, TZ, at('2026-10-24T02:00'), '03:00', 6)).toBeNull()
    expect(segmentState(weeks, TZ, at('2026-10-24T02:00'), MIDNIGHT, 6)).toMatchObject({
      horizon: 'weeks',
      state: 'waiting',
    })
    expect(segmentState(weeks, TZ, at('2026-10-24T03:00'), '03:00', 6)?.state).toBe('waiting')
    // Considered Sat 22:00: still considered at Sun 01:30, gone from Sunday's list at 3:00.
    const done = { ...weeks, last_considered_at: SAT_2200.toISOString() }
    expect(segmentState(done, TZ, SUN_0130, '03:00', 6)?.state).toBe('considered')
    expect(segmentState(done, TZ, SUN_0130, MIDNIGHT, 6)).toBeNull()
    expect(segmentState(done, TZ, at('2026-10-25T03:00'), '03:00', 6)).toBeNull()
  })

  test('TQ-EV06: Upcoming — a heads-up day starts at 3:00, not midnight', () => {
    // Target Wed Oct 28, set Sat Oct 24: wait 4 → one heads-up, Tue Oct 27.
    const t = makeTask({
      due_at: iso('2026-10-28T09:00'),
      target_set_at: iso('2026-10-24T10:00'),
    })
    expect(upcomingState(t, TZ, at('2026-10-27T01:30'), '03:00')).toBeNull()
    expect(upcomingState(t, TZ, at('2026-10-27T01:30'), MIDNIGHT)?.state).toBe('waiting')
    expect(upcomingState(t, TZ, at('2026-10-27T03:00'), '03:00')?.state).toBe('waiting')
    // Considered at 23:00 Tue: considered at 01:30 Wed, on its target's day after 3:00.
    const seen = { ...t, last_considered_at: iso('2026-10-27T23:00') }
    expect(upcomingState(seen, TZ, at('2026-10-28T01:30'), '03:00')?.state).toBe('considered')
    expect(upcomingState(seen, TZ, at('2026-10-28T03:00'), '03:00')).toBeNull()
  })

  test('TQ-EV07: decks — at 01:30 "today" is Saturday; the menu\'s Tomorrow is Sunday', () => {
    expect(deckIsToday({ on_deck_day: '2026-10-25' }, TZ, SUN_0130, '03:00')).toBe(false)
    expect(deckIsToday({ on_deck_day: '2026-10-24' }, TZ, SUN_0130, '03:00')).toBe(true)
    expect(deckIsToday({ on_deck_day: '2026-10-25' }, TZ, SUN_0130, MIDNIGHT)).toBe(true)
    expect(deckMenuDays(TZ, SUN_0130, '03:00')[0]).toMatchObject({
      label: 'Tomorrow',
      day: '2026-10-25',
    })
    expect(deckMenuDays(TZ, SUN_0130, MIDNIGHT)[0].day).toBe('2026-10-26')
  })

  test('TQ-EV08: Defer\'s "tomorrow" at 01:30 is this morning — the next OpenTask day', () => {
    expect(computeSnoozeTime('tomorrow', TZ, '08:30', '03:00', [], SUN_0130)).toBe(
      iso('2026-10-25T08:30'),
    )
    expect(computeSnoozeTime('tomorrow', TZ, '08:30', MIDNIGHT, [], SUN_0130)).toBe(
      iso('2026-10-26T08:30'),
    )
    // "Next period" is still TODAY while it comes before the day turns: a
    // 2:00 AM period at 01:30 is today's (midnight: today's too).
    const slots = [{ start_time: '02:00' }, { start_time: '12:00' }]
    expect(computeSnoozeTime('next_period', TZ, '08:30', '03:00', slots, SUN_0130)).toBe(
      iso('2026-10-25T02:00'),
    )
    // At 22:00 the next one (2:00 AM) is still today's day with 3:00 — not
    // with midnight, which gives the top of the next hour.
    expect(computeSnoozeTime('next_period', TZ, '08:30', '03:00', slots, SAT_2200)).toBe(
      iso('2026-10-25T02:00'),
    )
    expect(computeSnoozeTime('next_period', TZ, '08:30', MIDNIGHT, slots, SAT_2200)).toBe(
      iso('2026-10-24T23:00'),
    )
  })

  test('TQ-EV09: the quota week — at Sun 01:30 the week (Sunday start) is still last week', () => {
    expect(periodDaysLeft('WEEKLY', TZ, SUN_0130, 'sunday', '03:00')).toBe(1)
    expect(periodDaysLeft('WEEKLY', TZ, SUN_0130, 'sunday', MIDNIGHT)).toBe(7)
    expect(periodDaysLeft('WEEKLY', TZ, at('2026-10-25T03:00'), 'sunday', '03:00')).toBe(7)
    const local = DateTime.fromJSDate(SUN_0130).setZone(TZ)
    expect(quotaUnitStart(local, 'weeks', 'sunday', '03:00').toJSDate()).toEqual(
      at('2026-10-18T03:00'),
    )
    expect(quotaUnitStart(local, 'weeks', 'sunday', MIDNIGHT).toJSDate()).toEqual(
      at('2026-10-25T00:00'),
    )
    // A monday-start week too: Mon 02:00 is still the old week's Sunday.
    expect(periodDaysLeft('WEEKLY', TZ, at('2026-10-26T02:00'), 'monday', '03:00')).toBe(1)
    // "% of the week gone" ends at the day start: 01:30 Sunday is ~99%, not 0%.
    expect(periodElapsedFraction('WEEKLY', TZ, SUN_0130, 'sunday', '03:00')).toBeGreaterThan(0.99)
    expect(periodElapsedFraction('WEEKLY', TZ, SUN_0130, 'sunday', MIDNIGHT)).toBeLessThan(0.01)
  })

  test("TQ-EV10: a quota period is its first DATE — it ends at the day start of the next period's first date, a midnight anchor keeping its date (no short period); only a misaligned date is a transition", () => {
    const z = (local: string) => DateTime.fromISO(local, { zone: TZ })
    const end = (
      local: string,
      unit: 'days' | 'weeks' | 'months' | 'years',
      n: number,
      ds: string,
    ) => quotaPeriodEnd(z(local), unit, n, 'sunday', ds).toJSDate()
    // Aligned week: Sun 03:00 → Sun 03:00; a fortnight keeps its phase.
    expect(end('2026-10-18T03:00', 'weeks', 1, '03:00')).toEqual(at('2026-10-25T03:00'))
    expect(end('2026-10-18T03:00', 'weeks', 2, '03:00')).toEqual(at('2026-11-01T03:00'))
    // A week anchored at midnight (before the day start moved) is still Sunday
    // Oct 18's week: it runs to Oct 25's 03:00 — three hours long, once.
    expect(end('2026-10-18T00:00', 'weeks', 1, '03:00')).toEqual(at('2026-10-25T03:00'))
    expect(anchorOnPeriodStart(z('2026-10-18T00:00'), 'weeks', 'sunday')).toBe(true)
    // Months and years the same.
    expect(end('2026-10-01T03:00', 'months', 1, '03:00')).toEqual(at('2026-11-01T03:00'))
    expect(end('2026-10-01T00:00', 'months', 1, '03:00')).toEqual(at('2026-11-01T03:00'))
    expect(end('2026-01-01T03:00', 'years', 1, '03:00')).toEqual(at('2027-01-01T03:00'))
    // Midnight: exactly as before (local midnights).
    expect(end('2026-10-01T00:00', 'months', 1, MIDNIGHT)).toEqual(at('2026-11-01T00:00'))
    // A misaligned date (a Monday anchor in Sunday weeks) is the transition:
    // it ends at the next week's start, whatever the day start.
    expect(anchorOnPeriodStart(z('2026-10-19T00:00'), 'weeks', 'sunday')).toBe(false)
    expect(end('2026-10-19T00:00', 'weeks', 2, '03:00')).toEqual(at('2026-10-25T03:00'))
    expect(end('2026-10-19T00:00', 'weeks', 2, MIDNIGHT)).toEqual(at('2026-10-25T00:00'))
  })

  test("TQ-EV11: the overdue fallback — a repeat with no target is not due from tonight's 1:00 AM occurrence yet", () => {
    const t = {
      due_at: null,
      rrule: 'FREQ=DAILY',
      anchor_time: '01:00',
      recurrence_mode: 'from_due' as const,
    }
    // At 23:00 Sat, the day's occurrence is tomorrow 01:00 (still Saturday's day).
    expect(effectiveDueAt(t, TZ, '03:00', at('2026-10-24T23:00'))).toEqual(at('2026-10-25T01:00'))
    // Midnight: today's was 01:00 this morning — overdue.
    expect(effectiveDueAt(t, TZ, MIDNIGHT, at('2026-10-24T23:00'))).toEqual(at('2026-10-24T01:00'))
  })

  test('TQ-EV12: the dashboard clock wakes at the day start, not midnight', () => {
    expect(nextClockTick([], SAT_2200, TZ, '03:00')).toEqual(at('2026-10-25T03:00'))
    expect(nextClockTick([], SAT_2200, TZ, MIDNIGHT)).toEqual(at('2026-10-25T00:00'))
  })
})

describe('TQ-EV: other day starts', () => {
  test("TQ-EV20: 06:30 — at 06:00 a 9:00 AM time is tomorrow; a 6:15 AM target set the evening before is today's", () => {
    const at0600 = at('2026-10-20T06:00')
    expect(formatDueTimeParts(iso('2026-10-20T09:00'), TZ, '06:30', at0600).relative).toBe(
      'Tomorrow 9:00 AM',
    )
    expect(formatDueTimeParts(iso('2026-10-20T06:15'), TZ, '06:30', at0600).relative).toBe('in 15m')
    const t = makeTask({ due_at: iso('2026-10-20T06:15') })
    expect(countTasks([t], TZ, '06:30', at('2026-10-19T22:00')).today).toBe(1)
    expect(countTasks([t], TZ, MIDNIGHT, at('2026-10-19T22:00')).today).toBe(0)
  })

  test("TQ-EV21: 23:00 — Saturday 23:30 is already Sunday: the new week, Sunday's labels, Sunday's decks", () => {
    const sat2330 = at('2026-10-24T23:30')
    expect(periodDaysLeft('WEEKLY', TZ, sat2330, 'sunday', '23:00')).toBe(7)
    expect(periodDaysLeft('WEEKLY', TZ, sat2330, 'sunday', MIDNIGHT)).toBe(1)
    const local = DateTime.fromJSDate(sat2330).setZone(TZ)
    // The week named by its Sunday starts on Saturday at 23:00.
    expect(quotaUnitStart(local, 'weeks', 'sunday', '23:00').toJSDate()).toEqual(
      at('2026-10-24T23:00'),
    )
    expect(formatDueTimeParts(iso('2026-10-25T09:00'), TZ, '23:00', sat2330).relative).toBe(
      '9:00 AM',
    )
    expect(formatDueTimeParts(iso('2026-10-26T09:00'), TZ, '23:00', sat2330).relative).toBe(
      'Tomorrow 9:00 AM',
    )
    expect(deckIsToday({ on_deck_day: '2026-10-25' }, TZ, sat2330, '23:00')).toBe(true)
    // No late night after a start past noon: at 01:30 Sunday it is still Sunday.
    expect(openTaskDayBoundaries(TZ, '23:00', SUN_0130).todayStart).toEqual(at('2026-10-24T23:00'))
    // A month: Oct 31 23:30 is already November.
    expect(periodDaysLeft('MONTHLY', TZ, at('2026-10-31T23:30'), 'sunday', '23:00')).toBe(30)
  })
})

describe('TQ-EV: both DST nights', () => {
  test('TQ-EV30: fall back (Sun 2026-11-01, a month start): both 01:30s are October; November starts at 03:00 CST', () => {
    const first = DateTime.fromObject(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      { zone: TZ },
    ).toJSDate() // 01:30 CDT
    const second = new Date(first.getTime() + 60 * 60 * 1000) // 01:30 CST
    for (const t of [first, second]) {
      expect(periodDaysLeft('MONTHLY', TZ, t, 'sunday', '03:00')).toBe(1)
      expect(periodDaysLeft('WEEKLY', TZ, t, 'sunday', '03:00')).toBe(1)
      expect(openTaskDayBoundaries(TZ, '03:00', t).tomorrowStart.toISOString()).toBe(
        '2026-11-01T09:00:00.000Z',
      )
    }
    const oct = DateTime.fromISO('2026-10-01T03:00', { zone: TZ })
    expect(quotaPeriodEnd(oct, 'months', 1, 'sunday', '03:00').toUTC().toISO()).toBe(
      '2026-11-01T09:00:00.000Z',
    )
    // 25 real hours that day, one day in the count: Sunday 03:00 → Monday 03:00.
    const nov1 = openTaskDayBoundaries(TZ, '03:00', at('2026-11-01T12:00'))
    expect(nov1.tomorrowStart.getTime() - nov1.todayStart.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  test('TQ-EV31: spring forward (Sun 2027-03-14) with a 02:30 start: the day — and the week — turn at 03:00, the next valid minute', () => {
    const b = openTaskDayBoundaries(TZ, '02:30', at('2027-03-14T01:59'))
    expect(b.todayStart).toEqual(at('2027-03-13T02:30'))
    expect(b.tomorrowStart.toISOString()).toBe('2027-03-14T08:00:00.000Z') // 03:00 CDT
    expect(periodDaysLeft('WEEKLY', TZ, at('2027-03-14T01:59'), 'sunday', '02:30')).toBe(1)
    expect(periodDaysLeft('WEEKLY', TZ, at('2027-03-14T03:00'), 'sunday', '02:30')).toBe(7)
    const week = DateTime.fromISO('2027-03-07T02:30', { zone: TZ })
    expect(quotaPeriodEnd(week, 'weeks', 1, 'sunday', '02:30').toUTC().toISO()).toBe(
      '2027-03-14T08:00:00.000Z',
    )
    expect(
      formatDueTimeParts(iso('2027-03-14T09:00'), TZ, '02:30', at('2027-03-14T01:30')).relative,
    ).toBe('Tomorrow 9:00 AM')
  })
})

describe('TQ-EV: the server reads the user’s day', () => {
  beforeAll(() => setupTestDb())
  beforeEach(() => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    getDb()
      .prepare("UPDATE users SET day_start_time = '03:00', day_start_slot_id = NULL WHERE id = ?")
      .run(TEST_USER_ID)
    getDb().prepare('DELETE FROM user_daily_stats WHERE user_id = ?').run(TEST_USER_ID)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('TQ-EV40: daily stats — a completion at 01:30 counts for the day before (switch off: the calendar day)', () => {
    expect(dayBoundaryForUser(TEST_USER_ID)).toBe('03:00')
    vi.setSystemTime(SUN_0130)
    incrementDailyStat(TEST_USER_ID, 'completions', TZ)
    expect(getStatsSummary(TEST_USER_ID, TZ).today).toMatchObject({
      date: '2026-10-24',
      completions: 1,
    })
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(dayBoundaryForUser(TEST_USER_ID)).toBe(MIDNIGHT)
    incrementDailyStat(TEST_USER_ID, 'completions', TZ)
    expect(getStatsSummary(TEST_USER_ID, TZ).today).toMatchObject({
      date: '2026-10-25',
      completions: 1,
    })
  })
})

describe('TQ-EV: transition periods and streaks', () => {
  beforeAll(() => setupTestDb())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })
  const periods = (id: number) =>
    getDb()
      .prepare(
        'SELECT period_start, period_end, met, transition FROM progress_periods WHERE task_id = ? ORDER BY period_start',
      )
      .all(id)
  const setDayStart = (time: string) =>
    getDb()
      .prepare('UPDATE users SET day_start_time = ?, day_start_slot_id = NULL WHERE id = ?')
      .run(time, TEST_USER_ID)
  const roll = (local: string) => {
    vi.setSystemTime(at(local))
    rolloverTrackedPeriods(at(local))
  }

  test('TQ-EV41: the switch going on (midnight → 03:00) keeps the week and the streak; a week-start change makes the one transition, which breaks no streak', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    getDb().prepare("UPDATE users SET week_start = 'sunday' WHERE id = ?").run(TEST_USER_ID)
    // Made Sun Oct 4 (midnight anchors, the switch off), met each week.
    vi.setSystemTime(at('2026-10-04T12:00'))
    const q = createTask({
      userId: TEST_USER_ID,
      userTimezone: TZ,
      input: { title: 'Run', rrule: 'FREQ=WEEKLY', progress_target: 1, is_tracked: true },
    })
    expect(getTaskById(q.id)!.progress_period_start).toBe(iso('2026-10-04T00:00'))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    roll('2026-10-12T12:00')
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    // The switch goes on Wednesday Oct 14 (the day starts at 3:00): the week
    // anchored Sun Oct 11 00:00 is still Oct 11's week — it now ends at Oct
    // 18's 03:00. Nothing closes early.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setDayStart('03:00')
    roll('2026-10-14T12:00')
    expect(getTaskById(q.id)).toMatchObject({
      progress_period_start: iso('2026-10-11T00:00'),
      progress_period_end: iso('2026-10-18T03:00'),
      progress_current: 1,
    })
    roll('2026-10-18T12:00')
    expect(periods(q.id)).toEqual([
      {
        period_start: iso('2026-10-04T00:00'),
        period_end: iso('2026-10-11T00:00'),
        met: 1,
        transition: 0,
      },
      {
        period_start: iso('2026-10-11T00:00'),
        period_end: iso('2026-10-18T03:00'),
        met: 1,
        transition: 0,
      },
    ])
    // Tue Oct 20: the week starts on Monday from now. Sunday Oct 18's week is
    // not a Monday week: it closes at Mon Oct 19 03:00, a one-day TRANSITION.
    getDb().prepare("UPDATE users SET week_start = 'monday' WHERE id = ?").run(TEST_USER_ID)
    roll('2026-10-20T12:00')
    expect(periods(q.id)[2]).toEqual({
      period_start: iso('2026-10-18T03:00'),
      period_end: iso('2026-10-19T03:00'),
      met: 0,
      transition: 1,
    })
    // Unmet, it is neither met nor missed, and the streak goes on.
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    roll('2026-10-26T12:00')
    expect(getQuotaStats(TEST_USER_ID, q.id)).toMatchObject({
      periods_met: 3,
      periods_missed: 0,
      current_streak: 3,
      longest_streak: 3,
    })
  })

  test('TQ-EV42: a day-start change mid-week (03:00 → 23:00) is no transition — a week missed is still missed', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    getDb().prepare("UPDATE users SET week_start = 'sunday' WHERE id = ?").run(TEST_USER_ID)
    setDayStart('03:00')
    vi.setSystemTime(at('2026-11-02T12:00'))
    const q = createTask({
      userId: TEST_USER_ID,
      userTimezone: TZ,
      input: { title: 'Swim', rrule: 'FREQ=WEEKLY', progress_target: 1, is_tracked: true },
    })
    expect(getTaskById(q.id)!.progress_period_start).toBe(iso('2026-11-01T03:00'))
    // Wednesday: the day now starts at 23:00. The week of Sun Nov 1 ends at
    // the day start of Sun Nov 8 — Sat Nov 7 23:00 — a full week, never a
    // transition; nothing logged, so it is MISSED.
    setDayStart('23:00')
    roll('2026-11-04T12:00')
    roll('2026-11-08T12:00')
    expect(periods(q.id)).toEqual([
      {
        period_start: iso('2026-11-01T03:00'),
        period_end: iso('2026-11-07T23:00'),
        met: 0,
        transition: 0,
      },
    ])
    expect(getQuotaStats(TEST_USER_ID, q.id)).toMatchObject({
      periods_missed: 1,
      current_streak: 0,
    })
    // And back (23:00 → 06:30): the week named Sun Nov 8 keeps its phase.
    setDayStart('06:30')
    roll('2026-11-15T12:00')
    expect(periods(q.id)[1]).toEqual({
      period_start: iso('2026-11-07T23:00'),
      period_end: iso('2026-11-15T06:30'),
      met: 0,
      transition: 0,
    })
  })
})
