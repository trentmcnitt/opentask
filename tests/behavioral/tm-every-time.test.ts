/**
 * TM-EVERY (2026-10-22, editor plan §4–§6, §14.1; PR 4b): the pure core of
 * the editor's "every time" mode (`src/lib/every-time.ts`). Frozen clock,
 * America/Chicago. Two tasks from the mock:
 *  - FRIDAYS: target-anchored, weekly on Friday at 4 PM;
 *  - HOME DEPOT: deadline-anchored, monthly on the 1st Saturday at 8 AM, the
 *    target the day before at 6 PM.
 * Every patch is also fed to the server's own planner (`planRepeatSchedule`)
 * and the route's validation, and a seeded property loop checks that every
 * draft `draftProblem` accepts saves without a 400.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { isValidRRule } from '@/core/recurrence'
import { planRepeatSchedule, type ScheduleInput } from '@/core/tasks/repeat-schedule'
import { validateTaskUpdate } from '@/core/validation'
import {
  ADD_DEADLINE_REFUSAL,
  BULK_DEADLINE_REASON,
  BULK_KIND_REASON,
  NO_END_DATE_PROBLEM,
  KEEPS_ITS_DECK,
  KEEPS_ITS_OWN_TARGET,
  LEAVE_DEADLINE_REFUSAL,
  NEVER_OCCURS_PROBLEM,
  NO_DAY_PROBLEM,
  bulkEveryTimeGate,
  daysBeforeChoices,
  draftFromTask,
  draftProblem,
  draftReducer,
  draftRule,
  draftToBulkChanges,
  draftToCreateFields,
  draftToPatch,
  draftsEqual,
  nextDateWords,
  nextDates,
  occurrenceKeepsItsOwn,
  scheduleEditable,
  targetTimeRefused,
  thisOneHint,
  stopKeepsRelativeTarget,
  upcomingLeadStep,
  upcomingLeadStepWords,
  leadResetForRule,
  LEAD_RESET_FOR_RULE,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeDraft,
  type EveryTimeTask,
} from '@/lib/every-time'
import { RELATIVE_TARGET_MESSAGES } from '@/lib/task-segments'
import { ruleDraftable } from '@/lib/rrule-draft'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TZ = 'America/Chicago'
/** Thu Oct 22 2026, 10:00 AM Chicago (CDT). */
const NOW = new Date('2026-10-22T15:00:00Z')
const ctx: EveryTimeContext = {
  timezone: TZ,
  morningTime: '09:00',
  now: NOW,
  dayStart: CALENDAR_DAY_START,
}

const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!

const BASE: EveryTimeTask = {
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
  queued_at: null,
}

const FRIDAYS: EveryTimeTask = {
  ...BASE,
  rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
  anchor_time: '16:00',
  due_at: at('2026-10-23T16:00'),
  occurrence_at: at('2026-10-23T16:00'),
  repeat_anchor: 'target',
}

const HOME_DEPOT: EveryTimeTask = {
  ...BASE,
  rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
  anchor_time: '08:00',
  deadline_at: at('2026-11-07T08:00'),
  occurrence_at: at('2026-11-07T08:00'),
  due_at: at('2026-11-06T18:00'),
  repeat_anchor: 'deadline',
  target_days_before: 1,
  target_time: '18:00',
}

const ONE_OFF: EveryTimeTask = { ...BASE, due_at: at('2026-10-27T15:00') }
const ONE_OFF_DEADLINE: EveryTimeTask = {
  ...BASE,
  due_at: at('2026-10-29T09:00'),
  deadline_at: at('2026-10-30T17:00'),
}

/** Personal and off-schedule variants (the hint's branches; the property loop runs them too). */
const OVER_FRIDAYS: EveryTimeTask = {
  ...FRIDAYS,
  due_at: at('2026-10-16T16:00'),
  occurrence_at: at('2026-10-16T16:00'),
}
const DECKED_FRIDAYS: EveryTimeTask = { ...FRIDAYS, due_at: null, on_deck_day: '2026-10-22' }
/** The rollover kept the missed Fri Oct 16 occurrence and moved the target to the next one. */
const QUEUED_FRIDAYS: EveryTimeTask = {
  ...FRIDAYS,
  occurrence_at: at('2026-10-16T16:00'),
  due_at: at('2026-10-23T16:00'),
  queued_at: at('2026-10-17T06:00'),
}
/** Home Depot's October occurrence, never done: over target and over deadline. */
const OVER_HOME_DEPOT: EveryTimeTask = {
  ...HOME_DEPOT,
  deadline_at: at('2026-10-03T08:00'),
  occurrence_at: at('2026-10-03T08:00'),
  due_at: at('2026-10-02T18:00'),
}
const DECKED_HOME_DEPOT: EveryTimeTask = { ...HOME_DEPOT, due_at: null, on_deck_day: '2026-10-22' }

const run = (draft: EveryTimeDraft, ...actions: DraftAction[]) =>
  actions.reduce(draftReducer, draft)
const plan = (task: EveryTimeTask, patch: object) =>
  planRepeatSchedule(task, patch as ScheduleInput, { ...ctx, isReminder: false, isTracked: false })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

// ===========================================================================
// draftFromTask
// ===========================================================================

describe('TM-EVERY-01: draftFromTask', () => {
  test('target-anchored: the rule, its time the target’s', () => {
    expect(draftFromTask(FRIDAYS, ctx)).toMatchObject({
      anchor: 'target',
      targetTime: '16:00',
      deadlineTime: null,
      daysBefore: 0,
      mode: 'from_due',
      stop: false,
      rule: { freq: 'WEEKLY', days: ['FR'] },
      defaultDay: 'FR',
    })
  })

  test('deadline-anchored: the rule’s time the deadline’s, the stored offsets', () => {
    const d = draftFromTask(HOME_DEPOT, ctx)
    expect(d).toMatchObject({
      anchor: 'deadline',
      deadlineTime: '08:00',
      targetTime: '18:00',
      daysBefore: 1,
      rule: { freq: 'MONTHLY', monthWeekday: { byDay: '1SA', setPos: null } },
    })
    expect(draftRule(d)).toBe(HOME_DEPOT.rrule)
  })

  test('a one-off: weekly on its target’s weekday at its time; Morning with no target', () => {
    const d = draftFromTask(ONE_OFF, ctx)
    expect(d).toMatchObject({ anchor: 'target', targetTime: '15:00', rule: { days: ['TU'] } })
    const bare = draftFromTask(BASE, ctx)
    expect(bare).toMatchObject({ targetTime: '09:00', rule: { days: ['TH'] } })
  })

  test('a one-off with a deadline opens on Deadline, pinned to it, its target kept', () => {
    const d = draftFromTask(ONE_OFF_DEADLINE, ctx)
    expect(d).toMatchObject({
      anchor: 'deadline',
      deadlineTime: '17:00',
      daysBefore: 1,
      targetTime: '09:00',
      rule: { freq: 'WEEKLY', days: ['FR'] },
    })
    // A target too early for a weekly rule (7 days before) falls back to the default (A1).
    const far = { ...ONE_OFF_DEADLINE, due_at: at('2026-10-20T09:00') }
    expect(draftFromTask(far, ctx)).toMatchObject({ daysBefore: 1, targetTime: '09:00' })
  })

  test('draftsEqual ignores a refusal', () => {
    const d = draftFromTask(FRIDAYS, ctx)
    expect(draftsEqual(d, { ...d, refusal: 'x' })).toBe(true)
    expect(draftsEqual(d, run(d, { type: 'toggleDay', day: 'SA' }))).toBe(false)
  })
})

