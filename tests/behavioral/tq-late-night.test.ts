/**
 * TQ-LN: THE LATE NIGHT IS THE EVENING BEFORE, AT EVERY USER-DAY ENTRY POINT
 * ("OpenTask day everywhere", part 2 — Trent, 2026-10-26). The test for every
 * item: at 00:30 Monday with a 3:00 AM day start, it must behave EXACTLY as
 * it did at 23:30 Sunday — the same OpenTask day.
 *
 * Each entry point below that turns "now" into a day — the new-rule weekday
 * default, enrichment's pin and "this weekend", a floating rule's first
 * occurrence, the deck menu, the day labels, "Morning of the deadline", the
 * skip-until floor and its until reading, the repeat-until floor, the
 * deadline chip, the target-time "night" labels and the date-only labels —
 * is asked the same question at both instants, and must answer the same.
 * Every block first asserts the premise (both instants are one OpenTask
 * day), then the Sunday-night answer itself, so the two can't be wrong
 * together.
 *
 * A second pair runs the same questions across the fall-back night (Sun Nov
 * 1 2026, America/Chicago — also a month start): Sun 00:30 CDT is still
 * Saturday Oct 31, like Sat 23:30.
 *
 * The scan guards (TQ-G01..G04, tq-day-guard.test.ts) catch the way a day is
 * worked out; this catches what it comes to, through any helper.
 */
import { afterEach, describe, test, expect, vi } from 'vitest'
import { DateTime } from 'luxon'
import { CALENDAR_DAY_START, openTaskDayOf } from '@/lib/opentask-day'
import { computeNextOccurrence } from '@/core/recurrence'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { skipOccurrence } from '@/core/tasks/skip'

import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'
import { draftFromTask, type EveryTimeContext, type EveryTimeTask } from '@/lib/every-time'
import { pinUnnamedDay, resolveDeckDay } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { computeFirstOccurrence } from '@/core/recurrence/compute-next'
import { deckMenuDays } from '@/lib/deck-menu'
import { formatQuickSelectHeader, getDayLabel } from '@/lib/quick-select-dates'
import { deadlineDayPick } from '@/lib/editor-target-labels'
import { parseUntil, planSkipUntil, skipUntil } from '@/core/tasks/skip-until'
import { skipUntilFirstDay } from '@/lib/task-segments'
import { repeatEndProblem } from '@/core/tasks/repeat-schedule'
import { deadlineChip } from '@/lib/deadline-chip'
import {
  formatDueTimeParts,
  formatLastLogged,
  formatTaskSince,
  openTaskDateLabel,
} from '@/lib/format-date'
import { formatSnoozeTarget } from '@/lib/field-labels'
import { userDayLine } from '@/core/ai/prompts'
import { upcomingGap } from '@/lib/task-segments'
import { computeInitialDisplay } from '@/hooks/useBulkQuickSelectDate'
import { formatTimeAgoLabel } from '@/lib/history-time-label'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const DAY_START = '03:00'

const local = (s: string) => DateTime.fromISO(s, { zone: TZ }).toJSDate()
const iso = (s: string) => local(s).toISOString()

/** The pair every test compares: the late night, and the evening before it. */
interface Night {
  name: string
  /** 00:30 on the calendar day after `evening`'s. */
  late: Date
  /** 23:30, the same OpenTask day. */
  evening: Date
  /** That OpenTask day (yyyy-MM-dd) and its weekday as an RRULE day. */
  day: string
  ruleDay: string
}

const NIGHTS: Night[] = [
  {
    name: 'Mon 00:30 vs Sun 23:30 (Oct 26 / Oct 25 2026)',
    late: local('2026-10-26T00:30'),
    evening: local('2026-10-25T23:30'),
    day: '2026-10-25',
    ruleDay: 'SU',
  },
  {
    name: 'fall-back night: Sun Nov 1 00:30 CDT vs Sat Oct 31 23:30',
    late: local('2026-11-01T00:30'),
    evening: local('2026-10-31T23:30'),
    day: '2026-10-31',
    ruleDay: 'SA',
  },
]

/** Both instants of a night, through `f`: the answers must be one. */
function same<T>(night: Night, f: (now: Date) => T): T {
  const evening = f(night.evening)
  expect(f(night.late)).toEqual(evening)
  return evening
}

function enrichment(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    title: 'Synthetic',
    due_at: null,
    deadline_at: null,
    horizon: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: '',
    ...overrides,
  } as EnrichmentResult
}

const EVERY_TIME_TASK: EveryTimeTask = {
  rrule: null,
  recurrence_mode: 'from_due',
  anchor_time: null,
  deadline_at: null,
  due_at: null,
  occurrence_at: null,
  repeat_anchor: null,
  target_days_before: null,
  target_time: null,
  on_deck_day: null,
}

