/**
 * RELATIVE TARGETS (2026-10-24; docs/TASK-MODEL.md § Relative targets; plan
 * `plan-relative-targets-1024.md` §8 "Golden"), as a day-by-day timeline —
 * written from the rules, not from the simulator's output:
 *
 *  - a one-off's relative target is DERIVED from its deadline — local days
 *    before, at a time — and, linked to a period, the time is the period's
 *    start; it is a picked target: quiet until its Upcoming heads-ups, which
 *    count from `target_set_at` to the target (the day before when the wait is
 *    2..7; 3 or 4 days before as well when it is longer);
 *  - a deadline move re-derives it and restamps `target_set_at` (the wait
 *    starts again); a period retime moves it but does NOT restamp (decision
 *    11), so the heads-up days stay;
 *  - once the target arrives it is over target (attempts 1× that day).
 * Read at 21:00 local, America/Chicago (Sun Nov 1 2026 is the DST change).
 */
import { expect } from 'vitest'
import { updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { listTimeSlots } from '@/core/time-slots'
import { updateTimeSlot } from '@/core/time-slots/edit'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'

function evening(ctx: SimContext) {
  return listTimeSlots(ctx.userId).find((s) => s.label === 'Evening')!
}

function check(name: string, fields: Record<string, unknown>) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    for (const [k, v] of Object.entries(fields)) {
      expect((task as unknown as Record<string, unknown>)[k], `${name}.${k}`).toEqual(v)
    }
  }
}

export const relativeTargetScenarios: GoldenScenario[] = [
  {
    id: 'rt-g1-evening-before',
    title:
      'RT G1 — the day before at Evening: follows a deadline move (restamped) and a retime (not)',
    source: 'plan-relative-targets-1024 §8 Golden; 2026-10-24',
    from: '2026-10-26',
    to: '2026-11-04',
    policy: ['never', 'tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-26T10:00',
        input: {
          title: 'Synthetic filing',
          deadline_at: iso('2026-11-03T08:30'),
          target_days_before: 1,
          target_time: '20:30',
        },
        // Linked to the user's Evening period (20:30): the time is its start.
        after: (id, ctx) => {
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: id,
            input: { target_slot_id: evening(ctx).id },
          })
        },
      },
    ],
    events: [
      // Wait 7 (Mon Oct 26 → Mon Nov 2): the day before only, Sun Nov 1.
      {
        at: '2026-10-26T10:01',
        run: (ctx) =>
          check('task', {
            due_at: iso('2026-11-02T20:30'),
            target_time: '20:30',
            target_slot_id: evening(ctx).id,
            target_auto: false,
          })(ctx),
      },
      // Thu Oct 29: the deadline moves to Thu Nov 5 — the target follows to
      // Wed Nov 4 20:30, and the wait starts again (Oct 29 → Nov 4 = 6): the
      // only heads-up is now Tue Nov 3. Sun Nov 1 is quiet.
      {
        at: '2026-10-29T10:00',
        run: (ctx) => {
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { deadline_at: iso('2026-11-05T08:30') },
          })
        },
      },
      {
        at: '2026-10-29T10:01',
        run: check('task', {
          due_at: iso('2026-11-04T20:30'),
          target_set_at: iso('2026-10-29T10:00'),
        }),
      },
      // Fri Oct 30: Evening is retimed to 21:00. The target follows to
      // 9:00 PM; `target_set_at` is NOT restamped, so the heads-up days stay.
      {
        at: '2026-10-30T10:00',
        run: (ctx) => {
          updateTimeSlot({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            slotId: evening(ctx).id,
            input: { start_time: '21:00' },
          })
        },
      },
      {
        at: '2026-10-30T10:01',
        run: check('task', {
          due_at: iso('2026-11-04T21:00'),
          target_time: '21:00',
          target_set_at: iso('2026-10-29T10:00'),
        }),
      },
      // Not over target before 9 PM on Wed Nov 4.
      {
        at: '2026-11-04T20:45',
        run: (ctx) => {
          expect(getCurrentlyDueTaskIds(ctx.userId)).not.toContain(ctx.ids.task)
        },
      },
    ],
    expect: {
      task: {
        '2026-11-03': 'tomorrow',
        '2026-11-04': 'over 1×',
      },
    },
  },
]