// ===========================================================================
// The reducer (§4.3)
// ===========================================================================

describe('TM-EVERY-02: the reducer', () => {
  test('Repeats on → Deadline from target-anchored: the deadline at the old target time, same day', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'anchor', anchor: 'deadline', ctx })
    expect(d).toMatchObject({
      anchor: 'deadline',
      deadlineTime: '16:00',
      targetTime: '16:00',
      daysBefore: 0,
      rule: { days: ['FR'] },
    })
  })

  test('+ Add at or after the target time: the same day', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'addDeadline', time: '17:00', ctx })
    expect(d).toMatchObject({ anchor: 'deadline', deadlineTime: '17:00', daysBefore: 0 })
    expect(draftRule(d)).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0')
  })

  test('A2 / RT-3: + Add earlier than the target — the deadline goes on the next day', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'addDeadline', time: '08:00', ctx })
    expect(d).toMatchObject({
      anchor: 'deadline',
      deadlineTime: '08:00',
      targetTime: '16:00',
      daysBefore: 1,
      refusal: null,
    })
    expect(draftRule(d)).toBe('FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0')
  })

  test('A2: refused when the shift can’t be written (the 1st Saturday + 1)', () => {
    const firstSat: EveryTimeTask = {
      ...FRIDAYS,
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=16;BYMINUTE=0',
      due_at: at('2026-11-07T16:00'),
      occurrence_at: at('2026-11-07T16:00'),
    }
    const before = draftFromTask(firstSat, ctx)
    const d = run(before, { type: 'addDeadline', time: '08:00', ctx })
    expect(d.refusal).toBe(ADD_DEADLINE_REFUSAL('16:00'))
    expect(d.refusal).toBe('Pick a deadline at or after 4:00 PM, or change How often first.')
    expect(draftsEqual(d, before)).toBe(true)
    // The next action clears it.
    expect(run(d, { type: 'targetTime', time: '15:00' }).refusal).toBeNull()
  })

  test('A3: Repeats on → Target moves the rule onto the target’s days', () => {
    const weekly: EveryTimeTask = {
      ...HOME_DEPOT,
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
      occurrence_at: at('2026-10-24T08:00'),
      due_at: at('2026-10-23T18:00'),
    }
    const d = run(draftFromTask(weekly, ctx), { type: 'anchor', anchor: 'target', ctx })
    expect(d).toMatchObject({ anchor: 'target', deadlineTime: null, daysBefore: 0 })
    expect(draftRule(d)).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0')
    // The Deadline row's Remove is the same transition.
    const removed = run(draftFromTask(weekly, ctx), { type: 'removeDeadline', ctx })
    expect(draftRule(removed)).toBe(draftRule(d))
  })

  test('A3: refused when the target’s days can’t be written (Home Depot: the day before the 1st Saturday)', () => {
    const d = run(draftFromTask(HOME_DEPOT, ctx), { type: 'anchor', anchor: 'target', ctx })
    expect(d.anchor).toBe('deadline')
    expect(d.refusal).toBe(LEAVE_DEADLINE_REFUSAL)
  })

  test('A3: the same day needs no shift', () => {
    const sameDay = { ...HOME_DEPOT, target_days_before: 0, target_time: '07:00' }
    const d = run(draftFromTask(sameDay, ctx), { type: 'anchor', anchor: 'target', ctx })
    expect(draftRule(d)).toBe('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=7;BYMINUTE=0')
  })

  test('Stop repeating greys every row; Reset undoes it', () => {
    const start = draftFromTask(FRIDAYS, ctx)
    const stopped = run(start, { type: 'stop', stop: true }, { type: 'toggleDay', day: 'SA' })
    expect(stopped.stop).toBe(true)
    expect(stopped.rule.days).toEqual(['FR'])
    expect(run(stopped, { type: 'reset', draft: start })).toBe(start)
  })

  test('Weekly with no day picks up the task’s own; switching back to from_due does too', () => {
    const daily = run(
      draftFromTask(FRIDAYS, ctx),
      { type: 'toggleDay', day: 'FR' },
      {
        type: 'freq',
        freq: 'DAILY',
      },
    )
    expect(run(daily, { type: 'freq', freq: 'WEEKLY' }).rule.days).toEqual(['FR'])
    const noDay = {
      ...daily,
      rule: { ...daily.rule, freq: 'WEEKLY' as const },
      mode: 'from_completion' as const,
    }
    expect(run(noDay, { type: 'mode', mode: 'from_due' }).rule.days).toEqual(['FR'])
  })

  test('times and offsets apply only to their anchor', () => {
    const fridays = draftFromTask(FRIDAYS, ctx)
    expect(run(fridays, { type: 'deadlineTime', time: '08:00' })).toEqual(fridays)
    expect(run(fridays, { type: 'daysBefore', days: 2 })).toEqual(fridays)
    const hd = run(draftFromTask(HOME_DEPOT, ctx), { type: 'daysBefore', days: 2 })
    expect(hd.daysBefore).toBe(2)
  })
})

// ===========================================================================
// draftToPatch (§5) — the exact JSON
// ===========================================================================