describe.each(NIGHTS)('TQ-LN: $name', (night) => {
  test('TQ-LN00: the premise — both instants are one OpenTask day', () => {
    expect(openTaskDayOf(night.late, TZ, DAY_START)).toBe(night.day)
    expect(openTaskDayOf(night.evening, TZ, DAY_START)).toBe(night.day)
  })

  test("TQ-LN01: every-time — a new weekly rule's default day is the OpenTask day's weekday (draftFromTask)", () => {
    const ctx = (now: Date): EveryTimeContext => ({
      timezone: TZ,
      morningTime: '09:00',
      now,
      dayStart: DAY_START,
    })
    // A one-off with no date turned into a repeat.
    const oneOff = same(night, (now) => {
      const d = draftFromTask(EVERY_TIME_TASK, ctx(now))
      return { defaultDay: d.defaultDay, days: d.rule.days }
    })
    expect(oneOff).toEqual({ defaultDay: night.ruleDay, days: [night.ruleDay] })
    // A repeat with no occurrence yet (its weekly default when the days are cleared).
    const ruled = same(
      night,
      (now) =>
        draftFromTask({ ...EVERY_TIME_TASK, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, ctx(now))
          .defaultDay,
    )
    expect(ruled).toBe(night.ruleDay)
  })

  test('TQ-LN02: enrichment — a repeat with no day named is pinned to the OpenTask day (pinUnnamedDay)', () => {
    const weekly = same(
      night,
      (now) =>
        pinUnnamedDay(
          enrichment({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' }),
          'clean the fish tank every 2 weeks',
          TZ,
          now,
          DAY_START,
        ).rrule,
    )
    expect(weekly).toBe(`FREQ=WEEKLY;INTERVAL=2;BYDAY=${night.ruleDay}`)
    const monthly = same(
      night,
      (now) =>
        pinUnnamedDay(
          enrichment({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }),
          'pay the water bill every month',
          TZ,
          now,
          DAY_START,
        ).rrule,
    )
    // Oct 25 → the 25th; Oct 31 is the month's last day → -1.
    const dom = Number(night.day.slice(8))
    expect(monthly).toBe(`FREQ=MONTHLY;BYMONTHDAY=${dom === 31 ? '-1' : dom}`)
  })

  test('TQ-LN03: enrichment — "this weekend" reads the OpenTask weekday (resolveDeckDay)', () => {
    const deck = same(
      night,
      (now) =>
        resolveDeckDay(
          enrichment({ due_at: '2026-11-07' }),
          'clean out the garage this weekend',
          TZ,
          {
            morningTime: '09:00',
            todayTarget: now.toISOString(),
            rolloverTime: DAY_START,
            dayStart: DAY_START,
            checkInDay: 6,
          },
          now,
        ).on_deck_day,
    )
    // Sunday (or Saturday) night is still the weekend: today's deck.
    expect(deck).toBe(night.day)
  })

  test("TQ-LN04: a floating rule's first occurrence counts from the OpenTask day (computeFirstOccurrence)", () => {
    const rules = [
      'FREQ=DAILY;INTERVAL=22;BYHOUR=21;BYMINUTE=0',
      `FREQ=WEEKLY;INTERVAL=2;BYDAY=${night.ruleDay};BYHOUR=9;BYMINUTE=0`,
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=1;BYMINUTE=0',
      'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
    ]
    for (const rule of rules) {
      same(night, (now) => computeFirstOccurrence(rule, null, TZ, now, DAY_START).toISOString())
    }
    // Every 2 weeks on the OpenTask day's weekday: today's 9 AM has passed,
    // so the first is two weeks on (the long first gap Sunday night always had).
    const first = computeFirstOccurrence(rules[1], null, TZ, night.late, DAY_START)
    const expected = DateTime.fromISO(night.day, { zone: TZ })
      .plus({ weeks: 2 })
      .set({ hour: 9 })
      .toJSDate()
    expect(first.toISOString()).toBe(expected.toISOString())
  })

  test('TQ-LN05: the deck menu (deckMenuDays)', () => {
    const days = same(night, (now) => deckMenuDays(TZ, now, DAY_START, 6))
    expect(days[0].day > night.day).toBe(true)
  })

  test('TQ-LN06: the day labels and the quick panel header (getDayLabel, formatQuickSelectHeader)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    const targets = [
      d.plus({ days: 1 }).set({ hour: 1 }), // tonight, 1 AM
      d.plus({ days: 1 }).set({ hour: 9 }), // tomorrow morning
      d.plus({ days: 2 }).set({ hour: 1 }), // tomorrow night
      d.plus({ days: 3 }).set({ hour: 1 }), // the night of the day after
      d.plus({ days: 3 }).set({ hour: 9 }),
    ].map((t) => t.toJSDate().toISOString())
    const labels = same(night, (now) => targets.map((t) => getDayLabel(t, TZ, DAY_START, now)))
    const weekday = (n: number) => d.plus({ days: n }).toFormat('ccc')
    // A whole day's label: the OpenTask day the moment is on.
    expect(labels).toEqual(['Today', 'Tomorrow', 'Tomorrow', weekday(2), weekday(3)])
    const headers = same(night, (now) =>
      targets.map((t) => formatQuickSelectHeader(t, TZ, DAY_START, now)),
    )
    const date = (n: number) => d.plus({ days: n }).toFormat('LLL d')
    // With a time: between midnight and the day start, L9's "night" words,
    // and the date is the evening's too — the word and the date name one day
    // (2026-10-27; it was the moment's own date: "Mon night, Oct 27").
    expect(headers).toEqual([
      `Tonight, ${date(0)}, 1:00 AM`,
      `Tomorrow, ${date(1)}, 9:00 AM`,
      `Tomorrow night, ${date(1)}, 1:00 AM`,
      `${weekday(2)} night, ${date(2)}, 1:00 AM`,
      `${weekday(3)}, ${date(3)}, 9:00 AM`,
    ])
  })

  test('TQ-LN07: "Morning of the deadline" — near / far on OpenTask days (deadlineDayPick)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    const ctx = { timezone: TZ, morningTime: '09:00' }
    // A deadline two OpenTask days out: its weekday is said.
    const twoOut = d.plus({ days: 2 }).set({ hour: 18 }).toJSDate().toISOString()
    const far = same(night, (now) => deadlineDayPick(twoOut, ctx, now, DAY_START)?.label)
    expect(far).toBe(
      `Morning of the deadline · ${d.plus({ days: 2 }).toFormat('ccc')} 9:00 AM (Default task time)`,
    )
    // Tomorrow's: no weekday.
    const oneOut = d.plus({ days: 1 }).set({ hour: 18 }).toJSDate().toISOString()
    const near = same(night, (now) => deadlineDayPick(oneOut, ctx, now, DAY_START)?.label)
    expect(near).toBe('Morning of the deadline · 9:00 AM (Default task time)')
  })

  test('TQ-LN08: skip until — the floor is the next OpenTask day, and a date starts at its day start (skipUntilFirstDay, parseUntil, planSkipUntil)', () => {
    const tomorrow = DateTime.fromISO(night.day, { zone: TZ }).plus({ days: 1 }).toISODate()!
    expect(same(night, (now) => skipUntilFirstDay(TZ, now, DAY_START))).toBe(tomorrow)
    expect(same(night, (now) => parseUntil(tomorrow, TZ, now, DAY_START))).toBe(tomorrow)
    expect(() => parseUntil(night.day, TZ, night.late, DAY_START)).toThrow(/tomorrow or later/)
    // A daily 1 AM repeat skipped until tomorrow lands on tomorrow's OWN
    // 1 AM — the one in tomorrow's night, not tonight's.
    const task = {
      rrule: 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0',
      recurrence_mode: 'from_due',
      anchor_time: null,
      occurrence_at: iso(`${night.day}T01:00`),
      due_at: iso(`${night.day}T01:00`),
      is_reminder: false,
      is_tracked: false,
      progress_target: null,
      done: false,
      deleted_at: null,
      archived_at: null,
      on_deck_day: null,
      deadline_at: null,
      repeat_anchor: null,
      target_days_before: null,
      target_time: null,
      repeat_count: null,
      repeat_count_used: 0,
      repeat_until: null,
    } as unknown as Task
    const plan = same(night, (now) => planSkipUntil(task, TZ, tomorrow, now, DAY_START))
    const landing = DateTime.fromISO(tomorrow, { zone: TZ }).plus({ days: 1 }).set({ hour: 1 })
    expect(plan).toMatchObject({ kind: 'skip', landing: landing.toJSDate().toISOString() })
  })

  test('TQ-LN09: repeat until — today (the OpenTask day) is a valid last day (repeatEndProblem)', () => {
    const problem = same(night, (now) =>
      repeatEndProblem(
        {
          count: null,
          until: night.day,
          used: 0,
          countWritten: false,
          untilWritten: true,
          walkWritten: false,
          occurrenceAt: null,
          hasRule: true,
          isReminder: false,
          isTracked: false,
        },
        TZ,
        now,
        DAY_START,
      ),
    )
    expect(problem).toBeNull()
  })

  test('TQ-LN10: the deadline chip (deadlineChip)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    const deadline = d.plus({ days: 2 }).set({ hour: 1 }).toJSDate().toISOString()
    const chip = same(night, (now) => deadlineChip(deadline, TZ, now, DAY_START))
    expect(chip.text).toBe('Deadline tomorrow night')
  })

  test('TQ-LN11: target-time labels between midnight and the day start say "night" (formatDueTimeParts, formatSnoozeTarget)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    const tomorrowNight = d.plus({ days: 2 }).set({ hour: 1 }).toJSDate().toISOString()
    const laterNight = d.plus({ days: 3 }).set({ hour: 1 }).toJSDate().toISOString()
    const weekday = d.plus({ days: 2 }).toFormat('ccc')
    expect(
      same(night, (now) => formatDueTimeParts(tomorrowNight, TZ, DAY_START, now).relative),
    ).toBe('Tomorrow night 1:00 AM')
    expect(same(night, (now) => formatDueTimeParts(laterNight, TZ, DAY_START, now).relative)).toBe(
      `${weekday} night 1:00 AM`,
    )
    expect(same(night, (now) => formatSnoozeTarget(tomorrowNight, TZ, DAY_START, now))).toBe(
      'tomorrow night 1:00 AM',
    )
    expect(same(night, (now) => formatSnoozeTarget(laterNight, TZ, DAY_START, now))).toBe(
      `${weekday} night 1:00 AM`,
    )
  })

  test('TQ-LN12: past labels — a 1 AM log or anchor is the night of the day before (formatLastLogged, formatTaskSince)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    // 1 AM three calendar days back: the night of the day four days back.
    const logged = d.minus({ days: 2 }).set({ hour: 1 }).toJSDate().toISOString()
    const weekday = d.minus({ days: 3 }).toFormat('ccc')
    expect(same(night, (now) => formatLastLogged(logged, TZ, DAY_START, now))).toBe(
      `${weekday} night 1:00 AM`,
    )
    const since = same(
      night,
      (now) =>
        formatTaskSince(
          { rrule: null, due_at: null, original_due_at: null, created_at: logged },
          TZ,
          DAY_START,
          now,
        )?.label,
    )
    expect(since).toBe(`${weekday} night`)
  })

  test("TQ-LN13: date-only labels (archive, trash, a quota's start) name the moment's OpenTask date (openTaskDateLabel)", () => {
    // Done at the late-night instant: the same date as done at 23:30.
    const label = (at: Date) => openTaskDateLabel(at.toISOString(), TZ, DAY_START)
    expect(label(night.late)).toBe(label(night.evening))
    expect(label(night.late)).toBe(DateTime.fromISO(night.day).toFormat('LLL d'))
  })

  test("TQ-LN14: the enrichment prompt states the user's day only in the late night (userDayLine)", () => {
    const words = DateTime.fromISO(night.day).toFormat('ccc, LLL d')
    expect(userDayLine(night.late, TZ, DAY_START)).toContain(`User's day: ${words} —`)
    // At 23:30 the calendar date is the user's day: no line, the prompt as before.
    expect(userDayLine(night.evening, TZ, DAY_START)).toBe('')
    // The switch off (midnight): never.
    expect(userDayLine(night.late, TZ, CALENDAR_DAY_START)).toBe('')
  })

  test('TQ-LN15: Upcoming rows say "night" too — a Fri 01:00 target is "Thu night" (upcomingGap)', () => {
    const d = DateTime.fromISO(night.day, { zone: TZ })
    const at = (days: number) => d.plus({ days }).set({ hour: 1 }).toJSDate().toISOString()
    const word = (days: number) => d.plus({ days }).toFormat('ccc')
    const date = (days: number) => d.plus({ days }).toFormat('LLL d')
    // A Later row: a 1:00 AM target and deadline name their OpenTask days.
    const later = upcomingGap({ due_at: at(5), deadline_at: at(6) }, TZ, DAY_START, 'later')
    expect(later).toEqual({
      target: `Target ${word(4)} night ${date(4)}`,
      deadline: `deadline ${word(5)} night ${date(5)}`,
    })
    // A Tomorrow row: tomorrow's 1:00 AM is tomorrow NIGHT, said.
    expect(
      upcomingGap({ due_at: at(2), deadline_at: null }, TZ, DAY_START, 'tomorrow').target,
    ).toBe('Target tomorrow night 1:00 AM')
    // A daytime target is as before.
    const nine = d.plus({ days: 5 }).set({ hour: 9 }).toJSDate().toISOString()
    expect(upcomingGap({ due_at: nine, deadline_at: null }, TZ, DAY_START, 'later').target).toBe(
      `Target ${word(5)} ${date(5)}`,
    )
  })
})

