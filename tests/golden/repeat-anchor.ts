/**
 * DEADLINE-ANCHORED REPEATS (2026-10-21; docs/TASK-MODEL.md § Recurrence
 * Model), as day-by-day timelines — G1 to G9 of the plan, written from the
 * rules, not from the simulator's output:
 *
 *  - the rule walks the DEADLINE (`occurrence_at` = `deadline_at`); the
 *    target is derived from it, `target_days_before` local days earlier at
 *    `target_time` (`occurrenceDates`), and never after it;
 *  - Upcoming counts to the derived target from `target_set_at`
 *    (done and skip stamp it): the day before when the wait is 2+, and 3 or 4
 *    days before as well when it is over 7;
 *  - done and skip write the next occurrence's derived dates — a move never
 *    carries over; attempts reset;
 *  - a deadline task is never stripped, rolled or waited by the rollover; a
 *    deck's end gives the derived target back.
 * Read at 21:00 local, America/Chicago.
 */
import { expect } from 'vitest'
import { markDone } from '@/core/tasks/mark-done'
import { snoozeTask } from '@/core/tasks/snooze'
import { skipOccurrence } from '@/core/tasks/skip'
import { skipUntil } from '@/core/tasks/skip-until'
import { deckTasks } from '@/core/tasks/deck'
import { getTaskById } from '@/core/tasks/read'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { isPastDeadline } from '@/lib/task-segments'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'

function done(name: string) {
  return (ctx: SimContext) => {
    markDone({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids[name] })
  }
}

function check(name: string, fields: Record<string, unknown>) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    for (const [k, v] of Object.entries(fields)) {
      expect((task as unknown as Record<string, unknown>)[k], `${name}.${k}`).toEqual(v)
    }
  }
}

/** Over target right now, and (optionally) past its deadline. */
function nagging(name: string, pastDeadline: boolean) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    expect(getCurrentlyDueTaskIds(ctx.userId), `${name} due`).toContain(task.id)
    expect(isPastDeadline(task.deadline_at, new Date()), `${name} past deadline`).toBe(pastDeadline)
  }
}

const SUNDAY_23 = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0'
const SATURDAY_8 = 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0'
const MONDAY_9 = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0'
/** Home Depot's kids' workshop: the 1st Saturday of the month at 8 AM. */
const FIRST_SATURDAY_8 = 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0'

/** Deadline Saturdays 8 AM; target `days` before at `time`. Made Mon Oct 19 2026 10:00. */
function saturdayTask(days: number, time: string) {
  return {
    name: 'task',
    created: '2026-10-19T10:00',
    input: {
      title: 'Synthetic Saturday deadline',
      rrule: SATURDAY_8,
      deadline_at: iso('2026-10-24T08:00'),
      target_days_before: days,
      target_time: time,
    },
  }
}

