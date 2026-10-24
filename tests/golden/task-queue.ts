/**
 * THE TASK QUEUE'S ROLLOVER (task-queue PR 2), as day-by-day timelines —
 * written from the design (`task-queue-design.md`: rules 1, 2, 3, 5, the
 * "Picks and defers" section, red-team B1/B3/B5/B7, the build-plan
 * resolutions) and the brief, not from the simulator's output.
 *
 * Every scenario runs with the switch on (`queue`): periods 06:30 / 12:00 /
 * 20:30, so the rollover is 06:30, and morning_time 08:30 (Trent's shape).
 * Read at 21:00, policy `tap` (horizon rows considered the day they show).
 *
 * How to read a line here (see `dayLine`): "queued" = in the task queue
 * (`queued_at`: stripped, or a repeating task waiting); the attempts stay on
 * a queued task with no target (B7: a strip never resets them).
 *
 * THE QUEUE'S PANELS (task-queue PR 3; rules 6–8, resolution 6). A queued
 * task shows in `queue_today` the OpenTask day it was queued and in
 * `queue_previous` after that, and in no horizon segment and not in Upcoming
 * (rule 7). The `tap` policy considers it there. A stripped ONE-OFF then
 * leaves the queue (rule 8): untargeted, back on its horizon's rhythm (unset
 * reads as weeks: the check-in day, Saturday), with no badge — attempts show
 * only while a task has a target or is queued. A waiting REPEATING task
 * stays queued, in "previously targeted" every morning until its occurrence
 * (resolution 6: considered yesterday is previously targeted today).
 *
 * Attempts count OPENTASK days (B7): the day runs 06:30 → 06:30.
 */
import { bulkSnooze } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'
import { expect } from 'vitest'

/** Snooze-all (a defer, `source: 'sweep'`) of one task, as the web clock sends it. */
function sweep(name: string, move: { until?: string; deltaMinutes?: number }) {
  return (ctx: SimContext) => {
    bulkSnooze({
      userId: ctx.userId,
      userTimezone: ctx.timezone,
      taskIds: [ctx.ids[name]],
      ...move,
      source: 'sweep',
    })
  }
}

/** A pick: the same bulk move with no `source` (the row's own clock, the editor). */
function pick(name: string, until: string) {
  return (ctx: SimContext) => {
    bulkSnooze({ userId: ctx.userId, userTimezone: ctx.timezone, taskIds: [ctx.ids[name]], until })
  }
}

/** A check on the stored row at a moment the 21:00 line can't show. */
function check(name: string, fields: Record<string, unknown>) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    for (const [k, v] of Object.entries(fields)) {
      expect((task as unknown as Record<string, unknown>)[k], `${name}.${k}`).toEqual(v)
    }
  }
}

const QUEUE = {}