describe('TM-EVERY-03: draftToPatch', () => {
  test('nothing changed → nothing sent (a rule is never re-sent for its part order)', () => {
    expect(draftToPatch(FRIDAYS, draftFromTask(FRIDAYS, ctx), ctx)).toEqual({})
    expect(draftToPatch(HOME_DEPOT, draftFromTask(HOME_DEPOT, ctx), ctx)).toEqual({})
    const reordered = { ...FRIDAYS, rrule: 'FREQ=WEEKLY;BYHOUR=16;BYMINUTE=0;BYDAY=FR' }
    expect(draftToPatch(reordered, draftFromTask(reordered, ctx), ctx)).toEqual({})
  })

  test('§5.1 target-anchored stays: the rule and the mode, nothing else', () => {
    const d = run(
      draftFromTask(FRIDAYS, ctx),
      { type: 'toggleDay', day: 'FR' },
      {
        type: 'toggleDay',
        day: 'SA',
      },
    )
    expect(draftToPatch(FRIDAYS, d, ctx)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=16;BYMINUTE=0',
    })
    const mode = run(draftFromTask(FRIDAYS, ctx), { type: 'mode', mode: 'from_completion' })
    expect(draftToPatch(FRIDAYS, mode, ctx)).toEqual({ recurrence_mode: 'from_completion' })
    expect(plan(FRIDAYS, draftToPatch(FRIDAYS, d, ctx))).toEqual({ kind: 'none' })
  })

  test('§5.2 deadline-anchored stays: offsets both-or-neither, never deadline_at', () => {
    const hd = draftFromTask(HOME_DEPOT, ctx)
    expect(draftToPatch(HOME_DEPOT, run(hd, { type: 'daysBefore', days: 2 }), ctx)).toEqual({
      target_days_before: 2,
      target_time: '18:00',
    })
    expect(draftToPatch(HOME_DEPOT, run(hd, { type: 'targetTime', time: '19:00' }), ctx)).toEqual({
      target_days_before: 1,
      target_time: '19:00',
    })
    // The deadline's time is the rule's (RT-2).
    expect(draftToPatch(HOME_DEPOT, run(hd, { type: 'deadlineTime', time: '09:00' }), ctx)).toEqual(
      { rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0' },
    )
  })

  test('§5.3 target → deadline ("+ Add" 8 AM on Fridays): the target stays exactly where it was', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'addDeadline', time: '08:00', ctx })
    const patch = draftToPatch(FRIDAYS, d, ctx)
    expect(patch).toEqual({
      repeat_anchor: 'deadline',
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
      target_days_before: 1,
      target_time: '16:00',
    })
    const p = plan(FRIDAYS, patch)
    expect(p).toMatchObject({
      kind: 'deadline',
      occurrenceAt: at('2026-10-24T08:00'),
      dueAt: FRIDAYS.due_at,
      relative: { days_before: 1, time: '16:00' },
    })
    expect(validateTaskUpdate(patch)).toBeTruthy()
  })

  test('§5.3 a one-off with a deadline made repeating: its own deadline starts it', () => {
    const d = draftFromTask(ONE_OFF_DEADLINE, ctx)
    expect(draftToPatch(ONE_OFF_DEADLINE, d, ctx)).toEqual({
      repeat_anchor: 'deadline',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
      target_days_before: 1,
      target_time: '09:00',
    })
    // Its deadline's time moved: the deadline goes with it, so the rule stays on it.
    const later = run(d, { type: 'deadlineTime', time: '18:00' })
    expect(draftToPatch(ONE_OFF_DEADLINE, later, ctx)).toMatchObject({
      deadline_at: at('2026-10-30T18:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0',
    })
    expect(plan(ONE_OFF_DEADLINE, draftToPatch(ONE_OFF_DEADLINE, later, ctx)).kind).toBe('deadline')
  })

  test('§5.4 deadline → target: the anchor and the shifted rule (the server clears the deadline)', () => {
    const weekly: EveryTimeTask = {
      ...HOME_DEPOT,
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
      occurrence_at: at('2026-10-24T08:00'),
      due_at: at('2026-10-23T18:00'),
    }
    const d = run(draftFromTask(weekly, ctx), { type: 'anchor', anchor: 'target', ctx })
    const patch = draftToPatch(weekly, d, ctx)
    expect(patch).toEqual({
      repeat_anchor: 'target',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0',
    })
    expect(plan(weekly, patch)).toEqual({ kind: 'target', clearDeadline: true })
  })

  test('§5.4 a one-off with a deadline made target-anchored sends deadline_at: null', () => {
    const d = run(draftFromTask(ONE_OFF_DEADLINE, ctx), { type: 'removeDeadline', ctx })
    const patch = draftToPatch(ONE_OFF_DEADLINE, d, ctx)
    expect(patch).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0', deadline_at: null })
    expect(plan(ONE_OFF_DEADLINE, patch)).toEqual({ kind: 'none' })
  })

  test('a plain one-off made repeating', () => {
    expect(draftToPatch(ONE_OFF, draftFromTask(ONE_OFF, ctx), ctx)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=15;BYMINUTE=0',
    })
  })

  test('§5.5 Stop repeating: rrule null (nothing on a one-off)', () => {
    const stop = (t: EveryTimeTask) => run(draftFromTask(t, ctx), { type: 'stop', stop: true })
    expect(draftToPatch(FRIDAYS, stop(FRIDAYS), ctx)).toEqual({ rrule: null })
    expect(draftToPatch(HOME_DEPOT, stop(HOME_DEPOT), ctx)).toEqual({ rrule: null })
    expect(plan(HOME_DEPOT, { rrule: null })).toEqual({ kind: 'target', clearDeadline: false })
    expect(draftToPatch(ONE_OFF, stop(ONE_OFF), ctx)).toEqual({})
  })

  test('create (§8): the first deadline always rides; never a null deadline', () => {
    const staged = { dueAt: null, deadlineAt: null }
    const d = run(draftFromTask({ ...BASE }, ctx), { type: 'addDeadline', time: '17:00', ctx })
    const fields = draftToCreateFields(staged, d, ctx)
    expect(fields).toMatchObject({
      repeat_anchor: 'deadline',
      rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=17;BYMINUTE=0',
      deadline_at: at('2026-10-22T17:00'),
      target_days_before: 0,
      target_time: '09:00',
    })
    const withDeadline = { dueAt: null, deadlineAt: ONE_OFF_DEADLINE.deadline_at }
    const removed = run(draftFromTask({ ...BASE, deadline_at: withDeadline.deadlineAt }, ctx), {
      type: 'removeDeadline',
      ctx,
    })
    expect(draftToCreateFields(withDeadline, removed, ctx)).not.toHaveProperty('deadline_at')
  })
})

// ===========================================================================
// draftProblem (§6)
// ===========================================================================

describe('TM-EVERY-04: draftProblem', () => {
  test('a valid draft has none', () => {
    expect(draftProblem(FRIDAYS, draftFromTask(FRIDAYS, ctx), ctx)).toBeNull()
    expect(draftProblem(HOME_DEPOT, draftFromTask(HOME_DEPOT, ctx), ctx)).toBeNull()
    const fridaysAdd = run(draftFromTask(FRIDAYS, ctx), { type: 'addDeadline', time: '08:00', ctx })
    expect(draftProblem(FRIDAYS, fridaysAdd, ctx)).toBeNull()
  })

  test('a weekly rule with no day', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'toggleDay', day: 'FR' })
    expect(draftProblem(FRIDAYS, d, ctx)).toBe(NO_DAY_PROBLEM)
  })

  test('ends (4c): a valid end is no problem; a past, missing or spent one is', () => {
    const base = draftFromTask(FRIDAYS, ctx)
    const end = (a: Partial<Extract<DraftAction, { type: 'ends' }>>) =>
      run(base, { type: 'ends', endType: 'date', ...a })
    expect(draftProblem(FRIDAYS, end({ endDate: '2027-01-01' }), ctx)).toBeNull()
    expect(draftProblem(FRIDAYS, end({ endType: 'count', endCount: 3 }), ctx)).toBeNull()
    expect(draftProblem(FRIDAYS, end({ endDate: '' }), ctx)).toBe(NO_END_DATE_PROBLEM)
    expect(draftProblem(FRIDAYS, end({ endDate: '2026-10-21' }), ctx)).toBe(
      'That end date has passed.',
    )
    // Today, but before this occurrence (Fri Oct 23).
    expect(draftProblem(FRIDAYS, end({ endDate: '2026-10-22' }), ctx)).toBe(
      "That's before this one's date — pick a later end.",
    )
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const spent = run(draftFromTask(counted, ctx), { type: 'ends', endType: 'count', endCount: 2 })
    expect(draftProblem(counted, spent, ctx)).toBe(
      'It has already come round 2 times — pick more than 2.',
    )
    // An end the user didn't touch is never re-judged (a date passed while its last is debt).
    const passed = { ...OVER_FRIDAYS, repeat_until: '2026-10-16' }
    expect(draftProblem(passed, draftFromTask(passed, ctx), ctx)).toBeNull()
  })

  test('after_deadline: the same day, the target later than the deadline', () => {
    const d = run(draftFromTask(HOME_DEPOT, ctx), { type: 'daysBefore', days: 0 })
    expect(draftProblem(HOME_DEPOT, d, ctx)).toBe(
      'On the deadline day the target must be at or before 8:00 AM.',
    )
    expect(targetTimeRefused(d, '18:00')).toBe(true)
    expect(targetTimeRefused(d, '07:00')).toBe(false)
  })

  test('overlaps_previous: daily, deadline 7:00, target the day before at 6:00', () => {
    const daily: EveryTimeTask = {
      ...HOME_DEPOT,
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      anchor_time: '07:00',
      deadline_at: at('2026-10-23T07:00'),
      occurrence_at: at('2026-10-23T07:00'),
      due_at: at('2026-10-23T06:00'),
      target_days_before: 0,
      target_time: '06:00',
    }
    const d = run(draftFromTask(daily, ctx), { type: 'daysBefore', days: 1 })
    expect(draftProblem(daily, d, ctx)).toBe(
      "That's on or before the previous deadline — fewer days before for this rule.",
    )
    const choices = daysBeforeChoices(daily, d, ctx)
    expect(choices[0]).toEqual({ days: 0, refused: null })
    expect(choices.slice(1).every((c) => c.refused === 'overlaps_previous')).toBe(true)
  })

  test('a rule that never comes round', () => {
    const d = draftFromTask(FRIDAYS, ctx)
    const never = {
      ...d,
      rule: { ...d.rule, freq: 'YEARLY' as const, yearDate: 'BYMONTH=2;BYMONTHDAY=30' },
    }
    expect(draftProblem(FRIDAYS, never, ctx)).toBe(NEVER_OCCURS_PROBLEM)
    expect(nextDates(FRIDAYS, never, ctx)).toEqual({
      dates: [],
      ends: true,
      problem: NEVER_OCCURS_PROBLEM,
    })
  })

  test('the internal-only messages never reach a draft the reducer builds (see the property loop)', () => {
    expect(RELATIVE_TARGET_MESSAGES.after_deadline).toBeTruthy()
  })
})

