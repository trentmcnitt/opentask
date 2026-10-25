/**
 * THE DEADLINES PAGE (2026-10-22), as day-by-day timelines — written from the
 * plan (`plan-deadlines-page-1022.md` §1–§5, §10, the APPROVED rulings and the
 * nag-map rulings), not from the simulator's output.
 *
 * Every scenario runs with the task queue on (`queue`): periods 06:30 / 12:00
 * / 20:30 (the rollover is 06:30) and morning_time 08:30, read at 21:00. The
 * rules the lines follow:
 *  - a deadline task with NO target is never over target. Its lead day
 *    (`lead_from`) = the deadline's OpenTask day D minus the lead
 *    (`deadlineLeadDays(wait)`: wait < 2 → 0, ≤ 7 → 1, < 16 → 3, else 4;
 *    a one-off's wait counts from the day it is written, a repeat's is its
 *    rule's smallest gap), clamped to [today, D−1];
 *  - before the lead day: quiet — never in Upcoming, a future deck's row
 *    included (RULE 3 of the Upcoming split, 2026-10-25; until then
 *    heads-ups counted to the lead day). A deadline-anchored repeat WITH a
 *    relative target has a real target: Upcoming as any target
 *    (`dl-relative-target`);
 *  - from the lead day: "deadlines" (the page); "seen" once considered this
 *    OpenTask day — the considered state;
 *  - from D−1 on, past the deadline too: "deadlines net" — the safety net;
 *    seeing it does not silence it ("deadlines net seen" still waits);
 *  - a deck day outside the safety net: the On deck section ("deck"); the
 *    page from its lead day otherwise; at the rollover an expired deck on a
 *    deadline task is cleared, never queued.
 * How to read a line: see `dayLine` in src/core/sim/day-simulator.ts.
 */
import { expect } from 'vitest'
import { markDone, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks } from '@/core/tasks/deck'
import { considerTasks, deferLeads, getTaskSegments } from '@/core/tasks/task-segments'
import { migrateDeadlineLeads } from '@/core/db/migrate-deadline-leads'
import { getDb } from '@/core/db'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'

const QUEUE = {}

function consider(name: string) {
  return (ctx: SimContext) => {
    considerTasks(ctx.userId, [ctx.ids[name]])
  }
}

/** A Defer of the lead day: moved, or refused with `reason`. */
function defer(name: string, day: string, reason?: string) {
  return (ctx: SimContext) => {
    const r = deferLeads(ctx.userId, ctx.timezone, [ctx.ids[name]], day)
    if (reason) {
      expect(
        r.refused.map((x) => x.reason),
        `${name} defer ${day}`,
      ).toEqual([reason])
      expect(r.deferred).toBe(0)
    } else {
      expect(r.deferred, `${name} defer ${day}`).toBe(1)
    }
  }
}

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

/** The task's row on the page right now: its state and flags. */
function onPage(name: string, row: { state: string; safetyNet: boolean; seen: boolean }) {
  return (ctx: SimContext) => {
    const page = getTaskSegments(ctx.userId, ctx.timezone, new Date(), {
      queuePanels: true,
      deckRows: true,
      deadlineRows: true,
    }).find((s) => s.horizon === 'deadlines')
    const r = page?.tasks.find((t) => t.task.id === ctx.ids[name])
    expect(r && { state: r.state, safetyNet: r.safetyNet, seen: r.seen }, name).toEqual(row)
  }
}

const FRI_30 = { title: 'Synthetic deadline task', deadline_at: iso('2026-10-30T23:59') }