export const taskQueueScenarios: GoldenScenario[] = [
  {
    id: 'tq-nightly-sweep',
    title: 'A one-off swept at night to tomorrow is stripped at 06:30, its attempt kept',
    source: 'rule 2; B1; B7; "Picks and defers"',
    from: '2026-10-19',
    to: '2026-10-25',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic one-off', due_at: iso('2026-10-19T16:00') },
      },
    ],
    events: [
      // The evening sweep to "tomorrow 8:30": lands on the rollover, marked.
      { at: '2026-10-19T22:00', run: sweep('task', { until: iso('2026-10-20T08:30') }) },
      {
        at: '2026-10-19T22:01',
        run: check('task', { due_at: iso('2026-10-20T06:30'), queue_mark: true }),
      },
      {
        at: '2026-10-20T06:31',
        // The original target is remembered (rule 2), not the 6:30 it was swept to.
        run: check('task', {
          due_at: null,
          queue_mark: false,
          queued_from_due_at: iso('2026-10-19T16:00'),
          attempts: 1,
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        // Stripped: "Stripped today", considered there (the tap), so out of
        // the queue — untargeted, on the weeks rhythm (unset), no badge.
        '2026-10-20': 'queue_today queued 1×',
        '2026-10-21..2026-10-23': 'quiet',
        '2026-10-24': 'weeks',
        '2026-10-25': 'quiet',
      },
    },
  },
  {
    id: 'tq-pick-for-tomorrow',
    title: 'A pick for tomorrow is kept (and nags); left over target, the next rollover strips it',
    source: 'rule 3; "Picks and defers" (a pick is KEPT); rule 2 second clause',
    from: '2026-10-19',
    to: '2026-10-25',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic one-off', due_at: iso('2026-10-19T16:00') },
      },
    ],
    events: [{ at: '2026-10-19T22:00', run: pick('task', iso('2026-10-20T08:30')) }],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'over 2×',
        '2026-10-21': 'queue_today queued 2×',
        '2026-10-22..2026-10-23': 'quiet',
        '2026-10-24': 'weeks',
        '2026-10-25': 'quiet',
      },
    },
  },
  {
    id: 'tq-left-overnight',
    title: 'Targeted yesterday at 4 PM, no sweep: stripped at the rollover',
    source: 'Red-team resolutions, "Confirmed"; rule 2 second clause',
    from: '2026-10-18',
    to: '2026-10-24',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-18T10:00',
        input: { title: 'Synthetic one-off', due_at: iso('2026-10-19T16:00') },
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'queue_today queued 1×',
        '2026-10-21..2026-10-23': 'quiet',
        '2026-10-24': 'weeks',
      },
    },
  },
  {
    id: 'tq-deadline-kept',
    title: 'A deadline task is never stripped: the sweep moves it, the 3× offer stays',
    source: 'rule 3; resolution 3; resolution 1 (deadline keeps its offer)',
    from: '2026-10-19',
    to: '2026-10-24',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: {
          title: 'Synthetic deadline task',
          due_at: iso('2026-10-19T16:00'),
          deadline_at: iso('2026-10-23T17:00'),
        },
      },
    ],
    events: [
      { at: '2026-10-19T22:00', run: sweep('task', { until: iso('2026-10-20T08:30') }) },
      {
        at: '2026-10-20T06:31',
        run: check('task', { due_at: iso('2026-10-20T08:30'), queued_at: null }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'over 2×',
        // "Back to auto" went 2026-10-22 (the deadlines page): Remove target —
        // past the deadline too, which puts it on the page in the safety net.
        '2026-10-21': 'over 3× →remove',
        '2026-10-22': 'over 4× →remove',
        '2026-10-23': 'over 5× →remove',
        '2026-10-24': 'over 6× →remove',
      },
    },
  },
  {
    id: 'tq-high-kept',
    title: 'High is never stripped, and keeps "Remove target?" at 3×',
    source: 'rule 3; resolution 1',
    from: '2026-10-19',
    to: '2026-10-22',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic High', due_at: iso('2026-10-19T16:00'), priority: 3 },
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'over 2×',
        '2026-10-21': 'over 3× →remove',
        '2026-10-22': 'over 4× →remove',
      },
    },
  },
  {
    id: 'tq-daily-rolls',
    title: 'A daily repeating task missed yesterday rolls to today, the miss a skip; it nags',
    source: 'rule 5 (daily); resolution 2',
    from: '2026-10-18',
    to: '2026-10-21',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-18T07:00',
        input: { title: 'Synthetic daily', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0' },
      },
    ],
    events: [
      {
        at: '2026-10-21T07:00',
        run: check('task', {
          due_at: iso('2026-10-21T08:00'),
          occurrence_at: iso('2026-10-21T08:00'),
          skip_count: 3,
          queued_at: null,
        }),
      },
    ],
    // Each roll starts the occurrence's attempts afresh (a skip), so 1× a day.
    expect: { task: { '2026-10-18..2026-10-21': 'over 1×' } },
  },
  {
    id: 'tq-weekly-waits',
    title: 'A weekly task missed Monday waits in the queue, then auto-skips to its day and nags',
    source: 'rule 5 (longer rules, "then auto-skips to it and nags normally"); B3; B4',
    from: '2026-10-19',
    to: '2026-10-28',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic weekly', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0' },
      },
    ],
    events: [
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          due_at: iso('2026-10-26T08:00'),
          occurrence_at: iso('2026-10-19T08:00'),
          queued_from_due_at: iso('2026-10-19T08:00'),
          skip_count: 0,
        }),
      },
      // Its day: auto-skipped to the arrived occurrence (rule 5b), out of the queue.
      {
        at: '2026-10-26T06:31',
        run: check('task', {
          due_at: iso('2026-10-26T08:00'),
          occurrence_at: iso('2026-10-26T08:00'),
          queued_at: null,
          skip_count: 1,
        }),
      },
      {
        at: '2026-10-27T06:31',
        run: check('task', {
          due_at: iso('2026-11-02T08:00'),
          occurrence_at: iso('2026-10-26T08:00'),
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        // Waiting for Mon 26 (B3): "Stripped today" on Tue, then "previously
        // targeted" every morning, considered each day (resolution 6). The
        // queue takes precedence over its Upcoming heads-up on Sun 25 (rule 7).
        '2026-10-20': 'queue_today queued 1×',
        '2026-10-21..2026-10-25': 'queue_previous queued 1×',
        // Its day: the rollover auto-skips it to this occurrence (attempts afresh),
        // out of the queue; it nags from 08:00 like any task.
        '2026-10-26': 'over 1×',
        // Still unhandled at the next rollover: it waits again, for Mon Nov 2.
        '2026-10-27': 'queue_today queued 1×',
        '2026-10-28': 'queue_previous queued 1×',
      },
    },
  },
  {
    id: 'tq-quarterly-waits',
    title: 'A quarterly task missed waits for its next occurrence, three months out',
    source: 'rule 5 (longer rules); B3',
    from: '2026-10-19',
    to: '2026-10-23',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: {
          title: 'Synthetic quarterly',
          rrule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=19;BYHOUR=8;BYMINUTE=0',
        },
      },
    ],
    events: [
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          due_at: iso('2027-01-19T08:00'),
          occurrence_at: iso('2026-10-19T08:00'),
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'queue_today queued 1×',
        '2026-10-21..2026-10-23': 'queue_previous queued 1×',
      },
    },
  },
  {
    id: 'tq-from-completion',
    title: 'Every 3 days from completion: the rollover steps from the missed one, never re-anchors',
    source: 'Red-team edges ("a system skip doesn\'t re-anchor"); brief §2',
    from: '2026-10-19',
    to: '2026-10-25',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: {
          title: 'Synthetic from completion',
          rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=8;BYMINUTE=0',
          recurrence_mode: 'from_completion',
        },
      },
    ],
    events: [
      // Mon 08:00 + 3 days = Thu 08:00 (not Tue + 3 = Fri).
      { at: '2026-10-20T06:31', run: check('task', { due_at: iso('2026-10-22T08:00') }) },
      // Thu, its day: auto-skipped to Thu 08:00 (the occurrence moves, no re-anchor).
      {
        at: '2026-10-22T06:31',
        run: check('task', { occurrence_at: iso('2026-10-22T08:00'), queued_at: null }),
      },
      // Fri, still unhandled: waits for Thu + 3 = Sun 08:00 (the grid, not now + 3).
      { at: '2026-10-23T06:31', run: check('task', { due_at: iso('2026-10-25T08:00') }) },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'queue_today queued 1×',
        '2026-10-21': 'queue_previous queued 1×',
        '2026-10-22': 'over 1×',
        '2026-10-23': 'queue_today queued 1×',
        // Set Fri for Sun (wait 2): a heads-up the day before.
        '2026-10-24': 'queue_previous queued 1×',
        '2026-10-25': 'over 1×',
      },
    },
  },
  {
    id: 'tq-missed-run',
    title: 'A missed rollover caught up at 07:10 runs as of 06:30: a 06:45 sweep is not stripped',
    source: 'Red-team "missed run"; edges (catch-up as of the rollover moment)',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['tap'],
    queue: { late: { '2026-10-20': '07:10' } },
    tasks: [
      {
        name: 'swept',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic swept at 6:45', due_at: iso('2026-10-19T16:00') },
      },
      {
        name: 'left',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic left over', due_at: iso('2026-10-19T16:00') },
      },
    ],
    events: [
      // 06:45, after the rollover moment but before the late run: a Snooze-all
      // to 07:45 (the default hour), within the OpenTask day — a plain move.
      { at: '2026-10-20T06:45', run: sweep('swept', { until: iso('2026-10-20T07:45') }) },
      {
        at: '2026-10-20T07:11',
        run: check('swept', { due_at: iso('2026-10-20T07:45'), queued_at: null }),
      },
      { at: '2026-10-20T07:11', run: check('left', { due_at: null }) },
    ],
    expect: {
      swept: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'over 2×',
        '2026-10-21': 'queue_today queued 2×',
      },
      left: {
        '2026-10-19': 'over 1×',
        '2026-10-20': 'queue_today queued 1×',
        // Considered in the queue on Tue: out of it, untargeted.
        '2026-10-21': 'quiet',
      },
    },
  },
  {
    id: 'tq-spring-forward',
    title: 'A 02:30 first period on the spring-forward night rolls at the next valid minute, 03:00',
    source: 'Red-team edges (DST: a nonexistent first period rolls at the next valid minute)',
    from: '2027-03-12',
    to: '2027-03-15',
    policy: ['tap'],
    queue: { periods: ['02:30', '12:00'], dayStart: '02:30' },
    tasks: [
      {
        name: 'task',
        created: '2027-03-12T09:00',
        input: { title: 'Synthetic one-off', due_at: iso('2027-03-13T16:00') },
      },
    ],
    events: [
      { at: '2027-03-14T01:59', run: check('task', { due_at: iso('2027-03-13T16:00') }) },
      { at: '2027-03-14T03:01', run: check('task', { due_at: null, attempts: 1 }) },
    ],
    expect: {
      task: {
        '2027-03-13': 'over 1×',
        // Untargeted on Sunday, its weeks segment (Saturday) came round after it was made.
        '2027-03-14': 'queue_today queued 1×',
        '2027-03-15': 'quiet',
      },
    },
  },
  {
    id: 'tq-no-periods',
    title: 'Day start unset, no periods: the rollover is the 3:00 AM default, not morning_time',
    source: 'rule 1; "Day starts at" default 3:00 AM (Trent, 2026-10-24)',
    from: '2026-10-19',
    to: '2026-10-20',
    policy: ['tap'],
    queue: { periods: [], morning: '08:30', dayStart: null },
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic one-off', due_at: iso('2026-10-19T16:00') },
      },
    ],
    events: [
      { at: '2026-10-20T02:59', run: check('task', { due_at: iso('2026-10-19T16:00') }) },
      { at: '2026-10-20T03:01', run: check('task', { due_at: null }) },
    ],
    expect: { task: { '2026-10-19': 'over 1×', '2026-10-20': 'queue_today queued 1×' } },
  },
  {
    id: 'tq-night-owl',
    title: "A night owl's 1 AM pick of 2 AM is the evening's attempt, stripped at 06:30",
    source:
      'Red-team resolutions ("The OpenTask day runs from rollover to rollover"); B7; ' +
      'designer ruling 10-19 (a pick made after midnight stays with the evening)',
    from: '2026-10-20',
    to: '2026-10-20',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-20T01:00',
        input: { title: 'Synthetic late one', due_at: iso('2026-10-20T02:00') },
      },
    ],
    events: [
      {
        at: '2026-10-20T03:00',
        run: check('task', { attempts: 1, attempts_counted_through: '2026-10-19' }),
      },
      { at: '2026-10-20T06:31', run: check('task', { due_at: null, attempts: 1 }) },
    ],
    expect: { task: { '2026-10-20': 'queue_today queued 1×' } },
  },
  {
    id: 'tq-evening-pick-early-morning',
    title: 'At 20:00, "tomorrow 6:00": kept at 06:30 (it nags), stripped the next morning',
    source: 'designer ruling 10-19 (an early-morning pick is spared at its first rollover)',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T20:00',
        input: { title: 'Synthetic early one', due_at: iso('2026-10-20T06:00') },
      },
    ],
    events: [
      // Over target from 06:00 — 1× at once, counted for Tuesday, not Monday.
      {
        at: '2026-10-20T06:10',
        run: check('task', { attempts: 1, attempts_counted_through: '2026-10-20' }),
      },
      {
        at: '2026-10-20T06:31',
        run: check('task', { due_at: iso('2026-10-20T06:00'), queued_at: null, attempts: 1 }),
      },
      {
        at: '2026-10-21T06:31',
        run: check('task', { due_at: null, queued_from_due_at: iso('2026-10-20T06:00') }),
      },
    ],
    expect: {
      task: {
        // Made Monday for Tuesday 6:00 (wait 1): no heads-up.
        '2026-10-19': 'quiet',
        // An early-morning pick belongs to Tuesday: one attempt, from 06:00.
        '2026-10-20': 'over 1×',
        // Still over at the next rollover: stripped, the one attempt kept.
        '2026-10-21': 'queue_today queued 1×',
      },
    },
  },
]
