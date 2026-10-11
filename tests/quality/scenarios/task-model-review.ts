/**
 * Task model scenarios for the review features (2026-10-10)
 *
 * Insights and What's Next now see three time fields per task: `target:` (the
 * old due date — soft, snoozable), `deadline:` (the real cutoff) and
 * `horizon:` (pace). The rule that changed: a near DEADLINE is act-soon at any
 * priority, a far one is not act-soon at any priority, and being past a target
 * is never a consequence on its own. Tasks with no deadline field keep the old
 * P3+ notes rule (older tasks hold their deadlines in notes).
 */

import type { AITestScenario } from '../types'
import { daysAgo, daysAgoAt, weeksAgo, daysFromNowAt } from '../helpers/dates'

const tz = 'America/Chicago'

const base = {
  labels: [] as string[],
  project_name: null,
  is_recurring: false,
  rrule: null,
  recurrence_mode: 'from_due' as const,
}

export const taskModelReviewScenarios: AITestScenario[] = [
  {
    id: 'insights-deadline-field',
    feature: 'insights',
    description:
      'act_soon follows the deadline field: near deadline at P0 earns it, far deadline at P3 does not, past target alone never does',
    input: {
      timezone: tz,
      tasks: [
        {
          ...base,
          id: 201,
          title: 'Use the restaurant voucher',
          priority: 0,
          due_at: null,
          original_due_at: null,
          deadline_at: daysFromNowAt(2, 23, 59, tz),
          created_at: weeksAgo(2),
          notes: null,
        },
        {
          ...base,
          id: 202,
          title: 'Book flights for the family reunion',
          priority: 3,
          due_at: daysFromNowAt(1, 9, 0, tz),
          original_due_at: daysFromNowAt(1, 9, 0, tz),
          deadline_at: daysFromNowAt(45, 23, 59, tz),
          created_at: daysAgo(6),
          notes: 'Fares go up closer to the date',
        },
        {
          ...base,
          id: 203,
          title: 'Call the dentist to reschedule',
          priority: 1,
          due_at: daysAgoAt(4, 9, 0, tz),
          original_due_at: daysAgoAt(4, 9, 0, tz),
          created_at: daysAgo(9),
          notes: null,
        },
        {
          ...base,
          id: 204,
          title: 'Return the jacket to the store',
          priority: 2,
          due_at: null,
          original_due_at: null,
          deadline_at: daysAgoAt(1, 23, 59, tz),
          created_at: weeksAgo(3),
          notes: 'Receipt is in the glovebox',
        },
        {
          ...base,
          id: 205,
          title: 'Repaint the fence',
          priority: 0,
          due_at: null,
          original_due_at: null,
          horizon: 'months' as const,
          created_at: daysAgo(12),
          notes: null,
        },
        {
          ...base,
          id: 206,
          title: 'Submit the conference talk proposal',
          priority: 2,
          due_at: daysFromNowAt(10, 9, 0, tz),
          original_due_at: daysFromNowAt(10, 9, 0, tz),
          deadline_at: daysFromNowAt(4, 17, 0, tz),
          created_at: daysAgo(5),
          notes: null,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'ID 201 (P0, no target of its own, deadline in 2 days — the model sees an implied "(from deadline)" target 2 days ago): MEDIUM-HIGH (45-90) with act_soon — the voucher expires soon; the deadline field earns act_soon at P0, and being past a "(from deadline)" target must NOT be scored as routine P0-3 overdue. ' +
        'ID 202 (P3, target tomorrow, deadline ~6 weeks out): LOW (0-35), NO act_soon — a near target is not a near deadline. ' +
        'ID 203 (P1, 4 days past its target, no deadline): LOW-MEDIUM (10-45), NO act_soon — past a target is not a consequence. ' +
        'ID 204 (P2, deadline passed yesterday): HIGH-ish (50-95), act_soon expected — the return window just closed, commentary should say so (maybe still returnable, check). ' +
        'ID 205 (P0, horizon months, 12 days old): LOW (0-30), no signals — the user chose a slow pace; not stale (under 21 days). ' +
        'ID 206 (P2, own target in 10 days but deadline in 4 days — the model sees the implied "(from deadline)" target, today): MEDIUM-HIGH (40-85), act_soon — the deadline is what matters; commentary should be about the deadline. ' +
        'Commentary must not invent deadlines for tasks without one (203, 205).',
      insights_expectations: {
        score_ranges: {
          202: { min: 0, max: 40 },
          205: { min: 0, max: 30 },
        },
        signal_checks: {
          201: { must_have: ['act_soon'] },
          202: { must_not_have: ['act_soon'] },
          203: { must_not_have: ['act_soon', 'stale'] },
          205: { must_not_have: ['act_soon', 'stale'] },
          206: { must_have: ['act_soon'] },
        },
      },
    },
  },
  {
    id: 'whats-next-deadline-before-target',
    feature: 'whats_next',
    description:
      'A low-priority task whose deadline is close but whose target is far out should be surfaced',
    input: {
      timezone: tz,
      tasks: [
        {
          ...base,
          id: 301,
          title: 'Renew the library card',
          priority: 0,
          due_at: daysFromNowAt(12, 9, 0, tz),
          original_due_at: daysFromNowAt(12, 9, 0, tz),
          deadline_at: daysFromNowAt(3, 23, 59, tz),
          created_at: daysAgo(8),
          notes: 'Card expires — holds get cancelled after that',
        },
        {
          ...base,
          id: 302,
          title: 'Organize the garage shelves',
          priority: 0,
          due_at: null,
          original_due_at: null,
          horizon: 'months' as const,
          created_at: daysAgo(5),
          notes: null,
        },
        {
          ...base,
          id: 303,
          title: 'Pick up printer paper',
          priority: 1,
          due_at: daysAgoAt(1, 9, 0, tz),
          original_due_at: daysAgoAt(1, 9, 0, tz),
          created_at: daysAgo(2),
          notes: null,
        },
        {
          ...base,
          id: 304,
          title: 'Plan the anniversary dinner',
          priority: 2,
          due_at: daysFromNowAt(2, 18, 0, tz),
          original_due_at: daysFromNowAt(2, 18, 0, tz),
          deadline_at: daysFromNowAt(30, 23, 59, tz),
          created_at: daysAgo(3),
          notes: null,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'ID 301 MUST be surfaced: its deadline is ~3 days away even though its own target is ~12 days out and it is P0 (the model sees the implied "(from deadline)" target instead). ' +
        'The reason should mention the deadline/expiry. ' +
        'ID 302 (horizon months, young) should not be surfaced as urgent. ' +
        'ID 304 must not be described as having an imminent deadline (its deadline is a month out). ' +
        'No reason may invent a deadline for 302 or 303.',
    },
  },
]