// ===========================================================================
// The property loop: every valid draft's patch passes the server
// ===========================================================================

/** mulberry32 — a seeded generator, so a failure replays. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('TM-EVERY-05: every valid draft’s patch passes planRepeatSchedule and validation', () => {
  /** Enough to cover all 110 (task kind × reducer action) pairs with this seed, with margin. */
  const DRAFTS = 250

  // 30 s like the other seeded invariants (TM-INV-03/06): each draft runs the
  // planner's rule walk, and a CI runner is several times slower than a laptop.
  test('seeded random drafts on every kind of task, every reducer action', () => {
    const rand = seeded(20261022)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
    const time = () =>
      `${String(Math.floor(rand() * 24)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`
    const tasks = [
      FRIDAYS,
      HOME_DEPOT,
      ONE_OFF,
      ONE_OFF_DEADLINE,
      BASE,
      OVER_FRIDAYS,
      DECKED_FRIDAYS,
      QUEUED_FRIDAYS,
      OVER_HOME_DEPOT,
      DECKED_HOME_DEPOT,
    ]
    const action = (): DraftAction => {
      switch (Math.floor(rand() * 12)) {
        case 0:
          return { type: 'freq', freq: pick(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const) }
        case 1:
          return { type: 'interval', interval: 1 + Math.floor(rand() * 3) }
        case 2:
          return { type: 'toggleDay', day: pick(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']) }
        case 3:
          return { type: 'monthDay', day: pick([1, 5, 15, 28, 31, 'last'] as const) }
        case 4:
          return { type: 'mode', mode: pick(['from_due', 'from_completion'] as const) }
        case 5:
          return { type: 'targetTime', time: time() }
        case 6:
          return { type: 'deadlineTime', time: time() }
        case 7:
          return { type: 'daysBefore', days: Math.floor(rand() * 5) }
        case 8:
          return { type: 'anchor', anchor: pick(['target', 'deadline'] as const), ctx }
        case 9:
          return { type: 'addDeadline', time: time(), ctx }
        case 10:
          return pick([
            { type: 'ends', endType: 'never' },
            { type: 'ends', endType: 'count', endCount: 1 + Math.floor(rand() * 5) },
            { type: 'ends', endType: 'date', endDate: '2027-03-01' },
            { type: 'ends', endType: 'date', endDate: '2026-10-01' },
          ] as const)
        default:
          return { type: 'stop', stop: rand() < 0.3 }
      }
    }
    let valid = 0
    let refused = 0
    // Coverage: every (task kind × reducer action) pair is exercised.
    const seen = new Set<string>()
    for (let i = 0; i < DRAFTS; i++) {
      const t = Math.floor(rand() * tasks.length)
      const task = tasks[t]
      let draft = draftFromTask(task, ctx)
      const steps = 1 + Math.floor(rand() * 5)
      for (let s = 0; s < steps; s++) {
        const a = action()
        seen.add(`${t}:${a.type}`)
        draft = draftReducer(draft, a)
      }
      const problem = draftProblem(task, draft, ctx)
      if (problem) {
        refused++
        // The internal-only refusals never surface (§6.2).
        expect(problem, JSON.stringify(draft)).not.toMatch(/BYHOUR|repeat_anchor|rrule/)
        continue
      }
      valid++
      const patch = draftToPatch(task, draft, ctx)
      const label = `${i}: ${JSON.stringify({ task: task.rrule, draft, patch })}`
      expect(() => plan(task, patch), label).not.toThrow()
      expect(() => validateTaskUpdate(patch), label).not.toThrow()
      if (patch.rrule) expect(isValidRRule(patch.rrule), label).toBe(true)
      // Next agrees: a valid draft always has dates.
      if (!draft.stop) expect(nextDates(task, draft, ctx).dates.length, label).toBeGreaterThan(0)
    }
    expect(seen.size).toBe(tasks.length * 12)
    expect(valid).toBeGreaterThan(DRAFTS / 3)
    expect(refused).toBeGreaterThan(10)
  }, 30_000)
})

// ===========================================================================
// Next (§6)
// ===========================================================================