/**
 * TQ-LN16–20: A DAY START AFTER NOON (an 11 PM start: Monday is Sun 23:00 →
 * Mon 23:00), from the PR #354 review (2026-10-26). Trent's ruling: a label
 * WITH A CLOCK TIME shows the moment's own calendar weekday and date, with no
 * cue — never an OpenTask weekday beside a calendar date ("Wed, Oct 27") —
 * and the night cue is for a start at or before 12:00 only. Grouping still
 * follows the OpenTask day. Each expected answer below is main's where the
 * ruling says so (checked against origin/main's code on the same inputs),
 * and with midnight (the switch off) every answer is main's.
 */
const LATE_START = '23:00'

/** A from-completion repeat, as skip until reads it. */
function completionRepeat(rrule: string, dueAt: string): Task {
  return {
    rrule,
    recurrence_mode: 'from_completion',
    anchor_time: null,
    occurrence_at: dueAt,
    due_at: dueAt,
    is_reminder: false,
    is_tracked: false,
    progress_target: null,
    done: false,
    deleted_at: null,
    archived_at: null,
    on_deck_day: null,
    deadline_at: null,
    repeat_anchor: null,
    target_days_before: null,
    target_time: null,
    repeat_count: null,
    repeat_count_used: 0,
    repeat_until: null,
  } as unknown as Task
}