export const deadlinesScenarios: GoldenScenario[] = [
  {
    id: 'dl-one-off',
    title:
      'Deadline Fri Oct 30, made Tue Oct 20 (wait 10, lead 3): heads-up, page, defer, safety net, target',
    source: 'plan §10.1; §1, §3, §4; A3, A7',
    from: '2026-10-20',
    to: '2026-10-30',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-20T09:00', input: FRI_30 }],
    events: [
      { at: '2026-10-20T09:01', run: check('task', { due_at: null, lead_from: '2026-10-27' }) },
      // Tue Oct 27, its lead day: on the page; seen → considered.
      { at: '2026-10-27T10:00', run: consider('task') },
      {
        at: '2026-10-27T10:01',
        run: onPage('task', { state: 'considered', safetyNet: false, seen: true }),
      },
      // Defer Tue → Wed (≤ D−2 = Wed): off the page today, back Wed.
      { at: '2026-10-27T12:00', run: defer('task', '2026-10-28') },
      { at: '2026-10-27T12:01', run: check('task', { lead_from: '2026-10-28' }) },
      // Wed: Thu is D−1, the safety net — the menu has no later day.
      { at: '2026-10-28T10:00', run: defer('task', '2026-10-29', 'after_safety_net') },
      // Thu Oct 29 (D−1): the safety net; seeing it does not silence it, and
      // Defer is refused.
      { at: '2026-10-29T10:00', run: consider('task') },
      {
        at: '2026-10-29T10:01',
        run: onPage('task', { state: 'waiting', safetyNet: true, seen: true }),
      },
      { at: '2026-10-29T10:02', run: defer('task', '2026-10-30', 'safety_net') },
      // Targeted for 3 PM: off the page, over target at 3 PM.
      {
        at: '2026-10-29T11:00',
        run: (ctx) =>
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { due_at: iso('2026-10-29T15:00') },
          }),
      },
    ],
    expect: {
      task: {
        // Quiet before its lead day Tue Oct 27 (rule 3: no heads-up).
        '2026-10-28': 'deadlines',
        '2026-10-29': 'over 1×',
        '2026-10-30': 'over 2×',
      },
    },
  },
  {
    id: 'dl-deck',
    title:
      'The same, on deck Wed Oct 28: no deck Upcoming row (rule 3), page, On deck, cleared (never queued), net',
    source: 'plan §10.2; §4, §5 (rule 7); A8',
    from: '2026-10-20',
    to: '2026-10-31',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-20T09:00', input: FRI_30 }],
    events: [
      {
        at: '2026-10-20T10:00',
        run: (ctx) => {
          deckTasks({
            userId: ctx.userId,
            timezone: ctx.timezone,
            ids: [ctx.ids.task],
            day: '2026-10-28',
          })
        },
      },
      {
        at: '2026-10-29T06:31',
        run: check('task', { on_deck_day: null, queued_at: null, due_at: null }),
      },
    ],
    expect: {
      task: {
        // Rule 3, strict (2026-10-25): no Upcoming row for the deck of a
        // target-less deadline task — quiet until its lead day.
        '2026-10-27': 'deadlines',
        '2026-10-28': 'deck',
        '2026-10-29..2026-10-31': 'deadlines net',
      },
    },
  },
  {
    id: 'dl-weekly',
    title: 'A deadline-anchored weekly with no relative target, Sat 08:00 (wait 7, lead 1 → Fri)',
    source: 'plan §10.3; L1, L2',
    from: '2026-10-19',
    to: '2026-10-31',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'weekly',
        created: '2026-10-19T09:00',
        input: {
          title: 'Synthetic weekly deadline',
          rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
          deadline_at: iso('2026-10-24T08:00'),
        },
      },
    ],
    events: [
      {
        at: '2026-10-19T09:01',
        run: check('weekly', {
          due_at: null,
          target_days_before: null,
          target_time: null,
          lead_from: '2026-10-23',
        }),
      },
      { at: '2026-10-24T10:00', run: done('weekly') },
      {
        at: '2026-10-24T10:01',
        run: check('weekly', {
          due_at: null,
          deadline_at: iso('2026-10-31T08:00'),
          lead_from: '2026-10-30',
        }),
      },
    ],
    expect: {
      // Quiet before each lead day (rule 3).
      weekly: {
        '2026-10-23': 'deadlines net',
        '2026-10-30..2026-10-31': 'deadlines net',
      },
    },
  },
  {
    id: 'dl-monthly-defer',
    title: 'A monthly (lead 4): this instance deferred from D−4 to D−2; the next is back at D−4',
    source: 'plan §10.3 (per-instance); §1 "Deferred"',
    from: '2026-11-10',
    to: '2026-12-12',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'monthly',
        created: '2026-11-10T09:00',
        input: {
          title: 'Synthetic monthly deadline',
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=18;BYMINUTE=0',
          deadline_at: iso('2026-11-15T18:00'),
        },
      },
    ],
    events: [
      { at: '2026-11-10T09:01', run: check('monthly', { lead_from: '2026-11-11' }) },
      { at: '2026-11-11T10:00', run: defer('monthly', '2026-11-13') },
      { at: '2026-11-15T19:00', run: done('monthly') },
      { at: '2026-11-15T19:01', run: check('monthly', { lead_from: '2026-12-11' }) },
    ],
    expect: {
      monthly: {
        // Deferred at 10:00 to the 13th: quiet until then (rule 3).
        '2026-11-13': 'deadlines',
        '2026-11-14': 'deadlines net',
        // Done at 19:00 on the 15th: the next occurrence, lead Dec 11; quiet
        // until it.
        '2026-12-11..2026-12-12': 'deadlines',
      },
    },
  },
  {
    id: 'dl-relative-target',
    title: 'A deadline-anchored repeat WITH a relative target (Fri 18:00): never on the page',
    source: 'plan §10.4; ruling 2',
    from: '2026-10-19',
    to: '2026-10-30',
    policy: ['complete-repeating'],
    queue: QUEUE,
    tasks: [
      {
        name: 'store',
        created: '2026-10-19T09:00',
        input: {
          title: 'Synthetic store run',
          rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=12;BYMINUTE=0',
          deadline_at: iso('2026-10-24T12:00'),
          target_days_before: 1,
          target_time: '18:00',
        },
      },
    ],
    expect: {
      // A real target (Fri 18:00) each occurrence: Tomorrow the day before
      // (made Mon, wait 4; then done Fri for the next Fri, wait 7 — lead 1, no
      // Later).
      store: {
        '2026-10-22': 'tomorrow',
        '2026-10-23': 'over 1×',
        '2026-10-29': 'tomorrow',
        '2026-10-30': 'over 1×',
      },
    },
  },
  {
    id: 'dl-repeat-ends',
    title: 'Repeat ends: a target-less weekly with a count of 2 — the last done ends it',
    source: 'plan §10.5; § Repeat ends',
    from: '2026-10-19',
    to: '2026-11-01',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'twice',
        created: '2026-10-19T09:00',
        input: {
          title: 'Synthetic weekly deadline, twice',
          rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
          deadline_at: iso('2026-10-24T08:00'),
          repeat_count: 2,
        },
      },
    ],
    events: [
      { at: '2026-10-24T10:00', run: done('twice') },
      { at: '2026-10-31T10:00', run: done('twice') },
    ],
    expect: {
      // Quiet before each lead day (rule 3).
      twice: {
        '2026-10-23': 'deadlines net',
        '2026-10-30': 'deadlines net',
        '2026-10-31..2026-11-01': 'done',
      },
    },
  },
  {
    id: 'dl-dst',
    title: 'DST: a deadline Sun Nov 8 00:30 (before the rollover → D = Sat Nov 7) across Nov 1',
    source: 'plan §10.6; L9',
    from: '2026-10-26',
    to: '2026-11-08',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-26T09:00',
        input: { title: 'Synthetic early deadline', deadline_at: iso('2026-11-08T00:30') },
      },
    ],
    events: [{ at: '2026-10-26T09:01', run: check('task', { lead_from: '2026-11-04' }) }],
    expect: {
      task: {
        // wait 12 (Oct 26 → Nov 7) → lead 3 → Nov 4; quiet until then (rule 3).
        '2026-11-04..2026-11-05': 'deadlines',
        '2026-11-06..2026-11-08': 'deadlines net',
      },
    },
  },
  {
    id: 'dl-past-deadline',
    title: 'Past deadline, no target: stays on the page in the safety net; seen never silences',
    source: 'plan §10.7; A8; nag-map ruling 3',
    from: '2026-10-19',
    to: '2026-10-23',
    policy: ['tap'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        input: { title: 'Synthetic close deadline', deadline_at: iso('2026-10-20T17:00') },
      },
    ],
    events: [
      { at: '2026-10-19T09:01', run: check('task', { lead_from: '2026-10-19' }) },
      { at: '2026-10-21T10:00', run: consider('task') },
    ],
    expect: {
      task: {
        '2026-10-19..2026-10-20': 'deadlines net',
        '2026-10-21': 'deadlines net seen',
        '2026-10-22..2026-10-23': 'deadlines net',
      },
    },
  },
  {
    id: 'dl-migration',
    title: 'Migration: a one-off on its automatic target lands on the page on its old auto day',
    source: 'plan §10.8; §6',
    from: '2026-10-19',
    to: '2026-10-30',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: FRI_30 }],
    events: [
      // The shape before this build: the automatic target (wait 11 → 3 days
      // before, at the morning), no lead day.
      {
        at: '2026-10-19T09:05',
        run: (ctx) => {
          const at = iso('2026-10-27T08:30')
          getDb()
            .prepare(
              `UPDATE tasks SET due_at = ?, original_due_at = ?, target_auto = 1, lead_from = NULL
                WHERE id = ?`,
            )
            .run(at, at, ctx.ids.task)
        },
      },
      { at: '2026-10-20T09:00', run: () => migrateDeadlineLeads(getDb(), new Date()) },
      {
        at: '2026-10-20T09:01',
        run: check('task', {
          due_at: null,
          original_due_at: null,
          target_auto: false,
          lead_from: '2026-10-27',
        }),
      },
    ],
    expect: {
      task: {
        // Quiet until its lead day Oct 27 (rule 3).
        '2026-10-27..2026-10-28': 'deadlines',
        '2026-10-29..2026-10-30': 'deadlines net',
      },
    },
  },
]