describe('TM-EVERY-06: nextDates', () => {
  test('Home Depot: one occurrence per line, the deadline then the target, both timed', () => {
    const next = nextDates(HOME_DEPOT, draftFromTask(HOME_DEPOT, ctx), ctx)
    expect(next.problem).toBeNull()
    expect(next.ends).toBe(false)
    expect(next.dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Sat Nov 7 · deadline 8:00 AM · target Fri 6:00 PM',
      'Sat Dec 5 · deadline 8:00 AM · target Fri 6:00 PM',
      'Sat Jan 2 · deadline 8:00 AM · target Fri 6:00 PM',
    ])
  })

  test('Fridays: the next three Fridays; a changed rule starts from now', () => {
    const next = nextDates(FRIDAYS, draftFromTask(FRIDAYS, ctx), ctx)
    // Across the DST change (Sun Nov 1): still 4:00 PM local.
    expect(next.dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Fri Oct 23 · 4:00 PM',
      'Fri Oct 30 · 4:00 PM',
      'Fri Nov 6 · 4:00 PM',
    ])
    const thu = run(
      draftFromTask(FRIDAYS, ctx),
      { type: 'toggleDay', day: 'FR' },
      {
        type: 'toggleDay',
        day: 'TH',
      },
    )
    // Thursday 4 PM is still ahead today.
    expect(nextDateWords(nextDates(FRIDAYS, thu, ctx).dates[0], TZ)).toBe('Thu Oct 22 · 4:00 PM')
  })

  test('one day: the deadline, then the target as a time alone', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'addDeadline', time: '17:00', ctx })
    expect(nextDateWords(nextDates(FRIDAYS, d, ctx).dates[0], TZ)).toBe(
      'Fri Oct 23 · deadline 5:00 PM · target 4:00 PM',
    )
  })

  test('ends: "After 3 times" shows three, the third the last; "On date" stops on it', () => {
    const three = run(draftFromTask(FRIDAYS, ctx), {
      type: 'ends',
      endType: 'count',
      endCount: 3,
    })
    const next = nextDates(FRIDAYS, three, ctx)
    expect(next.ends).toBe(true)
    expect(next.dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Fri Oct 23 · 4:00 PM',
      'Fri Oct 30 · 4:00 PM',
      'Fri Nov 6 · 4:00 PM · last one',
    ])
    const two = run(three, { type: 'ends', endType: 'count', endCount: 2 })
    expect(nextDates(FRIDAYS, two, ctx).dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Fri Oct 23 · 4:00 PM',
      'Fri Oct 30 · 4:00 PM · last one',
    ])
    // 2 of 6 used: the current one is the 3rd — four left.
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const left = nextDates(counted, draftFromTask(counted, ctx), ctx, 5)
    expect(left.dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Fri Oct 23 · 4:00 PM',
      'Fri Oct 30 · 4:00 PM',
      'Fri Nov 6 · 4:00 PM',
      'Fri Nov 13 · 4:00 PM · last one',
    ])
    const until = run(draftFromTask(FRIDAYS, ctx), {
      type: 'ends',
      endType: 'date',
      endDate: '2026-10-30',
    })
    expect(nextDates(FRIDAYS, until, ctx).dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Fri Oct 23 · 4:00 PM',
      'Fri Oct 30 · 4:00 PM · last one',
    ])
    // A far end: no "last one" in the first three.
    const far = run(until, { type: 'ends', endType: 'date', endDate: '2027-06-01' })
    const farNext = nextDates(FRIDAYS, far, ctx)
    expect(farNext.ends).toBe(false)
    expect(farNext.dates.some((d) => d.last)).toBe(false)
  })

  test('ends: a deadline-anchored date end is judged on the DEADLINE (A5)', () => {
    // Home Depot's Nov occurrence: target Fri Nov 6, deadline Sat Nov 7.
    const d = run(draftFromTask(HOME_DEPOT, ctx), {
      type: 'ends',
      endType: 'date',
      endDate: '2026-12-05',
    })
    expect(nextDates(HOME_DEPOT, d, ctx).dates.map((x) => nextDateWords(x, TZ))).toEqual([
      'Sat Nov 7 · deadline 8:00 AM · target Fri 6:00 PM',
      'Sat Dec 5 · deadline 8:00 AM · target Fri 6:00 PM · last one',
    ])
    const early = run(d, { type: 'ends', endType: 'date', endDate: '2026-11-06' })
    expect(draftProblem(HOME_DEPOT, early, ctx)).toBe(
      "That's before this one's date — pick a later end.",
    )
  })

  test('days-before choices: monthly allows a week, the same day refused at 6 PM', () => {
    const choices = daysBeforeChoices(HOME_DEPOT, draftFromTask(HOME_DEPOT, ctx), ctx)
    expect(choices).toHaveLength(8)
    expect(choices[0]).toEqual({ days: 0, refused: 'after_deadline' })
    expect(choices.slice(1).every((c) => c.refused === null)).toBe(true)
    expect(daysBeforeChoices(FRIDAYS, draftFromTask(FRIDAYS, ctx), ctx)).toEqual([])
  })
})

// ===========================================================================
// Next's words (2026-10-24): one occurrence per line, labelled and timed
// ===========================================================================

describe('TM-EVERY-12: nextDateWords', () => {
  const words = (targetAt: string | null, deadlineAt: string | null, last = false) =>
    nextDateWords({ targetAt, deadlineAt, last }, TZ)

  test('target-anchored: the date and its time', () => {
    expect(words(at('2026-11-07T09:00'), null)).toBe('Sat Nov 7 · 9:00 AM')
    expect(words(at('2026-11-07T09:00'), null, true)).toBe('Sat Nov 7 · 9:00 AM · last one')
  })

  test('deadline-anchored: the deadline’s day and time, then the target — its weekday within the week before', () => {
    expect(words(at('2026-11-06T12:00'), at('2026-11-07T08:00'))).toBe(
      'Sat Nov 7 · deadline 8:00 AM · target Fri 12:00 PM',
    )
    expect(words(at('2026-11-01T12:00'), at('2026-11-07T08:00'))).toBe(
      'Sat Nov 7 · deadline 8:00 AM · target Sun 12:00 PM',
    )
    expect(words(at('2026-12-04T12:00'), at('2026-12-05T08:00'), true)).toBe(
      'Sat Dec 5 · deadline 8:00 AM · target Fri 12:00 PM · last one',
    )
  })

  test('the same day: the target’s time alone', () => {
    expect(words(at('2026-11-07T07:00'), at('2026-11-07T17:00'))).toBe(
      'Sat Nov 7 · deadline 5:00 PM · target 7:00 AM',
    )
  })

  test('a week or more before, across a month, or after the deadline: the target’s full date', () => {
    // Seven days before is the same weekday as the deadline: a weekday alone would mislead.
    expect(words(at('2026-10-31T12:00'), at('2026-11-07T08:00'))).toBe(
      'Sat Nov 7 · deadline 8:00 AM · target Sat Oct 31 12:00 PM',
    )
    expect(words(at('2026-10-29T12:00'), at('2026-11-07T08:00'))).toBe(
      'Sat Nov 7 · deadline 8:00 AM · target Thu Oct 29 12:00 PM',
    )
    // Two days before, but in the month before.
    expect(words(at('2026-10-30T12:00'), at('2026-11-01T08:00'))).toBe(
      'Sun Nov 1 · deadline 8:00 AM · target Fri Oct 30 12:00 PM',
    )
    // A target moved past a deadline that has gone by.
    expect(words(at('2026-11-09T09:00'), at('2026-11-07T08:00'))).toBe(
      'Sat Nov 7 · deadline 8:00 AM · target Mon Nov 9 9:00 AM',
    )
  })

  test('across a DST change: calendar days, local times', () => {
    // Fall back (Sun Nov 1 2026, a 25-hour day): the eve stays "the day before".
    expect(words(at('2026-10-31T18:00'), at('2026-11-01T08:00'))).toBe(
      'Sun Nov 1 · deadline 8:00 AM · target Sat Oct 31 6:00 PM',
    )
    expect(words(at('2026-11-01T00:30'), at('2026-11-02T00:15'))).toBe(
      'Mon Nov 2 · deadline 12:15 AM · target Sun 12:30 AM',
    )
    // Spring forward (Sun Mar 8 2026, a 23-hour day): two days before is still two.
    expect(words(at('2026-03-07T23:30'), at('2026-03-09T00:30'))).toBe(
      'Mon Mar 9 · deadline 12:30 AM · target Sat 11:30 PM',
    )
  })

  test('no target of its own (the deadlines page): the deadline alone', () => {
    expect(words(null, at('2026-11-07T08:00'))).toBe('Sat Nov 7 · deadline 8:00 AM')
  })

  test('nextDates: a target two days before a 1st-Sunday deadline: its date only when it falls in the month before', () => {
    const firstSunday: EveryTimeTask = {
      ...BASE,
      rrule: 'FREQ=MONTHLY;BYDAY=1SU;BYHOUR=8;BYMINUTE=0',
      anchor_time: '08:00',
      deadline_at: at('2026-11-01T08:00'),
      occurrence_at: at('2026-11-01T08:00'),
      due_at: at('2026-10-30T12:00'),
      repeat_anchor: 'deadline',
      target_days_before: 2,
      target_time: '12:00',
    }
    const draft = draftFromTask(firstSunday, ctx)
    expect(nextDates(firstSunday, draft, ctx).dates.map((d) => nextDateWords(d, TZ))).toEqual([
      'Sun Nov 1 · deadline 8:00 AM · target Fri Oct 30 12:00 PM',
      'Sun Dec 6 · deadline 8:00 AM · target Fri 12:00 PM',
      'Sun Jan 3 · deadline 8:00 AM · target Fri 12:00 PM',
    ])
    // The hint says this one the same way.
    const later = run(draft, { type: 'targetTime', time: '13:00' })
    expect(thisOneHint(firstSunday, later, ctx)).toBe(
      'Changes apply to every occurrence, starting with this one: Sun Nov 1 · deadline 8:00 AM · target Fri Oct 30 1:00 PM.',
    )
  })
})