describe('TQ-LN: a day start after noon (11 PM)', () => {
  const satNoon = local('2026-10-24T12:30')
  const tue2347 = iso('2026-10-27T23:47')

  test('TQ-LN16: a timed label names the calendar day — "Tue, Oct 27, 11:47 PM", never "Wed, Oct 27" (formatQuickSelectHeader, formatDueTimeParts, formatSnoozeTarget)', () => {
    // The premise: Tue 23:47 is on Wednesday's list.
    expect(openTaskDayOf(new Date(tue2347), TZ, LATE_START)).toBe('2026-10-28')
    for (const dayStart of [LATE_START, DAY_START, CALENDAR_DAY_START]) {
      expect(formatQuickSelectHeader(tue2347, TZ, dayStart, satNoon)).toBe('Tue, Oct 27, 11:47 PM')
      expect(formatDueTimeParts(tue2347, TZ, dayStart, satNoon).relative).toBe('Tue 11:47 PM')
      expect(formatSnoozeTarget(tue2347, TZ, dayStart, satNoon)).toBe('Tue 11:47 PM')
    }
    // A word that would contradict the date gives way to the weekday: at Sat
    // 12:30 a Sat 23:30 target is on Sunday's list ("Tomorrow" on main) but
    // dated Saturday.
    const sat2330 = iso('2026-10-24T23:30')
    expect(formatQuickSelectHeader(sat2330, TZ, LATE_START, satNoon)).toBe('Sat, Oct 24, 11:30 PM')
    expect(formatDueTimeParts(sat2330, TZ, LATE_START, satNoon).relative).toBe('Sat 11:30 PM')
    expect(formatSnoozeTarget(sat2330, TZ, LATE_START, satNoon)).toBe('Sat 11:30 PM')
    // Where the OpenTask day and the date agree, the words stay: seen at Sat
    // 23:30 (Sunday's day, named Oct 25), Sun 9:00 is today's, Mon 9:00 tomorrow's.
    const sat2330Now = local('2026-10-24T23:30')
    expect(formatQuickSelectHeader(iso('2026-10-25T09:00'), TZ, LATE_START, sat2330Now)).toBe(
      'Today, Oct 25, 9:00 AM',
    )
    expect(formatDueTimeParts(iso('2026-10-26T09:00'), TZ, LATE_START, sat2330Now).relative).toBe(
      'Tomorrow 9:00 AM',
    )
    // The whole-day label (beside the day's OpenTask date in the bulk header)
    // stays the OpenTask day's, as on main.
    expect(getDayLabel(sat2330, TZ, LATE_START, satNoon)).toBe('Tomorrow')
    expect(getDayLabel(tue2347, TZ, LATE_START, satNoon)).toBe('Wed')
    // The switch off: main's words.
    expect(formatQuickSelectHeader(sat2330, TZ, CALENDAR_DAY_START, satNoon)).toBe(
      'Today, Oct 24, 11:30 PM',
    )
    expect(formatDueTimeParts(sat2330, TZ, CALENDAR_DAY_START, satNoon).relative).toBe('11:30 PM')
  })

  test('TQ-LN17: past labels — a Sat 23:47 log is "Sat 11:47 PM" whenever it is read (formatLastLogged, formatTaskSince, formatDueTimeParts overdue)', () => {
    const log = iso('2026-10-24T23:47')
    const since = (dayStart: string, now: Date) =>
      formatTaskSince(
        { rrule: null, due_at: null, original_due_at: null, created_at: log },
        TZ,
        dayStart,
        now,
      )?.label
    // Main said "today 11:47 PM" until Sun 23:00 and "yesterday 11:47 PM" on Monday.
    const reads = ['2026-10-24T23:55', '2026-10-25T10:00', '2026-10-26T10:00', '2026-10-27T10:00']
    for (const now of reads) {
      expect(formatLastLogged(log, TZ, LATE_START, local(now))).toBe('Sat 11:47 PM')
      expect(since(LATE_START, local(now))).toBe('Sat')
    }
    // The same day by both counts still says "today": a Sat 22:00 log read at 22:30.
    const sat22 = iso('2026-10-24T22:00')
    expect(formatLastLogged(sat22, TZ, LATE_START, local('2026-10-24T22:30'))).toBe(
      'today 10:00 PM',
    )
    // An overdue target: "yesterday" would name Saturday, its date is Friday.
    const fri2330 = iso('2026-10-23T23:30')
    const sun10 = local('2026-10-25T10:00')
    expect(formatDueTimeParts(fri2330, TZ, LATE_START, sun10)).toEqual({
      relative: 'Fri',
      absolute: '11:30 PM',
    })
    // The switch off: main's answers.
    expect(formatLastLogged(log, TZ, CALENDAR_DAY_START, sun10)).toBe('yesterday 11:47 PM')
    expect(since(CALENDAR_DAY_START, sun10)).toBe('yesterday')
    expect(formatDueTimeParts(fri2330, TZ, CALENDAR_DAY_START, sun10).relative).toBe('2d ago')
  })

  test('TQ-LN18: "Morning of the deadline" is the morning of the deadline\'s own date (deadlineDayPick)', () => {
    const ctx = { timezone: TZ, morningTime: '09:00' }
    for (const dayStart of [LATE_START, CALENDAR_DAY_START]) {
      expect(deadlineDayPick(tue2347, ctx, satNoon, dayStart)).toEqual({
        label: 'Morning of the deadline · Tue 9:00 AM (Default task time)',
        at: iso('2026-10-27T09:00'),
      })
    }
  })

  test('TQ-LN19: skip until, from completion, on a spring-forward night lands as main did (planSkipUntil)', () => {
    // Every 2 days at 02:30 until Sun Mar 8 2026 (2:00 → 3:00): 03:30 CDT —
    // Luxon's shift by the gap, as computeNextOccurrence's from-completion step has it.
    const chicago = completionRepeat(
      'FREQ=DAILY;INTERVAL=2;BYHOUR=2;BYMINUTE=30',
      iso('2026-03-06T02:30'),
    )
    expect(
      planSkipUntil(chicago, TZ, '2026-03-08', local('2026-03-05T10:00'), CALENDAR_DAY_START),
    ).toMatchObject({ kind: 'skip', landing: '2026-03-08T08:30:00.000Z' })
    // Lord Howe's half-hour change (2:00 → 2:30, Sun Oct 4 2026): weekly at 02:15 → 02:45.
    const LH = 'Australia/Lord_Howe'
    const lh = (s: string) => DateTime.fromISO(s, { zone: LH }).toJSDate()
    const lordHowe = completionRepeat(
      'FREQ=WEEKLY;BYHOUR=2;BYMINUTE=15',
      lh('2026-09-27T02:15').toISOString(),
    )
    expect(
      planSkipUntil(lordHowe, LH, '2026-10-04', lh('2026-09-26T10:00'), CALENDAR_DAY_START),
    ).toMatchObject({ kind: 'skip', landing: '2026-10-03T15:45:00.000Z' })
  })

  test("TQ-LN20: a floating rule's day 0 is its first occurrence while its time inside the OpenTask day is ahead (computeFirstOccurrence)", () => {
    const sunNight = local('2026-10-25T23:26') // Monday's day with an 11 PM start
    const first = (rule: string, now: Date, dayStart: string) =>
      computeFirstOccurrence(rule, null, TZ, now, dayStart).toISOString()
    // Every 3 days at 23:45: day 0's 23:45 is Sun 23:45, 19 minutes away (main's answer).
    const every3 = 'FREQ=DAILY;INTERVAL=3;BYHOUR=23;BYMINUTE=45'
    expect(first(every3, sunNight, LATE_START)).toBe(iso('2026-10-25T23:45'))
    expect(first(every3, sunNight, CALENDAR_DAY_START)).toBe(iso('2026-10-25T23:45'))
    // Every 2 weeks on Sunday at 23:45: the same instant (main's answer).
    const sundays = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;BYHOUR=23;BYMINUTE=45'
    expect(first(sundays, sunNight, LATE_START)).toBe(iso('2026-10-25T23:45'))
    expect(first(sundays, sunNight, CALENDAR_DAY_START)).toBe(iso('2026-10-25T23:45'))
    // A 7:00 rule's day-0 moment is Mon 07:00, inside Monday's day.
    expect(first('FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=0', sunNight, LATE_START)).toBe(
      iso('2026-10-26T07:00'),
    )
    // A 3:00 AM start: at Mon 00:30 (Sunday's day) a 1:00 AM rule's day-0
    // moment is Mon 01:00, still ahead — and the same at Sun 23:30.
    const oneAm = 'FREQ=DAILY;INTERVAL=3;BYHOUR=1;BYMINUTE=0'
    for (const now of ['2026-10-26T00:30', '2026-10-25T23:30']) {
      expect(first(oneAm, local(now), DAY_START)).toBe(iso('2026-10-26T01:00'))
    }
    // No time of day: day 0's midnight counts as passed — one period on.
    expect(first('FREQ=DAILY;INTERVAL=3', sunNight, LATE_START)).toBe(iso('2026-10-29T00:00'))
    expect(first('FREQ=DAILY;INTERVAL=3', sunNight, CALENDAR_DAY_START)).toBe(
      iso('2026-10-28T00:00'),
    )
  })
})

