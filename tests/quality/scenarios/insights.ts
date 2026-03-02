/**
 * AI Insights scenarios
 *
 * Tests the Insights feature which scores every task 0-100 based on how much
 * it needs human attention, adds one-line commentary, and assigns 0-2 signals
 * from a preset vocabulary (review, stale, act_soon, quick_win, vague, misprioritized).
 *
 * The scoring philosophy is inverse of task priority:
 * - P4 due today scores LOW (already visible, user will handle it)
 * - Old P0 with no due date scores HIGH (forgotten, needs a decision)
 *
 * All dates are generated relative to "now" using helper functions, so
 * scenarios are time-agnostic and will produce consistent results regardless
 * of when the test suite runs.
 *
 * See docs/AI.md § "Testing Philosophy" for why realism and coverage matter.
 */

import type { AITestScenario } from '../types'
import { daysAgo, daysAgoAt, weeksAgo, monthsAgo, daysFromNowAt } from '../helpers/dates'

const tz = 'America/Chicago'

export const insightsScenarios: AITestScenario[] = [
  {
    id: 'insights-mixed-priorities',
    feature: 'insights',
    description:
      'Mix of P0-4 with varying ages — old forgotten tasks should score high, visible recent tasks should score low',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 1,
          title: 'Fix the leaky bathroom faucet',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(3),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 2,
          title: 'Renew car registration',
          priority: 3,
          due_at: daysAgoAt(1, 16, 0, tz),
          original_due_at: daysAgoAt(1, 16, 0, tz),
          created_at: daysAgo(10),
          labels: ['car'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Already expired. Late fee applies.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 3,
          title: 'Buy birthday present for Mom',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(8),
          labels: ['family'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Birthday is in a few days',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 4,
          title: 'URGENT: Fix production database issue',
          priority: 4,
          due_at: daysAgoAt(3, 9, 0, tz),
          original_due_at: daysAgoAt(3, 9, 0, tz),
          created_at: daysAgoAt(3, 8, 0, tz),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 5,
          title: 'Morning vitamins',
          priority: 0,
          due_at: daysAgoAt(3, 7, 0, tz),
          original_due_at: daysAgoAt(3, 7, 0, tz),
          created_at: weeksAgo(6),
          labels: ['health'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 6,
          title: 'Look into refinancing the house',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(4),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 7,
          title: 'Pick up dry cleaning',
          priority: 2,
          due_at: daysAgoAt(2, 12, 0, tz),
          original_due_at: daysAgoAt(2, 12, 0, tz),
          created_at: daysAgo(4),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Scoring should reflect attention-needed, not task priority. ' +
        'ID 6 (refinancing, ~4 months old, no due date, P0): should score HIGH (70+) — forgotten for months. ' +
        'ID 1 (faucet, ~3 months old, no due date, P0): should score HIGH (70+) — sitting for months. ' +
        'ID 4 (P4 urgent, due ~3 days ago): should score LOW (0-29) — already visible and urgent, user sees it. ' +
        'ID 5 (daily vitamins, recurring): should score LOW (0-35) — routine, but ~3 days behind. ' +
        'ID 7 (dry cleaning, P2, ~2 days overdue): should score LOW (0-35) — routine errand slightly past reminder. ' +
        'ID 2 (car registration, P3, due ~1 day ago): should score MEDIUM — has a real deadline with consequences. ' +
        'ID 3 (birthday present, birthday in a few days): should score MEDIUM — time-sensitive but not urgent yet. ' +
        'IDs 1 and 6 should get "stale" signal. ID 4 should get NO signals. ' +
        'Commentary should be grounded — no fabricated details beyond what the task data shows.',
      insights_expectations: {
        score_ranges: {
          1: { min: 70, max: 100 },
          4: { min: 0, max: 20 },
          // P0 daily recurring, ~3 days overdue — routine but noticeably behind
          5: { min: 0, max: 42 },
          6: { min: 70, max: 100 },
          7: { min: 0, max: 35 },
        },
        signal_checks: {
          1: { must_have: ['stale'] },
          4: {
            must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'misprioritized', 'review'],
          },
          6: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-stale-detection',
    feature: 'insights',
    description:
      'Tasks created months ago with no activity — should score high and get stale signal',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 10,
          title: 'Organize the garage',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(5),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 11,
          title: 'Research new laptop',
          priority: 1,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(4),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 12,
          title: 'Update resume',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(6),
          labels: ['career'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 13,
          title: 'Cancel unused gym membership',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(5),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 14,
          title: 'Buy groceries',
          priority: 1,
          due_at: daysFromNowAt(1, 12, 0, tz),
          original_due_at: daysFromNowAt(1, 12, 0, tz),
          created_at: daysAgo(1),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'All of IDs 10-13 should score HIGH (70+) and receive "stale" signal — created 4-6 months ago with no due date. ' +
        'ID 12 (resume, ~6 months old): oldest, should score highest. ' +
        'ID 13 (gym membership): wasting money, should also get "act_soon" or "quick_win" signal — cancelling is easy and saves money. ' +
        'ID 14 (groceries, created ~1 day ago, due tomorrow): should score LOW (0-29) — recent, straightforward, on track. ' +
        'Commentary should mention how long each task has been sitting (e.g., "on the list for months"). ' +
        'Commentary must NOT fabricate reasons for why the task was delayed.',
      insights_expectations: {
        score_ranges: {
          10: { min: 70, max: 100 },
          11: { min: 65, max: 100 },
          12: { min: 70, max: 100 },
          13: { min: 65, max: 100 },
          14: { min: 0, max: 35 },
        },
        signal_checks: {
          10: { must_have: ['stale'] },
          11: { must_have: ['stale'] },
          12: { must_have: ['stale'] },
          13: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-well-organized',
    feature: 'insights',
    description: 'Clean, well-organized tasks — should score low with no signals',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 20,
          title: 'Team standup',
          priority: 2,
          due_at: daysAgoAt(1, 9, 0, tz),
          original_due_at: daysAgoAt(1, 9, 0, tz),
          created_at: monthsAgo(2),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 21,
          title: 'Pay rent',
          priority: 3,
          due_at: daysFromNowAt(0, 10, 0, tz),
          original_due_at: daysFromNowAt(0, 10, 0, tz),
          created_at: monthsAgo(1),
          labels: ['finance'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 22,
          title: 'Submit weekly report',
          priority: 2,
          due_at: daysAgoAt(2, 16, 0, tz),
          original_due_at: daysAgoAt(2, 16, 0, tz),
          created_at: weeksAgo(8),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=FR',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 23,
          title: 'Review Q1 marketing plan',
          priority: 2,
          due_at: daysFromNowAt(3, 16, 0, tz),
          original_due_at: daysFromNowAt(3, 16, 0, tz),
          created_at: weeksAgo(1),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: false,
          rrule: null,
          notes: 'Draft shared by Sarah last week. Need to review and provide feedback.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 24,
          title: 'Water indoor plants',
          priority: 0,
          due_at: daysAgoAt(1, 8, 0, tz),
          original_due_at: daysAgoAt(1, 8, 0, tz),
          created_at: monthsAgo(2),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=TH',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'All tasks should score LOW (0-39). These are well-organized with clear due dates, proper priorities, ' +
        'and recurring schedules running smoothly. No signals should be assigned (or at most one "review" on ID 23). ' +
        'ID 20 (standup, recurring weekday): LOW — routine, on track. ' +
        'ID 21 (rent, recurring monthly): LOW — clear, has a date, nothing forgotten. ' +
        'ID 22 (weekly report): LOW — routine recurring task. ' +
        'ID 23 (Q1 review, one-off, due in ~3 days): LOW — recent, clear notes, on track. ' +
        'ID 24 (water plants, recurring weekly): LOW — routine. ' +
        'Commentary should be brief and positive (e.g., "On track", "Routine task running smoothly").',
      insights_expectations: {
        score_ranges: {
          20: { min: 0, max: 39 },
          21: { min: 0, max: 39 },
          22: { min: 0, max: 39 },
          23: { min: 0, max: 39 },
          24: { min: 0, max: 65 },
        },
        min_zero_signal_pct: 60,
      },
    },
  },
  {
    id: 'insights-signal-variety',
    feature: 'insights',
    description:
      'Tasks designed to trigger each of the 6 signal types — verify the full signal vocabulary works',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 30,
          title: 'Sort through old clothes in the closet',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(5),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 31,
          title: 'RSVP to company holiday party',
          priority: 3,
          due_at: daysFromNowAt(3, 16, 0, tz),
          original_due_at: daysFromNowAt(3, 16, 0, tz),
          created_at: daysAgo(10),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'RSVP deadline is in a few days. Need headcount for catering.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 32,
          title: 'Unsubscribe from old mailing lists',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: daysAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 33,
          title: 'Thing',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 34,
          title: 'Clean the entire house top to bottom including attic and basement',
          priority: 4,
          due_at: daysFromNowAt(3, 16, 0, tz),
          original_due_at: daysFromNowAt(3, 16, 0, tz),
          created_at: daysAgo(4),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 35,
          title: 'Schedule dentist appointment',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(4),
          labels: ['health'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Last checkup was over a year ago',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 36,
          title: 'File taxes',
          priority: 1,
          due_at: daysFromNowAt(45, 16, 0, tz),
          original_due_at: daysFromNowAt(45, 16, 0, tz),
          created_at: weeksAgo(6),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'This scenario is designed to trigger multiple signal types. Expected signals: ' +
        'ID 30 (old clothes, ~5 months old): "stale" — sitting for months. ' +
        'ID 31 (RSVP, P3, deadline in ~3 days): "act_soon" — P3 deadline approaching, time-sensitive. ' +
        'ID 32 (unsubscribe): "quick_win" — small task, easy to knock out. ' +
        'ID 33 ("Thing", no details): "vague" — completely unclear what this task requires. ' +
        'ID 34 (whole house P4, moderate scope): "misprioritized" — P4/Urgent for a house cleaning task is probably wrong. ' +
        'ID 35 (dentist, ~4 months old, notes about overdue checkup): "review" and/or "stale" — needs a closer look, sitting for months. ' +
        'ID 36 (taxes, P1, due in ~45 days): this is LOW priority right now — well organized, plenty of time. ' +
        'At least 4 of the 6 signal types should appear across the batch. ' +
        'Commentary should explain WHY each signal applies, not just repeat the signal name.',
      insights_expectations: {
        score_ranges: {
          30: { min: 70, max: 100 },
          34: { min: 0, max: 25 },
          35: { min: 65, max: 100 },
          36: { min: 0, max: 39 },
        },
        signal_checks: {
          30: { must_have: ['stale'] },
          32: { must_not_have: ['stale', 'act_soon'] },
          33: { must_have: ['vague'] },
          34: { must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'review'] },
          35: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-recurring-overdue',
    feature: 'insights',
    description:
      'Recurring tasks overdue by varying amounts — tests that short overdue is LOW, long overdue is HIGH',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 40,
          title: 'Morning vitamins',
          priority: 0,
          due_at: daysAgoAt(3, 8, 0, tz),
          original_due_at: daysAgoAt(3, 8, 0, tz),
          created_at: monthsAgo(2),
          labels: ['health'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 41,
          title: 'Water the plants',
          priority: 0,
          due_at: daysAgoAt(5, 8, 0, tz),
          original_due_at: daysAgoAt(5, 8, 0, tz),
          created_at: monthsAgo(2),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=TH',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 42,
          title: 'Weekly meal prep',
          priority: 1,
          due_at: weeksAgo(5),
          original_due_at: weeksAgo(5),
          created_at: monthsAgo(3),
          labels: ['health'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=SU',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 43,
          title: 'Monthly budget review',
          priority: 2,
          due_at: monthsAgo(3),
          original_due_at: monthsAgo(3),
          created_at: monthsAgo(6),
          labels: ['finance'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 44,
          title: 'Clean desk',
          priority: 0,
          due_at: daysAgoAt(4, 10, 0, tz),
          original_due_at: daysAgoAt(4, 10, 0, tz),
          created_at: monthsAgo(2),
          labels: [],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=FR',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests recurring task overdue scoring with absolute days (no cycle math). ' +
        'In OpenTask, P0-2 tasks rarely stay overdue >2 days because the global snooze catches them. ' +
        'ID 40 (daily vitamins, ~3 days overdue): LOW (0-25) — routine low-consequence daily, slightly overdue. ' +
        'ID 41 (weekly plants, ~5 days overdue): LOW-MEDIUM (0-40) — moderately overdue, but task is routine. ' +
        'ID 42 (weekly meal prep, ~5 weeks overdue): MEDIUM-HIGH (40-80) — very overdue, approaching stale. Should get "stale" or "review" signal. ' +
        'ID 43 (monthly budget, ~3 months overdue): HIGH (70+) — deeply overdue and stale. Should get "stale" signal. ' +
        'ID 44 (weekly desk, ~4 days overdue): LOW-MEDIUM (0-40) — slightly overdue, task is routine. ' +
        'Key: scoring uses absolute overdue days, not cycle math. Shorter overdue on routine tasks = LOW, longer overdue = progressively higher.',
      insights_expectations: {
        score_ranges: {
          40: { min: 0, max: 75 },
          41: { min: 0, max: 70 },
          42: { min: 40, max: 90 },
          43: { min: 70, max: 100 },
          44: { min: 0, max: 40 },
        },
        signal_checks: {
          43: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-p0p2-overdue',
    feature: 'insights',
    description:
      'P0-P2 tasks overdue by varying amounts — tests "reminder not deadline" philosophy',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 50,
          title: 'Pick up dry cleaning',
          priority: 2,
          due_at: daysAgoAt(3, 12, 0, tz),
          original_due_at: daysAgoAt(3, 12, 0, tz),
          created_at: daysAgo(5),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 51,
          title: 'Order new shelf brackets',
          priority: 1,
          due_at: weeksAgo(3),
          original_due_at: weeksAgo(3),
          created_at: weeksAgo(4),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 52,
          title: 'Return library books',
          priority: 0,
          due_at: weeksAgo(6),
          original_due_at: weeksAgo(6),
          created_at: weeksAgo(7),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'They charge $0.25/day late fee',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 53,
          title: 'Schedule annual physical',
          priority: 0,
          due_at: daysAgoAt(45, 10, 0, tz),
          original_due_at: daysAgoAt(45, 10, 0, tz),
          created_at: monthsAgo(3),
          labels: ['health'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 54,
          title: 'Check tire pressure',
          priority: 2,
          due_at: daysAgoAt(3, 10, 0, tz),
          original_due_at: daysAgoAt(3, 10, 0, tz),
          created_at: daysAgo(5),
          labels: ['car'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests P0-2 overdue guidance — due dates are reminders, not deadlines. ' +
        'ID 50 (P2, ~3 days overdue, ~5 days old): LOW (0-40) — routine errand past reminder, low-consequence. ' +
        'ID 51 (P1, ~3 weeks overdue, ~4 weeks old): LOW-MEDIUM (10-40) — mundane task, drifting but low priority. Should NOT get act_soon (P0-2 never get act_soon). ' +
        'ID 52 (P0, ~6 weeks overdue, notes about $0.25/day late fees): MEDIUM-HIGH (40-90) — has been sitting for weeks, notes mention accumulating consequences. Commentary should reference the late fee. May get "stale" signal. ' +
        'ID 53 (P0, ~6.5 weeks overdue, ~3 months old): HIGH (60-90) — old task, well past reminder, drifting. Should get "stale" or "review" signal. ' +
        'ID 54 (P2, ~3 days overdue, ~5 days old): LOW (0-35) — recent task, slightly past reminder. ' +
        'The key test: P0-2 overdue by a few days should score LOW (reminders), ' +
        'while P0-2 overdue by 3+ weeks should score progressively higher (forgotten/drifting). ' +
        'act_soon should NEVER appear on P0-2 tasks.',
      insights_expectations: {
        score_ranges: {
          50: { min: 0, max: 40 },
          52: { min: 40, max: 90 },
          53: { min: 60, max: 90 },
          // P2 recent task, ~3 days past reminder — consistently scores 28-34
          54: { min: 0, max: 35 },
        },
        signal_checks: {
          50: { must_not_have: ['act_soon'] },
          51: { must_not_have: ['act_soon'] },
          52: { must_not_have: ['act_soon'] },
          53: { must_not_have: ['act_soon'] },
          54: { must_not_have: ['act_soon'] },
        },
      },
    },
  },
  {
    id: 'insights-from-completion',
    feature: 'insights',
    description:
      'Tasks with from_completion recurrence mode — tests detection of genuinely stuck recurring tasks',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 60,
          title: 'Clean the bathroom',
          priority: 0,
          due_at: weeksAgo(4),
          original_due_at: weeksAgo(4),
          created_at: monthsAgo(3),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          notes: null,
          recurrence_mode: 'from_completion' as const,
        },
        {
          id: 61,
          title: 'Review and file receipts',
          priority: 0,
          due_at: daysAgoAt(45, 10, 0, tz),
          original_due_at: daysAgoAt(45, 10, 0, tz),
          created_at: monthsAgo(4),
          labels: ['finance'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          notes: null,
          recurrence_mode: 'from_completion' as const,
        },
        {
          id: 62,
          title: 'Backup phone photos',
          priority: 0,
          due_at: weeksAgo(3),
          original_due_at: weeksAgo(3),
          created_at: monthsAgo(2),
          labels: [],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=SU',
          notes: null,
          recurrence_mode: 'from_completion' as const,
        },
        {
          id: 63,
          title: 'Mow the lawn',
          priority: 1,
          due_at: weeksAgo(3),
          original_due_at: weeksAgo(3),
          created_at: monthsAgo(5),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests recurring tasks overdue by varying amounts. Scoring uses absolute days overdue, not cycle math. ' +
        "In OpenTask, P0-2 tasks are rarely overdue >2 days because the global snooze catches them — longer overdue means the user hasn't been engaging. " +
        'ID 60 (weekly bathroom, ~4 weeks overdue): MEDIUM (30-60) — significantly overdue, user has not been engaging with this task. ' +
        'ID 61 (monthly receipts, ~6.5 weeks overdue): HIGH (55-90) — deeply overdue, task has been neglected. Should get "stale" signal. ' +
        'ID 62 (weekly backup, ~3 weeks overdue): LOW-MEDIUM (0-40) — moderately overdue but task is routine. ' +
        'ID 63 (biweekly lawn, ~3 weeks overdue, ~5 months old): LOW (0-40) — moderately overdue, but the task is months old so a "review" or "stale" signal is acceptable. ' +
        'No distinction between from_due and from_completion for scoring.',
      insights_expectations: {
        score_ranges: {
          60: { min: 30, max: 90 },
          61: { min: 55, max: 90 },
          62: { min: 0, max: 40 },
        },
        signal_checks: {
          61: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-consequences',
    feature: 'insights',
    description: 'P3 tasks with varying consequence urgency — tests nuanced scoring of deadlines',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 70,
          title: 'File insurance claim',
          priority: 3,
          due_at: daysAgoAt(3, 16, 0, tz),
          original_due_at: daysAgoAt(3, 16, 0, tz),
          created_at: weeksAgo(6),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: '30-day filing window from incident. Deadline is in ~2 days.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 71,
          title: 'Submit expense report',
          priority: 3,
          due_at: daysAgoAt(2, 16, 0, tz),
          original_due_at: daysAgoAt(2, 16, 0, tz),
          created_at: weeksAgo(4),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Reimbursement deadline is end of Q1 (about 7 weeks away)',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 72,
          title: 'RSVP to wedding',
          priority: 3,
          due_at: daysAgoAt(4, 16, 0, tz),
          original_due_at: daysAgoAt(4, 16, 0, tz),
          created_at: weeksAgo(7),
          labels: ['social'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'RSVP deadline already passed — they may finalize headcount without us',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 73,
          title: 'Renew passport',
          priority: 3,
          due_at: daysAgoAt(2, 10, 0, tz),
          original_due_at: daysAgoAt(2, 10, 0, tz),
          created_at: weeksAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Trip is in about 4 months. Processing takes 6-8 weeks.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 74,
          title: 'Review contractor bids',
          priority: 3,
          due_at: daysFromNowAt(3, 16, 0, tz),
          original_due_at: daysFromNowAt(3, 16, 0, tz),
          created_at: weeksAgo(4),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Three bids received. Told them I would decide by end of month.',
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests nuanced P3 scoring based on consequence timing in notes. ' +
        'ID 70 (insurance claim, filing deadline ~2 days away): HIGH (60-95) — filing window closing very soon, real consequence. Should get "act_soon" signal. ' +
        'ID 71 (expense report, actual deadline ~7 weeks away): LOW-MEDIUM (15-75) — user set a reminder, task is overdue, but actual deadline is far out. act_soon is questionable since deadline is weeks away. ' +
        'ID 72 (wedding RSVP, deadline already passed): HIGH (65-100) — social consequence is active, RSVP window has closed. Should get "act_soon" signal. ' +
        'ID 73 (passport, trip ~4 months out, processing 6-8 weeks): MEDIUM (30-85) — has time but processing takes weeks. The AI may flag this high because 6-8 weeks + buffer still feels actionable. ' +
        'ID 74 (contractor bids, due in ~3 days, decision by end of month): LOW-MEDIUM (15-40) — not due yet, plenty of time. ' +
        'Commentary should reference specific consequences from notes (filing window, RSVP date, processing time). ' +
        'The key test: consequences that have passed or are imminent score HIGH, consequences weeks away score lower.',
      insights_expectations: {
        score_ranges: {
          70: { min: 60, max: 95 },
          71: { min: 15, max: 75 },
          72: { min: 65, max: 100 },
          74: { min: 10, max: 40 },
        },
        signal_checks: {
          70: { must_have: ['act_soon'] },
          72: { must_have: ['act_soon'] },
        },
      },
    },
  },
  {
    id: 'insights-signal-restraint',
    feature: 'insights',
    description: 'Mix of 10 routine tasks — tests that 60-70% get NO signals',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 80,
          title: 'Team standup',
          priority: 2,
          due_at: daysAgoAt(1, 9, 0, tz),
          original_due_at: daysAgoAt(1, 9, 0, tz),
          created_at: monthsAgo(2),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 81,
          title: 'Buy cat food',
          priority: 1,
          due_at: daysAgoAt(1, 12, 0, tz),
          original_due_at: daysAgoAt(1, 12, 0, tz),
          created_at: daysAgo(3),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 82,
          title: 'Read chapter 5 of Clean Code',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(4),
          labels: ['learning'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 83,
          title: 'Submit timesheet',
          priority: 2,
          due_at: daysAgoAt(2, 16, 0, tz),
          original_due_at: daysAgoAt(2, 16, 0, tz),
          created_at: weeksAgo(8),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=FR',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 84,
          title: 'Sort bookshelf in office',
          priority: 1,
          due_at: daysAgoAt(1, 10, 0, tz),
          original_due_at: daysAgoAt(1, 10, 0, tz),
          created_at: daysAgo(5),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 85,
          title: 'Pay electric bill',
          priority: 3,
          due_at: daysFromNowAt(3, 16, 0, tz),
          original_due_at: daysFromNowAt(3, 16, 0, tz),
          created_at: weeksAgo(4),
          labels: ['finance'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 86,
          title: 'Walk the dog',
          priority: 0,
          due_at: daysAgoAt(1, 7, 0, tz),
          original_due_at: daysAgoAt(1, 7, 0, tz),
          created_at: monthsAgo(2),
          labels: ['pet'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 87,
          title: 'Pick up prescription',
          priority: 2,
          due_at: daysAgoAt(1, 10, 0, tz),
          original_due_at: daysAgoAt(1, 10, 0, tz),
          created_at: daysAgo(3),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 88,
          title: 'Update project status slides',
          priority: 2,
          due_at: daysAgoAt(2, 16, 0, tz),
          original_due_at: daysAgoAt(2, 16, 0, tz),
          created_at: daysAgo(5),
          labels: ['work'],
          project_name: 'Work',
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 89,
          title: 'Water garden',
          priority: 0,
          due_at: daysAgoAt(1, 8, 0, tz),
          original_due_at: daysAgoAt(1, 8, 0, tz),
          created_at: monthsAgo(2),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=WEEKLY;BYDAY=TH',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests signal restraint — these are mostly routine, well-managed tasks. ' +
        'At least 6 of 10 tasks (60%) should have ZERO signals. ' +
        'No task should have more than 1 signal. ' +
        'Recurring tasks and tasks due in the future should score LOW (0-29). ' +
        'Tasks 1-2 days overdue may score LOW-to-MEDIUM (15-45). ' +
        'No task should receive act_soon or stale — nothing here is urgent or forgotten. ' +
        'ID 82 (book, P0, no due date, ~4 weeks old) is the strongest candidate for a signal (review). At most 1-2 other tasks may get a mild signal (quick_win or review). ' +
        'Commentary should be brief and matter-of-fact for routine tasks.',
      insights_expectations: {
        signal_checks: {
          80: { must_not_have: ['act_soon', 'stale'] },
          81: { must_not_have: ['act_soon', 'stale'] },
          83: { must_not_have: ['act_soon', 'stale'] },
          85: { must_not_have: ['act_soon', 'stale'] },
          86: { must_not_have: ['act_soon', 'stale'] },
          89: { must_not_have: ['act_soon', 'stale'] },
        },
        min_zero_signal_pct: 60,
      },
    },
  },
  {
    id: 'insights-boundary-stale',
    feature: 'insights',
    description:
      'Tasks at various ages — tests the staleness boundary (under 2 weeks, 2-3 weeks, 3+ weeks)',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 90,
          title: 'Look into standing desk options',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: daysAgo(10),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 91,
          title: 'Research tax-advantaged accounts',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: daysAgo(17),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 92,
          title: 'Find a new barber',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: daysAgo(21),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 93,
          title: 'Call about home warranty',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(8),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 94,
          title: 'Reorganize the pantry',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: monthsAgo(4),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 95,
          title: 'Donate old electronics',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(10),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests staleness boundaries. All tasks are P0, no due date, no notes. ' +
        'ID 90 (~10 days old): LOW (0-30) — too new to be stale, no signal. ' +
        'ID 91 (~17 days old): LOW-MEDIUM (15-40) — borderline, possibly a gentle "review" but not "stale" yet. ' +
        'ID 92 (~21 days old, 3 weeks): MEDIUM (40-65) — at the stale boundary. Should get "stale" signal. ' +
        'ID 93 (~8 weeks old): HIGH (65-85) — clearly stale. Must get "stale" signal. ' +
        'ID 94 (~4 months old): HIGH (75-90) — very stale. Must get "stale" signal. ' +
        'ID 95 (~10 weeks old): HIGH (70-85) — stale. Must get "stale" signal. ' +
        'Scores should increase monotonically with age. ' +
        'The key test: tasks under 2 weeks should NOT get "stale", tasks at 3+ weeks SHOULD.',
      insights_expectations: {
        score_ranges: {
          90: { min: 0, max: 60 },
          93: { min: 65, max: 92 },
          94: { min: 75, max: 95 },
          95: { min: 65, max: 90 },
        },
        signal_checks: {
          90: { must_not_have: ['stale'] },
          92: { must_have: ['stale'] },
          93: { must_have: ['stale'] },
          94: { must_have: ['stale'] },
          95: { must_have: ['stale'] },
        },
      },
    },
  },
  {
    id: 'insights-user-context-job-hunting',
    feature: 'insights',
    description:
      'User context about job hunting — career/networking tasks should get contextually appropriate commentary',
    input: {
      timezone: 'America/Chicago',
      userContext:
        "I'm actively job hunting. Networking is critical — every connection counts. I have interviews lined up for next week.",
      tasks: [
        {
          id: 100,
          title: 'Follow up with recruiter at Acme Corp',
          priority: 2,
          due_at: daysAgoAt(4, 10, 0, tz),
          original_due_at: daysAgoAt(4, 10, 0, tz),
          created_at: weeksAgo(4),
          labels: ['career'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Met at tech meetup recently. Said to email by end of week.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 101,
          title: 'Update LinkedIn profile',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(7),
          labels: ['career'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 102,
          title: 'Clean the kitchen',
          priority: 0,
          due_at: daysAgoAt(1, 10, 0, tz),
          original_due_at: daysAgoAt(1, 10, 0, tz),
          created_at: daysAgo(3),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 103,
          title: 'Morning vitamins',
          priority: 0,
          due_at: daysAgoAt(5, 8, 0, tz),
          original_due_at: daysAgoAt(5, 8, 0, tz),
          created_at: monthsAgo(2),
          labels: ['health'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 104,
          title: 'Send thank-you note to interviewer',
          priority: 1,
          due_at: daysAgoAt(5, 16, 0, tz),
          original_due_at: daysAgoAt(5, 16, 0, tz),
          created_at: daysAgo(6),
          labels: ['career'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Interview was last week. Should follow up within 48 hours.',
          recurrence_mode: 'from_due' as const,
        },
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Tests that user context about job hunting elevates career/networking tasks. ' +
        'ID 100 (recruiter follow-up, P2, overdue ~4 days): should score MEDIUM-HIGH (40-80) — ' +
        'the user context about job hunting makes this more consequential than a generic P2 errand. ' +
        'Commentary should reflect the networking importance. ' +
        'ID 101 (LinkedIn, P0, no due date, ~7 weeks old): should score HIGH (60-90) — stale + ' +
        'extremely relevant given active job search. Should get "stale" signal. ' +
        'ID 102 (kitchen, P0, recent): LOW (0-30) — routine, recent, not career-related. ' +
        'ID 103 (vitamins, daily recurring, ~5 days overdue): LOW (0-35) — routine daily, low-consequence but noticeably behind. ' +
        'ID 104 (thank-you note, P1, overdue ~5 days): should score MEDIUM-HIGH (40-80) — ' +
        'social obligation + job hunting context. Notes mention 48-hour window which has passed. ' +
        'Commentary should be grounded — use task data and user context together.',
      insights_expectations: {
        score_ranges: {
          100: { min: 40, max: 80 },
          // P0 routine household task, ~1 day past reminder — AI reasonably scores slightly above 25
          102: { min: 0, max: 30 },
          // P0 daily recurring, ~5 days overdue — same pattern as mixed-priorities task 5
          103: { min: 0, max: 35 },
          104: { min: 40, max: 95 },
        },
        signal_checks: {
          101: { must_have: ['stale'] },
        },
      },
    },
  },
]
