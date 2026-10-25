/**
 * UPCOMING'S TWO SECTIONS (2026-10-25; plan `plan-upcoming-split-1024.md`,
 * APPROVED 10-25; docs/TASK-MODEL.md § Upcoming), as day-by-day timelines —
 * written from the rule, not from the simulator's output:
 *
 *  - A = the anchor's day (the picked target — a relative one too — or a
 *    repeat's occurrence target); set day = the day of `target_set_at`;
 *    wait = A − set day; lead = `lead_days` ?? the default table (under 2 → 0,
 *    up to 7 → 1, under 16 → 3, else 4);
 *  - TOMORROW ("tomorrow") on A − 1 only, when the wait is 2+;
 *  - LATER ("later") from max(A − lead, set day + 1), only when that is
 *    ≤ A − 2; carried over day after day until seen (considered on or after
 *    the Later day), at the latest to A − 2;
 *  - seen is per section: seeing a Later row does not silence Tomorrow;
 *  - a move restamps `target_set_at`: a fresh plan.
 * Read at 21:00 local, America/Chicago (Sun Nov 1 2026 is the DST change).
 */
import { updateTask } from '@/core/tasks'
import type { GoldenScenario } from './types'
import { iso, upcoming } from './helpers'

const SUNDAY_NOON = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0'