/**
 * TQ-LN21: A LABEL'S WEEKDAY AND DATE ALWAYS NAME THE SAME DAY (2026-10-27;
 * #354 shipped "Mon night, Oct 27, 1:00 AM" for a Tue Oct 27 01:00 target).
 * With the night cue both name the evening ("Mon night, Oct 26"); without it
 * both are the moment's own. Every label path that can show a day beside a
 * date is asked about a grid of moments around several "now"s, with a 3:00
 * AM start, an 11 PM start and the switch off (midnight): wherever a label
 * holds a weekday — or "today" / "tonight" / "tomorrow" / "yesterday" — and a
 * date, the two are parsed and must be one calendar day.
 */
const WEEKDAY_NUMBER: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
}
const WORD_OFFSET: Record<string, number> = {
  today: 0,
  tonight: 0,
  tomorrow: 1,
  yesterday: -1,
  'last night': -1,
}
const WEEKDAY_RE =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/
const WORD_RE = /\b(today|tonight|tomorrow|yesterday|last night)\b/i
const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?\b/

/**
 * The problem with `label`'s day pairing, or null. `today` is the user's
 * day (yyyy-MM-dd) the relative words count from. Returns whether a pair was
 * checked, so the test can prove it checked something on every path.
 */
function pairProblem(
  label: string,
  now: DateTime,
  today: string,
): { checked: boolean; problem: string | null } {
  const dateMatch = DATE_RE.exec(label)
  if (!dateMatch) return { checked: false, problem: null }
  let date = DateTime.fromFormat(
    `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3] ?? now.year}`,
    'LLL d yyyy',
    { zone: TZ },
  )
  // A date with no year is the nearest one to now.
  if (!dateMatch[3] && date.diff(now, 'months').months > 6) date = date.minus({ years: 1 })
  if (!dateMatch[3] && now.diff(date, 'months').months > 6) date = date.plus({ years: 1 })
  const weekday = WEEKDAY_RE.exec(label)
  if (weekday) {
    const ok = date.weekday === WEEKDAY_NUMBER[weekday[1]]
    return {
      checked: true,
      problem: ok ? null : `${weekday[1]} beside ${date.toFormat('ccc LLL d')}`,
    }
  }
  const word = WORD_RE.exec(label)
  if (word) {
    const want = DateTime.fromISO(today, { zone: TZ }).plus({
      days: WORD_OFFSET[word[1].toLowerCase()],
    })
    const ok = want.hasSame(date, 'day')
    return {
      checked: true,
      problem: ok ? null : `${word[1]} (${want.toISODate()}) beside ${date.toISODate()}`,
    }
  }
  return { checked: false, problem: null }
}