// ===========================================================================
// The hint (§5.6)
// ===========================================================================

describe('TM-EVERY-07: thisOneHint', () => {
  test('Stop repeating: what this one stays as — an unmoved relative target is kept (ruling 6)', () => {
    const d = run(draftFromTask(HOME_DEPOT, ctx), { type: 'stop', stop: true })
    expect(thisOneHint(HOME_DEPOT, d, ctx)).toBe(
      'This one stays as a one-time task: target Fri Nov 6, 6:00 PM, deadline Sat Nov 7, 8:00 AM. The target stays the day before and moves with the deadline.',
    )
    // Moved this occurrence (or on deck): the target is fixed where it is.
    const moved = { ...HOME_DEPOT, due_at: at('2026-11-05T09:00') }
    const m = run(draftFromTask(moved, ctx), { type: 'stop', stop: true })
    expect(thisOneHint(moved, m, ctx)).toBe(
      'This one stays as a one-time task: target Thu Nov 5, 9:00 AM, deadline Sat Nov 7, 8:00 AM.',
    )
    expect(stopKeepsRelativeTarget(HOME_DEPOT, TZ)).toEqual({ days_before: 1, time: '18:00' })
    expect(stopKeepsRelativeTarget(moved, TZ)).toBeNull()
    expect(stopKeepsRelativeTarget({ ...HOME_DEPOT, on_deck_day: '2026-11-06' }, TZ)).toBeNull()
  })

  test('on schedule: changes start with this one, at the target the Save gives it', () => {
    const d = run(draftFromTask(HOME_DEPOT, ctx), { type: 'daysBefore', days: 2 })
    expect(thisOneHint(HOME_DEPOT, d, ctx)).toBe(
      'Changes apply to every occurrence, starting with this one: Sat Nov 7 · deadline 8:00 AM · target Thu 6:00 PM.',
    )
    const thu = run(
      draftFromTask(FRIDAYS, ctx),
      { type: 'toggleDay', day: 'FR' },
      {
        type: 'toggleDay',
        day: 'TH',
      },
    )
    expect(thisOneHint(FRIDAYS, thu, ctx)).toBe(
      'Changes apply to every occurrence, starting with this one: Thu Oct 22 · 4:00 PM.',
    )
  })

  test('this one has something of its own (4a’s personal: deck or moved)', () => {
    const moved = { ...FRIDAYS, due_at: at('2026-10-24T10:00') }
    expect(occurrenceKeepsItsOwn(moved, ctx)).toBe(true)
    expect(thisOneHint(moved, draftFromTask(moved, ctx), ctx)).toBe(KEEPS_ITS_OWN_TARGET)
    expect(thisOneHint(DECKED_FRIDAYS, draftFromTask(DECKED_FRIDAYS, ctx), ctx)).toBe(
      KEEPS_ITS_DECK,
    )
    expect(occurrenceKeepsItsOwn(FRIDAYS, ctx)).toBe(false)
    expect(occurrenceKeepsItsOwn(HOME_DEPOT, ctx)).toBe(false)
  })

  test('over target: kept on a RULE change (the debt), re-derived on new offsets — the hint says which', () => {
    expect(occurrenceKeepsItsOwn(OVER_FRIDAYS, ctx)).toBe(false)
    const thu = run(draftFromTask(OVER_FRIDAYS, ctx), { type: 'toggleDay', day: 'TH' })
    expect(thisOneHint(OVER_FRIDAYS, thu, ctx)).toBe(KEEPS_ITS_OWN_TARGET)
    // Deadline-anchored, new offsets: the server re-derives this one's target.
    const offsets = run(draftFromTask(OVER_HOME_DEPOT, ctx), { type: 'daysBefore', days: 2 })
    const p = plan(OVER_HOME_DEPOT, draftToPatch(OVER_HOME_DEPOT, offsets, ctx))
    expect(p).toMatchObject({ kind: 'deadline', dueAt: at('2026-10-01T18:00') })
    expect(thisOneHint(OVER_HOME_DEPOT, offsets, ctx)).toBe(
      'Changes apply to every occurrence, starting with this one: Sat Oct 3 · deadline 8:00 AM · target Thu 6:00 PM.',
    )
    // Deadline-anchored, a rule change: the debt is kept.
    const time = run(draftFromTask(OVER_HOME_DEPOT, ctx), { type: 'deadlineTime', time: '09:00' })
    expect(thisOneHint(OVER_HOME_DEPOT, time, ctx)).toBe(KEEPS_ITS_OWN_TARGET)
  })

  test('a QUEUED repeat is not personal: the rollover moved its target, so the change recomputes it', () => {
    // The rollover kept the missed Fri Oct 16 occurrence and moved the target to the next one.
    const queued = {
      ...FRIDAYS,
      occurrence_at: at('2026-10-16T16:00'),
      due_at: at('2026-10-23T16:00'),
      queued_at: at('2026-10-17T06:00'),
    }
    expect(occurrenceKeepsItsOwn(queued, ctx)).toBe(false)
    const thu = run(
      draftFromTask(queued, ctx),
      { type: 'toggleDay', day: 'FR' },
      {
        type: 'toggleDay',
        day: 'TH',
      },
    )
    expect(thisOneHint(queued, thu, ctx)).toBe(
      'Changes apply to every occurrence, starting with this one: Thu Oct 22 · 4:00 PM.',
    )
  })

  test('create mode has none', () => {
    expect(thisOneHint(null, draftFromTask(BASE, ctx), ctx)).toBeNull()
  })
})

// ===========================================================================
// Bulk (A11)
// ===========================================================================

