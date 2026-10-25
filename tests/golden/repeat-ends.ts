/**
 * REPEAT ENDS (2026-10-22; docs/TASK-MODEL.md § Repeat ends), as day-by-day
 * timelines — written from the rules, not from the simulator's output:
 *
 *  - "After N times" counts OCCURRENCES CLOSED (done or skipped — a rollover
 *    roll is a skip) from when the count was set; "On date" keeps every
 *    occurrence whose LOCAL date is on or before it (a deadline-anchored
 *    repeat's occurrence is its deadline);
 *  - done on the last occurrence ends the series: done=1, archived — the
 *    "done" place from then on;
 *  - the rollover never ends a series (A4): a missed last occurrence stays
 *    over target as debt, its attempts climbing, until the user closes it;
 *  - otherwise every day reads as any repeat's: heads-ups by the wait (the
 *    day before from a wait of 2; 3 days before as well over 7), "over 1×" on
 *    an occurrence's day.
 * Read at 21:00 local, America/Chicago.
 */
import { expect } from 'vitest'
import { markDone } from '@/core/tasks/mark-done'
import { getTaskById } from '@/core/tasks/read'
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

export const repeatEndsScenarios: GoldenScenario[] = [
  {
    id: 're-weekly-for-3',
    title: 'Weekly Friday 9 AM for 3 times, each done on its day: the third done ends it',
    source: 'plan §6 golden 1; 2026-10-22',
    from: '2026-10-19',
    to: '2026-11-09',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T08:00',
        input: {
          title: 'Synthetic weekly, three times',
          rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
          repeat_count: 3,
        },
      },
    ],
    events: [
      // After the second done (Fri Oct 30 21:00): the third is the last.
      {
        at: '2026-10-31T10:00',
        run: check('task', {
          occurrence_at: iso('2026-11-06T09:00'),
          repeat_count_used: 2,
          repeat_last: true,
          repeat_remaining: 1,
        }),
      },
      // After the third: ended on that occurrence, done and archived.
      {
        at: '2026-11-07T10:00',
        run: check('task', {
          done: true,
          occurrence_at: iso('2026-11-06T09:00'),
          repeat_count_used: 3,
          completion_count: 3,
        }),
      },
    ],
    expect: {
      task: {
        // Made Mon for Fri (wait 4): the day before.
        '2026-10-22': 'tomorrow',
        '2026-10-23': 'over 1×',
        // Done Fri 21:00 for the next Friday (wait 7): Thursday only.
        '2026-10-29': 'tomorrow',
        '2026-10-30': 'over 1×',
        '2026-11-05': 'tomorrow',
        '2026-11-06': 'over 1×',
        // The third done ended the series.
        '2026-11-07..2026-11-09': 'done',
      },
    },
  },
  {
    id: 're-daily-until-missed-day',
    title:
      'Daily 9 AM through Sat Oct 31, one day missed, the last left: a roll uses one, the debt stays',
    source: 'plan §6 golden 2; A4; 2026-10-22',
    from: '2026-10-26',
    to: '2026-11-04',
    policy: ['tap'],
    queue: {},
    tasks: [
      {
        name: 'task',
        created: '2026-10-26T08:00',
        input: {
          title: 'Synthetic daily, through Oct 31',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          repeat_until: '2026-10-31',
        },
      },
    ],
    events: [
      // Done each evening after the 21:00 read — except Wed Oct 28 and Sat Oct 31.
      { at: '2026-10-26T22:00', run: done('task') },
      { at: '2026-10-27T22:00', run: done('task') },
      // Thu's rollover rolled the missed Wednesday on: a skip, which uses one.
      {
        at: '2026-10-29T07:00',
        run: check('task', {
          occurrence_at: iso('2026-10-29T09:00'),
          skip_count: 1,
          repeat_count_used: 3,
        }),
      },
      { at: '2026-10-29T22:00', run: done('task') },
      { at: '2026-10-30T22:00', run: done('task') },
      // Sunday's rollover: Nov 1 is after the end, so the roll would END the
      // series — it never does (A4). Saturday's occurrence stays, as debt.
      {
        at: '2026-11-01T07:00',
        run: check('task', {
          occurrence_at: iso('2026-10-31T09:00'),
          due_at: iso('2026-10-31T09:00'),
          skip_count: 1,
          repeat_count_used: 5,
          repeat_last: true,
          done: false,
          queued_at: null,
        }),
      },
      // Done at last: the series ends.
      { at: '2026-11-03T22:00', run: done('task') },
      { at: '2026-11-03T22:01', run: check('task', { done: true, repeat_count_used: 6 }) },
    ],
    expect: {
      task: {
        '2026-10-26..2026-10-31': 'over 1×',
        // The last occurrence, never rolled: its attempts climb (a repeat has no 3× offer).
        '2026-11-01': 'over 2×',
        '2026-11-02': 'over 3×',
        '2026-11-03': 'over 4×',
        '2026-11-04': 'done',
      },
    },
  },
  {
    id: 're-deadline-anchored-until',
    title:
      'Deadline Fridays 5 PM, target Thursday 9 AM, through Fri Nov 6: ends after the last deadline',
    source: 'plan §6 golden 3; A5; 2026-10-22',
    from: '2026-10-19',
    to: '2026-11-08',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T10:00',
        input: {
          title: 'Synthetic weekly deadline, through Nov 6',
          rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
          deadline_at: iso('2026-10-23T17:00'),
          target_days_before: 1,
          target_time: '09:00',
          repeat_until: '2026-11-06',
        },
      },
    ],
    events: [
      // Done Thu Oct 29: the next deadline, Fri Nov 6, is ON the last day — in.
      {
        at: '2026-10-30T10:00',
        run: check('task', {
          deadline_at: iso('2026-11-06T17:00'),
          due_at: iso('2026-11-05T09:00'),
          repeat_last: true,
        }),
      },
      // Done Thu Nov 5: Nov 13 is after it — the series ended.
      { at: '2026-11-06T10:00', run: check('task', { done: true, repeat_count_used: 3 }) },
    ],
    expect: {
      task: {
        // Made Mon for Thu's target (wait 3): the day before.
        '2026-10-21': 'tomorrow',
        // Over target on Thursday, done that night (complete-repeating).
        '2026-10-22': 'over 1×',
        // Done Thu 21:00 for the next Thursday (wait 7): Wednesday only.
        '2026-10-28': 'tomorrow',
        '2026-10-29': 'over 1×',
        '2026-11-04': 'tomorrow',
        '2026-11-05': 'over 1×',
        '2026-11-06..2026-11-08': 'done',
      },
    },
  },
  {
    id: 're-from-completion-for-3',
    title: 'Every 10 days after done, 3 times, done late each time: the third done ends it',
    source: 'plan §6 golden 4; A2; 2026-10-22',
    from: '2026-10-19',
    to: '2026-11-15',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T10:00',
        input: {
          title: 'Synthetic every 10 days, three times',
          rrule: 'FREQ=DAILY;INTERVAL=10;BYHOUR=9;BYMINUTE=0',
          recurrence_mode: 'from_completion',
          due_at: iso('2026-10-20T09:00'),
          repeat_count: 3,
        },
      },
    ],
    events: [
      // Two days late: the next is 10 days from the done, at 9 AM — Sun Nov 1.
      { at: '2026-10-22T10:00', run: done('task') },
      {
        at: '2026-10-22T10:01',
        run: check('task', { occurrence_at: iso('2026-11-01T09:00'), repeat_count_used: 1 }),
      },
      // Late again (Tue Nov 3, 8 AM): the next is Fri Nov 13 — the last.
      { at: '2026-11-03T08:00', run: done('task') },
      {
        at: '2026-11-03T08:01',
        run: check('task', {
          occurrence_at: iso('2026-11-13T09:00'),
          repeat_count_used: 2,
          repeat_last: true,
        }),
      },
      // A day late on the last: the series ends.
      { at: '2026-11-14T12:00', run: done('task') },
    ],
    expect: {
      task: {
        // Made Mon for Tue (wait 1): no heads-up.
        '2026-10-20': 'over 1×',
        '2026-10-21': 'over 2×',
        // Done Thu Oct 22 for Sun Nov 1 (wait 10): 3 days before, and the day before.
        '2026-10-29': 'later',
        '2026-10-31': 'tomorrow',
        '2026-11-01': 'over 1×',
        '2026-11-02': 'over 2×',
        // Done Tue Nov 3 for Fri Nov 13 (wait 10).
        '2026-11-10': 'later',
        '2026-11-12': 'tomorrow',
        '2026-11-13': 'over 1×',
        '2026-11-14..2026-11-15': 'done',
      },
    },
  },
]