describe("TQ-LN21: a label never pairs one day with another day's date", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const NOWS = [
    '2026-10-24T12:30',
    '2026-10-25T23:30',
    '2026-10-26T00:30',
    '2026-10-26T02:00',
    '2026-10-31T23:30', // the fall-back night (Sun Nov 1, CDT → CST)
    '2026-11-01T00:30',
  ]
  const TIMES = ['00:30', '01:00', '02:30', '09:00', '22:30', '23:30', '23:47']

  // One case per day start and "now", so each stays small.
  const STARTS = [
    { name: '3:00 AM start', dayStart: DAY_START },
    { name: '11 PM start', dayStart: LATE_START },
    { name: 'the switch off (midnight)', dayStart: CALENDAR_DAY_START },
  ]
  const CASES = STARTS.flatMap((start) => NOWS.map((nowLocal) => ({ ...start, nowLocal })))

  test.each(CASES)('TQ-LN21: $name, now $nowLocal', ({ dayStart, nowLocal }) => {
    const problems: string[] = []
    const checked = new Map<string, number>()
    const check = (
      path: string,
      label: string | null | undefined,
      now: DateTime,
      today: string,
    ) => {
      if (!label) return
      const r = pairProblem(label, now, today)
      if (r.checked) checked.set(path, (checked.get(path) ?? 0) + 1)
      if (r.problem)
        problems.push(`${path} @${now.toFormat('ccc LLL d HH:mm')}: "${label}" — ${r.problem}`)
    }
    {
      const now = local(nowLocal)
      const nowDt = DateTime.fromJSDate(now).setZone(TZ)
      vi.useFakeTimers({ now })
      const today = openTaskDayOf(now, TZ, dayStart)
      for (let d = -9; d <= 9; d++) {
        const day = nowDt.startOf('day').plus({ days: d }).toISODate()!
        for (const time of TIMES) {
          const at = iso(`${day}T${time}`)
          const atMs = Date.parse(at)
          check('header', formatQuickSelectHeader(at, TZ, dayStart, now), nowDt, today)
          const parts = formatDueTimeParts(at, TZ, dayStart, now)
          check('row', `${parts.relative} ${parts.absolute ?? ''}`, nowDt, today)
          check('defer words', formatSnoozeTarget(at, TZ, dayStart, now), nowDt, today)
          const chip = deadlineChip(at, TZ, now, dayStart)
          check('deadline chip', chip.text, nowDt, today)
          check('deadline chip title', chip.title, nowDt, today)
          const gap = upcomingGap({ due_at: at, deadline_at: at }, TZ, dayStart, 'later')
          check('upcoming', gap.target, nowDt, today)
          check('upcoming', gap.deadline, nowDt, today)
          const one = { due_at: at } as Task
          check('bulk header', computeInitialDisplay([one], TZ, dayStart).headerText, nowDt, today)
          const later = { due_at: new Date(atMs + 30 * 60_000).toISOString() } as Task
          check(
            'bulk header',
            computeInitialDisplay([one, later], TZ, dayStart).headerText,
            nowDt,
            today,
          )
          if (atMs <= now.getTime()) {
            check(
              'history',
              formatTimeAgoLabel({ created_at: at }, now.getTime(), TZ, dayStart),
              nowDt,
              today,
            )
            check('quota last', formatLastLogged(at, TZ, dayStart, now), nowDt, today)
            const since = formatTaskSince(
              { rrule: null, due_at: null, original_due_at: null, created_at: at },
              TZ,
              dayStart,
              now,
            )
            check('since', since?.label, nowDt, today)
            check('since', since?.fullDate, nowDt, today)
          }
        }
      }
      vi.useRealTimers()
    }
    expect(problems).toEqual([])
    // Every path that can show a day beside a date was asked about one. The
    // row, the defer words and History never do (a weekday OR a date):
    // they are checked above, and must stay that way.
    for (const path of ['header', 'deadline chip title', 'upcoming', 'bulk header', 'since']) {
      expect(checked.get(path) ?? 0, path).toBeGreaterThan(0)
    }
  })

  test('TQ-LN21b: the night pairs name the evening; yesterday\'s night is "last night" everywhere', () => {
    // Sun Oct 25 12:30, 3:00 AM start: Tue Oct 27 01:00 is Monday night's.
    const sunNoon = local('2026-10-25T12:30')
    expect(formatQuickSelectHeader(iso('2026-10-27T01:00'), TZ, DAY_START, sunNoon)).toBe(
      'Tomorrow night, Oct 26, 1:00 AM',
    )
    expect(formatQuickSelectHeader(iso('2026-10-28T01:00'), TZ, DAY_START, sunNoon)).toBe(
      'Tue night, Oct 27, 1:00 AM',
    )
    // The switch off: the calendar day, no cue.
    expect(formatQuickSelectHeader(iso('2026-10-28T01:00'), TZ, CALENDAR_DAY_START, sunNoon)).toBe(
      'Wed, Oct 28, 1:00 AM',
    )
    // Overdue, read Mon 10:00: Mon 01:00 was Sunday night's — "last night".
    const monTen = local('2026-10-26T10:00')
    expect(formatDueTimeParts(iso('2026-10-26T01:00'), TZ, DAY_START, monTen)).toEqual({
      relative: 'last night',
      absolute: '1:00 AM',
    })
    // The same night in "Last:", "since", History and the past-deadline chip.
    const monOne = iso('2026-10-26T01:00')
    expect(formatLastLogged(monOne, TZ, DAY_START, monTen)).toBe('last night 1:00 AM')
    expect(
      formatTaskSince(
        { rrule: null, due_at: null, original_due_at: null, created_at: monOne },
        TZ,
        DAY_START,
        monTen,
      )?.label,
    ).toBe('last night')
    // History's pill once the entry is a day old (read Tue 02:00, still Monday's day).
    const tueTwo = local('2026-10-27T02:00')
    expect(formatTimeAgoLabel({ created_at: monOne }, tueTwo.getTime(), TZ, DAY_START)).toBe(
      'Last night 1:00 AM',
    )
    expect(deadlineChip(monOne, TZ, monTen, DAY_START).text).toBe('Past deadline last night')
    // The header for a past night moment: "Last night", with the evening's date.
    expect(formatQuickSelectHeader(monOne, TZ, DAY_START, monTen)).toBe(
      'Last night, Oct 25, 1:00 AM',
    )
    expect(formatDueTimeParts(iso('2026-10-26T01:00'), TZ, CALENDAR_DAY_START, monTen)).toEqual({
      relative: '9h ago',
      absolute: '1:00 AM',
    })
  })
})