describe('TM-EVERY-08: bulk gating', () => {
  const row = (t: EveryTimeTask) => ({
    rrule: t.rrule,
    repeat_anchor: t.repeat_anchor,
    deadline_at: t.deadline_at,
  })

  test('only one-offs without deadlines and target-anchored repeats', () => {
    expect(bulkEveryTimeGate([row(FRIDAYS), row(ONE_OFF)])).toEqual({ offered: true, reason: null })
    expect(bulkEveryTimeGate([row(FRIDAYS), row(ONE_OFF_DEADLINE)])).toEqual({
      offered: false,
      reason: BULK_DEADLINE_REASON,
    })
    expect(bulkEveryTimeGate([row(FRIDAYS), row(HOME_DEPOT)]).reason).toBe(BULK_DEADLINE_REASON)
    expect(bulkEveryTimeGate([row(FRIDAYS), { ...row(ONE_OFF), is_reminder: true }]).reason).toBe(
      BULK_KIND_REASON,
    )
    expect(bulkEveryTimeGate([{ ...row(FRIDAYS), progress_target: 3 }]).reason).toBe(
      BULK_KIND_REASON,
    )
  })

  test('a bulk Save sends the rule at its target time, or rrule null', () => {
    const d = draftFromTask(FRIDAYS, ctx)
    expect(draftToBulkChanges(d)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
      recurrence_mode: 'from_due',
    })
    expect(draftToBulkChanges({ ...d, stop: true })).toEqual({ rrule: null })
  })
})

// ===========================================================================
// RT-11: the browser-safe modules import no database
// ===========================================================================

describe('TM-EVERY-G01 (RT-11): planRepeatSchedule and every-time import no database', () => {
  const root = path.join(process.cwd(), 'src')
  const FORBIDDEN = /^(better-sqlite3|node:|fs$|path$)|^@\/core\/db(\/|$)/

  /** Every module `file` loads at runtime (type-only imports skipped), transitively. */
  function runtimeImports(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen
    seen.add(file)
    const src = fs.readFileSync(file, 'utf8')
    // Imports and re-exports (a barrel like `@/core/recurrence` re-exports).
    const re = /^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2]
      // A named list of only `type X` members loads nothing.
      if (/^(?:import|export)\s*\{\s*(type\s+\w+\s*,?\s*)+\}/.test(m[0])) continue
      if (FORBIDDEN.test(spec)) seen.add(`FORBIDDEN:${spec} (from ${path.relative(root, file)})`)
      const base = spec.startsWith('@/')
        ? path.join(root, spec.slice(2))
        : spec.startsWith('.')
          ? path.resolve(path.dirname(file), spec)
          : null
      if (!base) continue
      const resolved = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((f) =>
        fs.existsSync(f),
      )
      if (resolved) runtimeImports(resolved, seen)
    }
    return seen
  }

  test('the walk catches a server module (it would fail on one)', () => {
    const all = [...runtimeImports(path.join(root, 'core/tasks/create.ts'))]
    expect(all.some((f) => f.startsWith('FORBIDDEN:'))).toBe(true)
  })

  test.each([
    'core/tasks/repeat-schedule.ts',
    'lib/every-time.ts',
    'lib/rrule-draft.ts',
    'core/recurrence/rule-shift.ts',
    'lib/editor-target-labels.ts',
  ])('%s', (file) => {
    const all = [...runtimeImports(path.join(root, file))]
    expect(all.filter((f) => f.startsWith('FORBIDDEN:'))).toEqual([])
    // The walk really ran: it reached the recurrence engine.
    if (file !== 'lib/rrule-draft.ts') {
      expect(all.some((f) => f.endsWith('compute-next.ts'))).toBe(true)
    }
  })
})

// ===========================================================================
// Ends travel as fields (4c; plan-repeat-ends §7 item 3)
// ===========================================================================

describe('TM-EVERY-10: an end is sent as repeat_count / repeat_until, never in the rule', () => {
  test('setting an end on an unchanged rule sends the end alone — no rrule', () => {
    const d = run(draftFromTask(FRIDAYS, ctx), { type: 'ends', endType: 'count', endCount: 6 })
    expect(draftToPatch(FRIDAYS, d, ctx)).toEqual({ repeat_count: 6 })
    const until = run(d, { type: 'ends', endType: 'date', endDate: '2026-12-31' })
    expect(draftToPatch(FRIDAYS, until, ctx)).toEqual({ repeat_until: '2026-12-31' })
  })

  test('a stored end opens in the draft and an untouched one is not re-sent', () => {
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const d = draftFromTask(counted, ctx)
    expect(d.rule).toMatchObject({ endType: 'count', endCount: 6 })
    expect(draftToPatch(counted, d, ctx)).toEqual({})
    // A rule change keeps the end: the rule alone, end-free.
    const sat = run(d, { type: 'toggleDay', day: 'SA' })
    expect(draftToPatch(counted, sat, ctx)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=FR,SA;BYHOUR=16;BYMINUTE=0',
    })
    const dated = { ...FRIDAYS, repeat_until: '2026-12-31' }
    expect(draftFromTask(dated, ctx).rule).toMatchObject({ endType: 'date', endDate: '2026-12-31' })
  })

  test('back to Never clears the stored end', () => {
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const never = run(draftFromTask(counted, ctx), { type: 'ends', endType: 'never' })
    expect(draftToPatch(counted, never, ctx)).toEqual({ repeat_count: null })
    const dated = { ...FRIDAYS, repeat_until: '2026-12-31' }
    const never2 = run(draftFromTask(dated, ctx), { type: 'ends', endType: 'never' })
    expect(draftToPatch(dated, never2, ctx)).toEqual({ repeat_until: null })
  })

  test('a one-off made repeating with an end; create carries it too', () => {
    const d = run(draftFromTask(ONE_OFF, ctx), { type: 'ends', endType: 'count', endCount: 3 })
    expect(draftToPatch(ONE_OFF, d, ctx)).toMatchObject({ repeat_count: 3 })
    expect(draftToPatch(ONE_OFF, d, ctx).rrule).not.toMatch(/COUNT|UNTIL/)
    expect(draftToCreateFields({ dueAt: null }, d, ctx)).toMatchObject({ repeat_count: 3 })
  })

  test('Stop repeating sends the rule alone (the server clears the end)', () => {
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const d = run(draftFromTask(counted, ctx), { type: 'stop', stop: true })
    expect(draftToPatch(counted, d, ctx)).toEqual({ rrule: null })
  })
})

// ===========================================================================
// Review fixes (4c): nothing silently lost
// ===========================================================================