export const upcomingSectionsScenarios: GoldenScenario[] = [
  {
    id: 'us-lead-override',
    title: 'A lead of 10 on a Sun Nov 1 target (wait 20): Later Thu Oct 22, Tomorrow Sat Oct 31',
    source: 'plan-upcoming-split-1024 § Lead time, § Golden timelines ("a lead override")',
    from: '2026-10-12',
    to: '2026-11-01',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        input: { title: 'Synthetic trip prep', due_at: iso('2026-11-01T09:00'), lead_days: 10 },
      },
    ],
    // Seen in Later on Thu Oct 22 (the policy taps it): quiet until Tomorrow,
    // which the Later stamp does not silence.
    expect: {
      task: {
        ...upcoming({ later: ['2026-10-22'], tomorrow: ['2026-10-31'] }),
        '2026-11-01': 'over 1×',
      },
    },
  },
  {
    id: 'us-lead-override-untapped',
    title: 'The same, never tapped: Later carries over Oct 22 → Oct 30 (A − 2), then Tomorrow',
    source: 'plan-upcoming-split-1024 § The rule (Placement: a Later row carries over until seen)',
    from: '2026-10-12',
    to: '2026-11-01',
    policy: ['never'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        input: { title: 'Synthetic trip prep', due_at: iso('2026-11-01T09:00'), lead_days: 10 },
      },
    ],
    expect: {
      task: {
        '2026-10-22..2026-10-30': 'later',
        '2026-10-31': 'tomorrow',
        '2026-11-01': 'over 1×',
      },
    },
  },
  {
    id: 'us-lead-1-wait-20',
    title: 'A lead of 1 on a wait-20 target: no Later at all, Tomorrow only',
    source: 'plan-upcoming-split-1024 § Golden timelines ("lead 1 on a wait-20 target")',
    from: '2026-10-12',
    to: '2026-11-01',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        // A − 1 = Oct 31 is not ≤ A − 2: no Later. Tomorrow Oct 31 (wait 20).
        input: { title: 'Synthetic quick errand', due_at: iso('2026-11-01T09:00'), lead_days: 1 },
      },
    ],
    expect: { task: { '2026-10-31': 'tomorrow', '2026-11-01': 'over 1×' } },
  },
  {
    id: 'us-relative-one-off-deadline-moves',
    title:
      'A relative one-off (the day before at 9:00) with a lead of 7: the deadline moves, the plan follows',
    source:
      'plan-upcoming-split-1024 § Golden timelines ("a relative one-off whose deadline moves")',
    from: '2026-10-12',
    to: '2026-11-05',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        // Deadline Fri Oct 30 17:00 → target Thu Oct 29 9:00 (wait 17);
        // lead 7 → Later Thu Oct 22 — counted from the TARGET, not the
        // deadline.
        input: {
          title: 'Synthetic filing',
          deadline_at: iso('2026-10-30T17:00'),
          target_days_before: 1,
          target_time: '09:00',
          lead_days: 7,
        },
      },
    ],
    events: [
      {
        // Tue Oct 20, before the Later day: the deadline moves to Fri Nov 6
        // 17:00 → target Thu Nov 5 9:00, `target_set_at` restamped (wait 16).
        // Lead 7 → Later Thu Oct 29; Tomorrow Wed Nov 4. Oct 22 and Oct 28
        // are quiet now.
        at: '2026-10-20T10:00',
        run: (ctx) =>
          void updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { deadline_at: iso('2026-11-06T17:00') },
          }),
      },
    ],
    expect: {
      task: {
        ...upcoming({ later: ['2026-10-29'], tomorrow: ['2026-11-04'] }),
        '2026-11-05': 'over 1×',
      },
    },
  },
  {
    id: 'us-weekly-lead-3',
    title: 'Weekly Sunday noon with a lead of 3 (wait 7): Later Thursday, Tomorrow Saturday',
    source:
      'plan-upcoming-split-1024 § Decks and repeats; § Golden timelines ("a weekly with lead 3")',
    from: '2026-10-11',
    to: '2026-10-25',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        // After its noon occurrence: the first is Sun Oct 18 (wait 7). Each
        // occurrence done on its day (21:00): the next wait is 7 again.
        created: '2026-10-11T13:00',
        input: { title: 'Synthetic weekly post', rrule: SUNDAY_NOON, lead_days: 3 },
      },
    ],
    expect: {
      task: {
        ...upcoming({
          later: ['2026-10-15', '2026-10-22'],
          tomorrow: ['2026-10-17', '2026-10-24'],
        }),
        '2026-10-18': 'over 1×',
        '2026-10-25': 'over 1×',
      },
    },
  },
  {
    id: 'us-moved-after-later-seen',
    title: 'Target Tue Oct 20, seen in Later Sat Oct 17, moved Sun to Fri Oct 30: a fresh plan',
    source:
      'plan-upcoming-split-1024 Q13; § Golden timelines ("a target moved after its Later day was seen")',
    from: '2026-10-12',
    to: '2026-10-30',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        // Wait 8 → Later Sat Oct 17, Tomorrow Mon Oct 19.
        input: { title: 'Synthetic repair call', due_at: iso('2026-10-20T09:00') },
      },
    ],
    events: [
      {
        // Sun Oct 18: moved to Fri Oct 30 (set Oct 18, wait 12 → lead 3):
        // Later Tue Oct 27, Tomorrow Thu Oct 29. Mon Oct 19 is quiet now.
        at: '2026-10-18T10:00',
        run: (ctx) =>
          void updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { due_at: iso('2026-10-30T09:00') },
          }),
      },
    ],
    expect: {
      task: {
        ...upcoming({ later: ['2026-10-17', '2026-10-27'], tomorrow: ['2026-10-29'] }),
        '2026-10-30': 'over 1×',
      },
    },
  },
  {
    id: 'us-override-clamped',
    title: 'A lead of 10 on a wait-4 target: Later clamped to the day after it was set',
    source:
      'plan-upcoming-split-1024 Q6; § Golden timelines ("an override longer than the wait (clamped)")',
    from: '2026-10-12',
    to: '2026-10-16',
    policy: ['never'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        // A = Fri Oct 16; A − 10 is before Tue Oct 13 (set day + 1): Later Tue
        // Oct 13, carried over untapped to Wed Oct 14 (A − 2); Tomorrow Thu.
        input: { title: 'Synthetic gift order', due_at: iso('2026-10-16T09:00'), lead_days: 10 },
      },
    ],
    expect: {
      task: {
        '2026-10-13..2026-10-14': 'later',
        '2026-10-15': 'tomorrow',
        '2026-10-16': 'over 1×',
      },
    },
  },
]