/**
 * TQ-LN29–36: A REPEAT COUNTED FROM COMPLETION COUNTS FROM THE OPENTASK DAY
 * (Trent, 2026-10-26). Done at 00:30 Monday with a 3:00 AM day start is
 * Sunday's Done, exactly as at 23:30 Sunday: "every 2 days at 09:00" lands
 * Tuesday 09:00 either way (main: Wednesday from 00:30). The engine
 * (`computeFromCompletion`) drives Done, skipping one occurrence and the
 * skip-until floor, so all three are pinned here through the real core. The
 * base is the completion's OpenTask date (`openTaskDayOf`), the interval is
 * calendar maths on it, and the rule's time is placed inside the landing
 * OpenTask day (`periodOpensOnDate`, skip until's rule). With midnight (the
 * switch off) every answer is main's — TQ-LN36 checks it against main's
 * formula over a sweep.
 */
const EVERY_2_DAYS_9 = 'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0'
const SUN_2330 = '2026-10-25T23:30'
const MON_0030 = '2026-10-26T00:30'

/** The engine's from-completion answer, as a Chicago wall-clock string. */
function fromCompletion(rrule: string, done: string, dayStart: string, zone = TZ): string {
  const next = computeNextOccurrence({
    rrule,
    recurrenceMode: 'from_completion',
    anchorTime: null,
    timezone: zone,
    completedAt: DateTime.fromISO(done, { zone }).toJSDate(),
    dayStart,
  })
  return DateTime.fromJSDate(next).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")
}

describe('TQ-LN: from-completion repeats count from the OpenTask day (real core)', () => {
  const u = { userId: TEST_USER_ID, userTimezone: TZ }

  /** A from-completion repeat whose current occurrence was Sun 09:00 (over target). */
  function overdueRepeat(rrule = EVERY_2_DAYS_9): number {
    const t = createTask({ ...u, input: { title: 'Water the ferns', rrule } })
    const sunNine = iso('2026-10-25T09:00')
    getDb()
      .prepare(
        "UPDATE tasks SET recurrence_mode = 'from_completion', occurrence_at = ?, due_at = ?, original_due_at = ? WHERE id = ?",
      )
      .run(sunNine, sunNine, sunNine, t.id)
    return t.id
  }

  const occurrence = (id: number) => getTaskById(id)!.occurrence_at

  /** Each of the three ways the engine runs, at `now` (wall clock), on a fresh database. */
  function runAt(now: string, act: (id: number) => void): string | null {
    vi.setSystemTime(local(now))
    setupTestDb()
    try {
      const id = overdueRepeat()
      act(id)
      return occurrence(id)
    } finally {
      teardownTestDb()
    }
  }

  const done = (id: number) => markDone({ ...u, taskId: id })
  const skipOne = (id: number) => skipOccurrence({ ...u, taskId: id })
  const skipUntilTue = (id: number) => skipUntil({ ...u, taskIds: [id], until: '2026-10-27' })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('TQ-LN29: Done — 00:30 Mon lands Tue 09:00, as 23:30 Sun does (main: Wed 09:00)', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(openTaskDayOf(local(MON_0030), TZ, DAY_START)).toBe('2026-10-25')
    expect(runAt(SUN_2330, done)).toBe(iso('2026-10-27T09:00'))
    expect(runAt(MON_0030, done)).toBe(iso('2026-10-27T09:00'))
  })

  test('TQ-LN30: skip one occurrence — the same Tue 09:00 from both instants', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(runAt(SUN_2330, skipOne)).toBe(iso('2026-10-27T09:00'))
    expect(runAt(MON_0030, skipOne)).toBe(iso('2026-10-27T09:00'))
  })

  test('TQ-LN31: skip until Tue — lands Tue 27 09:00 from both instants (main: Wed 28 from 00:30, the floor)', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(runAt(SUN_2330, skipUntilTue)).toBe(iso('2026-10-27T09:00'))
    expect(runAt(MON_0030, skipUntilTue)).toBe(iso('2026-10-27T09:00'))
  })

  test('TQ-LN32: the switch off — the day turns at midnight, and every answer is main’s', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(dayBoundaryForUser(TEST_USER_ID)).toBe(CALENDAR_DAY_START)
    // 23:30 Sunday: Tuesday, as before.
    expect(runAt(SUN_2330, done)).toBe(iso('2026-10-27T09:00'))
    expect(runAt(SUN_2330, skipOne)).toBe(iso('2026-10-27T09:00'))
    expect(runAt(SUN_2330, skipUntilTue)).toBe(iso('2026-10-27T09:00'))
    // 00:30 Monday is Monday: Wednesday, exactly main's answers.
    expect(runAt(MON_0030, done)).toBe(iso('2026-10-28T09:00'))
    expect(runAt(MON_0030, skipOne)).toBe(iso('2026-10-28T09:00'))
    expect(runAt(MON_0030, skipUntilTue)).toBe(iso('2026-10-28T09:00'))
  })
})

