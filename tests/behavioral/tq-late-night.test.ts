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
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import { CALENDAR_DAY_START, openTaskDayOf } from '@/lib/opentask-day'
import { draftFromTask, type EveryTimeContext, type EveryTimeTask } from '@/lib/every-time'
import { pinUnnamedDay, resolveDeckDay } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { computeFirstOccurrence } from '@/core/recurrence/compute-next'
import { deckMenuDays } from '@/lib/deck-menu'
import { formatQuickSelectHeader, getDayLabel } from '@/lib/quick-select-dates'
import { deadlineDayPick } from '@/lib/editor-target-labels'
import { parseUntil, planSkipUntil } from '@/core/tasks/skip-until'
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
    // With a time: between midnight and the day start, L9's "night" words;
    // the date stays the moment's own.
    expect(headers).toEqual([
      `Tonight, ${date(1)}, 1:00 AM`,
      `Tomorrow, ${date(1)}, 9:00 AM`,
      `Tomorrow night, ${date(2)}, 1:00 AM`,
      `${weekday(2)} night, ${date(3)}, 1:00 AM`,
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