export const repeatAnchorScenarios: GoldenScenario[] = [
  {
    id: 'ra-g1-sunday-deadline',
    title: "G1 — production's shape: deadline Sundays 11 PM, target that Sunday noon",
    source: 'plan G1 (task 26816 shape); 2026-10-21',
    from: '2026-10-05',
    to: '2026-10-20',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-05T10:00',
        // The target sent with the deadline gives the offset: the same day, 12:00.
        input: {
          title: 'Synthetic weekly post',
          rrule: SUNDAY_23,
          deadline_at: iso('2026-10-11T23:00'),
          due_at: iso('2026-10-11T12:00'),
        },
      },
    ],
    events: [
      {
        at: '2026-10-05T10:01',
        run: check('task', {
          repeat_anchor: 'deadline',
          target_days_before: 0,
          target_time: '12:00',
          occurrence_at: iso('2026-10-11T23:00'),
        }),
      },
      // Over target from noon, before its deadline.
      { at: '2026-10-11T12:30', run: nagging('task', false) },
      { at: '2026-10-11T15:00', run: done('task') },
      {
        at: '2026-10-11T15:01',
        run: check('task', {
          occurrence_at: iso('2026-10-18T23:00'),
          deadline_at: iso('2026-10-18T23:00'),
          due_at: iso('2026-10-18T12:00'),
        }),
      },
      // Not done the next week: past its deadline at 23:01, still nagging.
      { at: '2026-10-18T23:01', run: nagging('task', true) },
    ],
    expect: {
      task: {
        // Made Mon for Sun (wait 6): the day before.
        '2026-10-10': 'tomorrow',
        // Done Sun 15:00 for the next Sunday (wait 7): Saturday only.
        '2026-10-17': 'tomorrow',
        '2026-10-18': 'over 1×',
        '2026-10-19': 'over 2×',
        '2026-10-20': 'over 3×',
      },
    },
  },
  {
    id: 'ra-g2-home-depot',
    title: 'G2 — Home Depot: 1st Saturday 8 AM, target the Friday before at 6 PM (across months)',
    source: 'plan G2; 2026-10-21',
    from: '2027-04-10',
    to: '2027-06-06',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2027-04-10T10:00',
        input: {
          title: 'Synthetic workshop',
          rrule: FIRST_SATURDAY_8,
          deadline_at: iso('2027-05-01T08:00'),
          target_days_before: 1,
          target_time: '18:00',
        },
      },
    ],
    events: [
      { at: '2027-04-10T10:01', run: check('task', { due_at: iso('2027-04-30T18:00') }) },
      {
        at: '2027-04-30T21:30',
        run: check('task', {
          occurrence_at: iso('2027-06-05T08:00'),
          deadline_at: iso('2027-06-05T08:00'),
          due_at: iso('2027-06-04T18:00'),
        }),
      },
      {
        at: '2027-06-04T21:30',
        run: check('task', {
          deadline_at: iso('2027-07-03T08:00'),
          due_at: iso('2027-07-02T18:00'),
        }),
      },
    ],
    expect: {
      task: {
        // Wait 20 (Apr 10 → Fri Apr 30): 4 days before, and the day before.
        '2027-04-26': 'later',
        '2027-04-29': 'tomorrow',
        '2027-04-30': 'over 1×',
        // Done Fri Apr 30 → Fri Jun 4 (wait 35): May 31 and Jun 3.
        '2027-05-31': 'later',
        '2027-06-03': 'tomorrow',
        '2027-06-04': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g3-dst-spring',
    title: 'G3a — DST, spring: target the day before at 2:30 AM → 3:00 on Mar 14',
    source: 'plan G3; localMoment (next valid minute); 2026-10-21',
    from: '2027-03-03',
    to: '2027-03-14',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2027-03-03T10:00',
        input: {
          title: 'Synthetic Monday',
          rrule: MONDAY_9,
          deadline_at: iso('2027-03-08T09:00'),
          target_days_before: 1,
          target_time: '02:30',
        },
      },
    ],
    events: [
      { at: '2027-03-03T10:01', run: check('task', { due_at: '2027-03-07T08:30:00.000Z' }) },
      {
        at: '2027-03-07T21:30',
        run: check('task', {
          deadline_at: '2027-03-15T14:00:00.000Z',
          due_at: '2027-03-14T08:00:00.000Z',
        }),
      },
    ],
    expect: {
      task: {
        '2027-03-06': 'tomorrow',
        '2027-03-07': 'over 1×',
        '2027-03-13': 'tomorrow',
        '2027-03-14': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g3-dst-fall',
    title: 'G3b — DST, fall: target the day before at 1:30 AM → the first 1:30 on Nov 1',
    source: 'plan G3; localMoment (first instant); 2026-10-21',
    from: '2026-10-21',
    to: '2026-11-01',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-21T10:00',
        input: {
          title: 'Synthetic Monday',
          rrule: MONDAY_9,
          deadline_at: iso('2026-10-26T09:00'),
          target_days_before: 1,
          target_time: '01:30',
        },
      },
    ],
    events: [
      { at: '2026-10-21T10:01', run: check('task', { due_at: '2026-10-25T06:30:00.000Z' }) },
      {
        at: '2026-10-25T21:30',
        run: check('task', {
          deadline_at: '2026-11-02T15:00:00.000Z',
          due_at: '2026-11-01T06:30:00.000Z',
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-24': 'tomorrow',
        '2026-10-25': 'over 1×',
        '2026-10-31': 'tomorrow',
        '2026-11-01': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g4-snooze-capped',
    title: 'G4 — a move past the deadline stops at it; the next occurrence re-derives',
    source: 'plan G4; §8.2; 2026-10-21',
    from: '2026-10-19',
    to: '2026-10-30',
    policy: ['tap'],
    tasks: [saturdayTask(1, '18:00')],
    events: [
      {
        at: '2026-10-23T19:00',
        run: (ctx) => {
          const r = snoozeTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            until: iso('2026-10-25T10:00'),
          })
          expect(r.task.due_at).toBe(iso('2026-10-24T08:00'))
          expect(r.cappedAtDeadline).toBe(true)
        },
      },
      { at: '2026-10-24T10:00', run: done('task') },
      {
        at: '2026-10-24T10:01',
        run: check('task', {
          deadline_at: iso('2026-10-31T08:00'),
          due_at: iso('2026-10-30T18:00'),
          attempts: 0,
        }),
      },
    ],
    expect: {
      task: {
        // Made Mon for Fri 18:00 (wait 4): Thursday.
        '2026-10-22': 'tomorrow',
        // Over at 18:00 (1×), moved at 19:00 to the deadline: quiet, 1× kept.
        '2026-10-23': 'quiet 1×',
        // Done Sat → Fri Oct 30 18:00 (wait 6): Thursday.
        '2026-10-29': 'tomorrow',
        '2026-10-30': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g5-done-early-late',
    title: 'G5 — done early (before the target) and done late (after the deadline): the next one',
    source: 'plan G5; 2026-10-21',
    from: '2027-04-20',
    to: '2027-07-02',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2027-04-20T10:00',
        input: {
          title: 'Synthetic workshop',
          rrule: FIRST_SATURDAY_8,
          deadline_at: iso('2027-05-01T08:00'),
          target_days_before: 1,
          target_time: '18:00',
        },
      },
    ],
    events: [
      // Done Thursday, before Friday's target: the NEXT 1st Saturday's Friday.
      { at: '2027-04-29T10:00', run: done('task') },
      {
        at: '2027-04-29T10:01',
        run: check('task', {
          deadline_at: iso('2027-06-05T08:00'),
          due_at: iso('2027-06-04T18:00'),
        }),
      },
      // Not done by the deadline; done Sunday: July's.
      { at: '2027-06-06T10:00', run: done('task') },
      {
        at: '2027-06-06T10:01',
        run: check('task', {
          deadline_at: iso('2027-07-03T08:00'),
          due_at: iso('2027-07-02T18:00'),
          attempts: 0,
        }),
      },
    ],
    expect: {
      task: {
        // Made Tue Apr 20 for Fri Apr 30 (wait 10): 3 days before, the day before.
        '2027-04-27': 'later',
        // Done the morning of the 29th: the heads-up is gone by 21:00.
        // Jun 4 (wait 36 from Apr 29): May 31 and Jun 3.
        '2027-05-31': 'later',
        '2027-06-03': 'tomorrow',
        '2027-06-04': 'over 1×',
        '2027-06-05': 'over 2×',
        // Jul 2 (wait 26 from Jun 6): Jun 28 and Jul 1.
        '2027-06-28': 'later',
        '2027-07-01': 'tomorrow',
        '2027-07-02': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g6-skip-until-deadline-day',
    title:
      'G6 — skip, then skip until a deadline Saturday: its Friday target is before, so it goes too',
    source: 'plan G6; skip until on the derived target; 2026-10-21',
    from: '2026-10-19',
    to: '2026-11-13',
    policy: ['tap'],
    tasks: [saturdayTask(1, '18:00')],
    events: [
      {
        at: '2026-10-20T10:00',
        run: (ctx) => {
          skipOccurrence({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids.task })
        },
      },
      {
        at: '2026-10-20T10:01',
        run: check('task', {
          deadline_at: iso('2026-10-31T08:00'),
          due_at: iso('2026-10-30T18:00'),
        }),
      },
      {
        at: '2026-10-21T10:00',
        run: (ctx) => {
          const r = skipUntil({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskIds: [ctx.ids.task],
            until: '2026-11-07',
          })
          // Oct 31, then Nov 7 (its target Fri Nov 6 is before the date).
          expect(r.occurrencesSkipped).toBe(2)
        },
      },
      {
        at: '2026-10-21T10:01',
        run: check('task', {
          occurrence_at: iso('2026-11-14T08:00'),
          deadline_at: iso('2026-11-14T08:00'),
          due_at: iso('2026-11-13T18:00'),
          skip_count: 3,
        }),
      },
    ],
    expect: {
      task: {
        // Skipped Tue before Thursday's heads-up; then Fri Nov 13 (wait 23
        // from Oct 21): 4 days before, the day before.
        '2026-11-09': 'later',
        '2026-11-12': 'tomorrow',
        '2026-11-13': 'over 1×',
      },
    },
  },
  {
    id: 'ra-g7-deck',
    title:
      'G7 — decked on its target day: no nag; the next rollover gives the target back, arrived',
    source: 'plan G7; repeating deck ruling; 2026-10-21',
    from: '2026-10-19',
    to: '2026-10-24',
    policy: ['never'],
    queue: {},
    tasks: [saturdayTask(2, '18:00')],
    events: [
      {
        at: '2026-10-22T07:00',
        run: (ctx) => {
          deckTasks({ userId: ctx.userId, timezone: ctx.timezone, ids: [ctx.ids.task] })
        },
      },
      {
        at: '2026-10-23T06:31',
        run: check('task', {
          on_deck_day: null,
          due_at: iso('2026-10-22T18:00'),
          occurrence_at: iso('2026-10-24T08:00'),
          queued_at: null,
        }),
      },
    ],
    expect: {
      task: {
        // Made Mon for Thu 18:00 (wait 3): Wednesday.
        '2026-10-21': 'tomorrow',
        '2026-10-22': 'deck',
        // The derived target is back (already arrived): the badge counts from the restore.
        '2026-10-23': 'over 1×',
        '2026-10-24': 'over 2×',
      },
    },
  },
  {
    id: 'ra-g8-rollover-never',
    title:
      'G8 — the rollover never strips, rolls or waits a deadline-anchored repeat; a control rolls',
    source: 'plan G8; ELIGIBLE_SQL; 2026-10-21',
    from: '2026-10-19',
    to: '2026-10-24',
    policy: ['never'],
    queue: {},
    tasks: [
      saturdayTask(2, '18:00'),
      {
        name: 'control',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic daily', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0' },
      },
    ],
    events: [
      {
        at: '2026-10-24T06:31',
        run: check('task', { queued_at: null, skip_count: 0, due_at: iso('2026-10-22T18:00') }),
      },
    ],
    expect: {
      task: {
        '2026-10-21': 'tomorrow',
        '2026-10-22': 'over 1×',
        '2026-10-23': 'over 2×',
        '2026-10-24': 'over 3×',
      },
      // The control rolls each morning with a skip: attempts afresh.
      control: { '2026-10-19..2026-10-24': 'over 1×' },
    },
  },
  {
    id: 'ra-g9-from-completion',
    title: 'G9 — from_completion every 3 months: done → deadline = completion + 3 months at 5 PM',
    source: 'plan G9; A5; 2026-10-21',
    from: '2026-10-19',
    to: '2026-10-24',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T10:00',
        input: {
          title: 'Synthetic filter change',
          rrule: 'FREQ=MONTHLY;INTERVAL=3;BYHOUR=17;BYMINUTE=0',
          recurrence_mode: 'from_completion',
          deadline_at: iso('2026-10-23T17:00'),
          target_days_before: 2,
          target_time: '09:00',
        },
      },
    ],
    events: [
      { at: '2026-10-22T12:00', run: done('task') },
      {
        at: '2026-10-22T12:01',
        run: check('task', {
          occurrence_at: iso('2027-01-22T17:00'),
          deadline_at: iso('2027-01-22T17:00'),
          due_at: iso('2027-01-20T09:00'),
        }),
      },
    ],
    expect: {
      task: {
        // Made Mon for Wed 09:00 (wait 2): Tuesday.
        '2026-10-20': 'tomorrow',
        '2026-10-21': 'over 1×',
      },
    },
  },
]