describe('TQ-LN: from-completion repeats count from the OpenTask day (the engine)', () => {
  test('TQ-LN33: weekly and monthly — the base is the OpenTask date', () => {
    const weekly = 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0'
    expect(fromCompletion(weekly, MON_0030, DAY_START)).toBe('2026-11-01T09:00')
    expect(fromCompletion(weekly, SUN_2330, DAY_START)).toBe('2026-11-01T09:00')
    expect(fromCompletion(weekly, MON_0030, CALENDAR_DAY_START)).toBe('2026-11-02T09:00')
    // Monthly from Sat Oct 31 (Sun Nov 1 00:30 is still Saturday's): Nov 30,
    // the month's last day as Luxon clamps it — main from 00:30: Dec 1.
    const monthly = 'FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0'
    expect(fromCompletion(monthly, '2026-11-01T00:30', DAY_START)).toBe('2026-11-30T09:00')
    expect(fromCompletion(monthly, '2026-10-31T23:30', DAY_START)).toBe('2026-11-30T09:00')
    expect(fromCompletion(monthly, '2026-11-01T00:30', CALENDAR_DAY_START)).toBe('2026-12-01T09:00')
  })

  test('TQ-LN34: the rule’s time sits inside the landing OpenTask day — a 1:00 AM rule is that day’s end', () => {
    // With 3:00 AM, Tuesday's 1:00 AM is Wed 01:00 (skip until's landing rule,
    // `periodOpensOnDate`): two OpenTask days after Sunday, at either instant
    // and at any hour of Sunday's day. Main: Tue 01:00 — Monday's night.
    const oneAm = 'FREQ=DAILY;INTERVAL=2;BYHOUR=1;BYMINUTE=0'
    for (const done of [MON_0030, SUN_2330, '2026-10-25T10:00']) {
      expect(fromCompletion(oneAm, done, DAY_START)).toBe('2026-10-28T01:00')
    }
    expect(fromCompletion(oneAm, '2026-10-25T10:00', CALENDAR_DAY_START)).toBe('2026-10-27T01:00')
  })

  test('TQ-LN35: a day start after noon (11 PM) — Sun 23:30 is Monday’s, so every 2 days is Wednesday', () => {
    expect(openTaskDayOf(local(SUN_2330), TZ, LATE_START)).toBe('2026-10-26')
    expect(fromCompletion(EVERY_2_DAYS_9, SUN_2330, LATE_START)).toBe('2026-10-28T09:00')
    // Monday's day runs Sun 23:00 → Mon 23:00: Mon 22:30 is the same day.
    expect(fromCompletion(EVERY_2_DAYS_9, '2026-10-26T22:30', LATE_START)).toBe('2026-10-28T09:00')
    // Sun 22:30 is still Sunday's: Tuesday.
    expect(fromCompletion(EVERY_2_DAYS_9, '2026-10-25T22:30', LATE_START)).toBe('2026-10-27T09:00')
    // A 23:30 rule inside Wednesday's day (Tue 23:00 → Wed 23:00) is Tue 23:30.
    const lateRule = 'FREQ=DAILY;INTERVAL=2;BYHOUR=23;BYMINUTE=30'
    expect(fromCompletion(lateRule, SUN_2330, LATE_START)).toBe('2026-10-27T23:30')
    // Main (midnight): Tuesday for both rules.
    expect(fromCompletion(EVERY_2_DAYS_9, SUN_2330, CALENDAR_DAY_START)).toBe('2026-10-27T09:00')
    expect(fromCompletion(lateRule, SUN_2330, CALENDAR_DAY_START)).toBe('2026-10-27T23:30')
  })

  test('TQ-LN36: with midnight every answer is main’s formula — a sweep over DST nights and month ends', () => {
    // Main's from-completion step, verbatim: the completion moved by the
    // interval, then set to the rule's time.
    const main = (rrule: string, completedAt: Date, zone: string, hour: number, minute: number) => {
      const dt = DateTime.fromJSDate(completedAt).setZone(zone)
      const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1)
      const freq = /FREQ=(\w+)/.exec(rrule)![1]
      const unit = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' }[freq]!
      return dt
        .plus({ [unit]: interval })
        .set({ hour, minute, second: 0, millisecond: 0 })
        .toJSDate()
        .toISOString()
    }
    const rules: [string, number, number][] = [
      ['FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0', 9, 0],
      ['FREQ=DAILY;BYHOUR=2;BYMINUTE=30', 2, 30], // the spring-forward gap
      ['FREQ=DAILY;BYHOUR=1;BYMINUTE=30', 1, 30], // the fall-back repeat
      ['FREQ=WEEKLY;INTERVAL=2;BYHOUR=23;BYMINUTE=45', 23, 45],
      ['FREQ=MONTHLY;BYHOUR=0;BYMINUTE=15', 0, 15],
      ['FREQ=YEARLY;BYHOUR=7;BYMINUTE=0', 7, 0],
    ]
    const zones = [TZ, 'Australia/Lord_Howe', 'Asia/Kolkata']
    // Around the US spring-forward (Mar 8) and fall-back (Nov 1) nights, Lord
    // Howe's half-hour change (Oct 4) and a month end with a leap day.
    const windows = ['2026-03-06', '2026-10-02', '2026-10-30', '2028-02-27']
    let checked = 0
    for (const zone of zones) {
      for (const start of windows) {
        const from = DateTime.fromISO(start, { zone })
        for (let m = 0; m < 4 * 24 * 60; m += 45) {
          const completedAt = from.plus({ minutes: m }).toJSDate()
          for (const [rrule, hour, minute] of rules) {
            const engine = computeNextOccurrence({
              rrule,
              recurrenceMode: 'from_completion',
              anchorTime: null,
              timezone: zone,
              completedAt,
              dayStart: CALENDAR_DAY_START,
            }).toISOString()
            expect(engine).toBe(main(rrule, completedAt, zone, hour, minute))
            checked++
          }
        }
      }
    }
    expect(checked).toBe(3 * 4 * 128 * rules.length)
  })
})
