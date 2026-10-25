/**
 * A repeating occurrence moved EARLIER and done fires once (10-12 edge-case
 * analysis, finding 3a). Before phase A, the next occurrence was computed
 * from the target: a weekly Sunday moved to Saturday and done Saturday got
 * next = after(Sat) = the next day, Sunday — the same week's occurrence, a
 * second time. Phase A keeps the scheduled `occurrence_at` apart from the
 * target, and the next occurrence is after(max(occurrence, completed)), so
 * the moved one is the week's only one.
 *
 * Expected lines from docs/TASK-MODEL.md § Upcoming (a heads-up the day
 * before at a wait of 2+, and one 3 days out past a wait of 7, counted from
 * `target_set_at` — the move, or the completion).
 */
import { markDone } from '@/core/tasks/mark-done'
import { updateTask } from '@/core/tasks'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso, upcoming } from './helpers'

function moveTarget(ctx: SimContext, local: string): void {
  updateTask({
    userId: ctx.userId,
    userTimezone: ctx.timezone,
    taskId: ctx.ids.task,
    input: { due_at: iso(local) },
  })
}

export const moveEarlierScenarios: GoldenScenario[] = [
  {
    id: 'me-weekly-sunday-moved-to-saturday',
    title: 'Weekly Sun 9 AM moved to Sat, done Sat → next is the FOLLOWING Sunday, nothing Sun',
    source: '10-12 edge-case analysis 3a (move earlier double-fire)',
    from: '2026-10-12',
    to: '2026-10-25',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T08:00',
        input: {
          title: 'Synthetic weekly Sunday',
          rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
        },
      },
    ],
    // Thu Oct 15 10:00: the Oct 18 occurrence's target moved to Sat Oct 17.
    events: [{ at: '2026-10-15T10:00', run: (ctx) => moveTarget(ctx, '2026-10-17T09:00') }],
    expect: {
      task: {
        // Wait Thu → Sat is 2: Tomorrow on Friday. Over Saturday; done that
        // night by the policy.
        '2026-10-16': 'tomorrow',
        '2026-10-17': 'over 1×',
        // Sun Oct 18 is quiet: the moved occurrence WAS the week's. The next
        // is Oct 25 — wait 8 from the Saturday completion: Later Thu,
        // Tomorrow Sat.
        ...upcoming({ later: ['2026-10-22'], tomorrow: ['2026-10-24'] }),
        '2026-10-25': 'over 1×',
      },
    },
  },
  {
    id: 'me-daily-moved-earlier-same-day',
    title: 'Daily 8 PM moved to 2 PM, done 3 PM → no second fire at 8 PM; next is tomorrow',
    source: '10-12 edge-case analysis 3a (move earlier double-fire), daily',
    from: '2026-10-12',
    to: '2026-10-15',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T08:00',
        input: { title: 'Synthetic daily', rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0' },
      },
    ],
    events: [
      { at: '2026-10-13T10:00', run: (ctx) => moveTarget(ctx, '2026-10-13T14:00') },
      {
        at: '2026-10-13T15:00',
        run: (ctx) =>
          void markDone({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids.task }),
      },
    ],
    // Daily: wait 1, never a heads-up. Tue's 8 PM read finds it quiet — the
    // 2 PM one was Tuesday's occurrence — where the old rule had it over again.
    expect: {
      task: {
        '2026-10-12': 'over 1×',
        '2026-10-14': 'over 1×',
        '2026-10-15': 'over 1×',
      },
    },
  },
]