describe('TM-EVERY-11: a save never loses what the draft can not say', () => {
  test('"On date…" with no date picked is no change — never a removal of the stored end', () => {
    const counted = { ...FRIDAYS, repeat_count: 6, repeat_count_used: 2 }
    const d = run(draftFromTask(counted, ctx), { type: 'ends', endType: 'date', endDate: '' })
    expect(draftToPatch(counted, d, ctx)).toEqual({})
    expect(draftProblem(counted, d, ctx)).toBe(NO_END_DATE_PROBLEM)
  })

  test('ruleDraftable: the shapes a draft holds exactly, and the ones it would lose', () => {
    const yes = [
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=12;BYMINUTE=0',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
    ]
    const no = [
      'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0',
      'FREQ=YEARLY;BYMONTH=3,9;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=1MO,3MO;BYHOUR=9;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0',
      'FREQ=WEEKLY;WKST=SU;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      'FREQ=HOURLY;INTERVAL=4',
    ]
    for (const r of yes) expect(ruleDraftable(r), r).toBe(true)
    for (const r of no) expect(ruleDraftable(r), r).toBe(false)
  })

  test('BYMONTHDAY=1,15 is never rebuilt: edits send nothing, Stop repeating still works', () => {
    const twice = { ...FRIDAYS, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=16;BYMINUTE=0' }
    expect(scheduleEditable(twice)).toBe(false)
    const d = run(draftFromTask(twice, ctx), { type: 'targetTime', time: '17:00' })
    expect(draftToPatch(twice, d, ctx)).toEqual({})
    const stop = run(draftFromTask(twice, ctx), { type: 'stop', stop: true })
    expect(draftToPatch(twice, stop, ctx)).toEqual({ rrule: null })
  })

  test('a one-off with a deadline made target-anchored: the hint says the deadline goes', () => {
    const d = run(draftFromTask(ONE_OFF_DEADLINE, ctx), { type: 'anchor', anchor: 'target', ctx })
    expect(draftToPatch(ONE_OFF_DEADLINE, d, ctx)).toMatchObject({ deadline_at: null })
    expect(thisOneHint(ONE_OFF_DEADLINE, d, ctx)).toBe('The deadline (Fri Oct 30) will be removed.')
  })
})

describe('the lead override of a target-less deadline repeat (the deadlines page, 2026-10-22)', () => {
  const TARGETLESS: EveryTimeTask = {
    ...HOME_DEPOT,
    due_at: null,
    target_days_before: null,
    target_time: null,
    lead_days: null,
  }

  test('opens with no target and the stored lead; a step saves lead_days alone', () => {
    const d = draftFromTask(TARGETLESS, ctx)
    expect(d).toMatchObject({ noTarget: true, leadDays: null })
    expect(draftToPatch(TARGETLESS, d, ctx)).toEqual({})
    const stepped = draftReducer(d, { type: 'leadDays', days: 5 })
    expect(draftsEqual(d, stepped)).toBe(false)
    expect(draftToPatch(TARGETLESS, stepped, ctx)).toEqual({ lead_days: 5 })
    // Back to the default: null, sent only when the stored one differs.
    const stored = { ...TARGETLESS, lead_days: 5 }
    const back = draftReducer(draftFromTask(stored, ctx), { type: 'leadDays', days: null })
    expect(draftToPatch(stored, back, ctx)).toEqual({ lead_days: null })
  })

  test('a draft WITH a target steps Upcoming’s lead instead (2026-10-25); never the deadlines page’s row', () => {
    const d = draftFromTask(HOME_DEPOT, ctx)
    expect(d.leadDays).toBeNull()
    expect(upcomingLeadStep(TARGETLESS, draftFromTask(TARGETLESS, ctx), ctx)).toBeNull()
    expect(draftToPatch(HOME_DEPOT, draftReducer(d, { type: 'leadDays', days: 5 }), ctx)).toEqual({
      lead_days: 5,
    })
  })
})

describe('Upcoming’s lead on a repeat with a target (2026-10-25, the Upcoming split)', () => {
  test('UP-140: target-anchored weekly — the day before by default, up to 6 days; a step saves lead_days alone', () => {
    const d = draftFromTask(FRIDAYS, ctx)
    expect(d.leadDays).toBeNull()
    expect(upcomingLeadStep(FRIDAYS, d, ctx)).toEqual({
      lead: 1,
      fallback: 1,
      max: 6,
      reset: false,
    })
    expect(upcomingLeadStepWords(1)).toBe('Tomorrow the day before each one')
    const stepped = draftReducer(d, { type: 'leadDays', days: 3 })
    expect(draftsEqual(d, stepped)).toBe(false)
    expect(upcomingLeadStep(FRIDAYS, stepped, ctx)!.lead).toBe(3)
    expect(upcomingLeadStepWords(3)).toBe('Later 3 days before each one · Tomorrow the day before')
    expect(draftToPatch(FRIDAYS, stepped, ctx)).toEqual({ lead_days: 3 })
    // Back to Default: null, sent only when the stored one differs.
    const stored = { ...FRIDAYS, lead_days: 3 }
    expect(draftFromTask(stored, ctx).leadDays).toBe(3)
    const back = draftReducer(draftFromTask(stored, ctx), { type: 'leadDays', days: null })
    expect(draftToPatch(stored, back, ctx)).toEqual({ lead_days: null })
  })

  test('UP-141: a relative-target (deadline-anchored) monthly — the default 4, a long top', () => {
    const step = upcomingLeadStep(HOME_DEPOT, draftFromTask(HOME_DEPOT, ctx), ctx)!
    expect(step.fallback).toBe(4)
    expect(step.lead).toBe(4)
    expect(step.max).toBeGreaterThanOrEqual(27)
  })

  test('UP-142: a daily rule has no Upcoming at all — no row (any override would be refused)', () => {
    const daily = draftReducer(draftFromTask(FRIDAYS, ctx), { type: 'freq', freq: 'DAILY' })
    expect(upcomingLeadStep(FRIDAYS, daily, ctx)).toBeNull()
  })

  test('UP-144: a shorter rule resets a lead it makes too long — the same Save sends lead_days null, never a 400', () => {
    // A weekly with a lead of 3, made daily: no Upcoming at all, the lead goes.
    const stored = { ...FRIDAYS, lead_days: 3 }
    const daily = draftReducer(draftFromTask(stored, ctx), { type: 'freq', freq: 'DAILY' })
    expect(leadResetForRule(stored, daily, ctx)).toBe(true)
    expect(upcomingLeadStep(stored, daily, ctx)).toBeNull()
    expect(draftToPatch(stored, daily, ctx)).toMatchObject({ lead_days: null })
    expect(draftToPatch(stored, daily, ctx).rrule).toMatch(/^FREQ=DAILY/)
    // Every 2 days (a wait of 2): the stepper shows the default (1), Default staged.
    const everyOther = draftReducer(daily, { type: 'interval', interval: 2 })
    expect(upcomingLeadStep(stored, everyOther, ctx)).toMatchObject({ lead: 1, reset: true })
    expect(draftToPatch(stored, everyOther, ctx)).toMatchObject({ lead_days: null })
    // Back to weekly: the lead fits again and is kept (nothing sent).
    const back = draftReducer(daily, { type: 'freq', freq: 'WEEKLY' })
    expect(leadResetForRule(stored, back, ctx)).toBe(false)
    expect(draftToPatch(stored, back, ctx)).not.toHaveProperty('lead_days')
    // A STAGED lead the new rule can't take: not sent (the stored one is already the default).
    const staged = draftReducer(draftFromTask(FRIDAYS, ctx), { type: 'leadDays', days: 5 })
    const shorter = draftReducer(staged, { type: 'freq', freq: 'DAILY' })
    expect(draftToPatch(FRIDAYS, shorter, ctx)).not.toHaveProperty('lead_days')
    // The patch the server takes: validated like any PATCH.
    expect(() => validateTaskUpdate(draftToPatch(stored, daily, ctx))).not.toThrow()
    expect(LEAD_RESET_FOR_RULE).toBe('Lead time back to default for the new rule')
  })

  test('UP-143: a one-off made to repeat carries its own lead into the draft', () => {
    expect(draftFromTask({ ...ONE_OFF, lead_days: 2 }, ctx).leadDays).toBe(2)
    expect(
      draftToPatch(
        { ...ONE_OFF, lead_days: 2 },
        draftFromTask({ ...ONE_OFF, lead_days: 2 }, ctx),
        ctx,
      ),
    ).not.toHaveProperty('lead_days')
  })
})
