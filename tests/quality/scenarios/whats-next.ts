/**
 * What's Next recommendation scenarios
 *
 * Tests the What's Next feature which surfaces tasks that are easy to overlook:
 * old lingering tasks, social obligations, routine-only lists,
 * time-sensitive tasks without hard deadlines, and overdue/deadline distinction.
 */

import type { AITestScenario } from '../types'
import { daysAgo, daysAgoAt, weeksAgo, monthsAgo, todayAt, daysFromNowAt } from '../helpers/dates'

const tz = 'America/Chicago'

export const whatsNextScenarios: AITestScenario[] = [
  {
    id: 'whats-next-old-lingering-tasks',
    feature: 'whats_next',
    description: 'Old one-off tasks that have been lingering for weeks should be surfaced',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 10,
          title: 'Schedule oil change',
          priority: 0,
          due_at: daysAgoAt(42, 9, 0, tz),
          original_due_at: daysAgoAt(56, 9, 0, tz),
          created_at: weeksAgo(8),
          labels: ['car'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 11,
          title: 'Return library books',
          priority: 1,
          due_at: daysAgoAt(35, 9, 0, tz),
          original_due_at: daysAgoAt(49, 9, 0, tz),
          created_at: weeksAgo(7),
          labels: ['errand'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 12,
          title: 'Clean out garage',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(10),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        // Filler tasks that should NOT be surfaced
        {
          id: 20,
          title: 'Morning affirmation',
          priority: 0,
          due_at: daysAgoAt(1, 6, 0, tz),
          original_due_at: daysAgoAt(1, 6, 0, tz),
          created_at: monthsAgo(2),
          labels: [],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 21,
          title: 'Buy groceries',
          priority: 0,
          due_at: todayAt(9, 0, tz),
          original_due_at: todayAt(9, 0, tz),
          created_at: daysAgo(0),
          labels: ['shopping'],
          project_name: 'Shopping List',
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 22,
          title: 'URGENT: Fix server outage',
          priority: 4,
          due_at: todayAt(9, 0, tz),
          original_due_at: todayAt(9, 0, tz),
          created_at: daysAgo(0),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        // More filler — recently created tasks
        ...Array.from({ length: 14 }, (_, i) => ({
          id: 30 + i,
          title: `Routine task ${i + 1}`,
          priority: 0,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface the old lingering tasks (IDs 10, 11, 12). ' +
        'ID 10: priority 0 — on the list for ~8 weeks. ' +
        'ID 11: priority 1 — lingering for ~7 weeks. ' +
        'ID 12: no due date — sitting for ~10 weeks. ' +
        'Must NOT surface: daily recurring affirmation (20), shopping (21), or urgent task (22). ' +
        'Reasons should mention how long the task has been on the list (based on created_at). ' +
        'Reasons must NOT reference original_due_at or deferral counts for P0-2 tasks. ' +
        'Summary should reflect the pattern of tasks lingering without resolution.',
    },
  },
  {
    id: 'whats-next-social-obligations',
    feature: 'whats_next',
    description: 'Social obligations should be surfaced',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 42,
          title: 'Call Granddaddy',
          priority: 1,
          due_at: daysAgoAt(21, 9, 0, tz),
          original_due_at: daysAgoAt(42, 9, 0, tz),
          created_at: weeksAgo(6),
          labels: ['family'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 43,
          title: 'Write thank-you card for the Johnsons',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(5),
          labels: ['family'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 44,
          title: 'RSVP to neighborhood cookout',
          priority: 0,
          due_at: daysFromNowAt(4, 9, 0, tz),
          original_due_at: daysFromNowAt(4, 9, 0, tz),
          created_at: weeksAgo(4),
          labels: ['social'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Need to give headcount to Mary by Saturday so she can order food.',
          recurrence_mode: 'from_due' as const,
        },
        // Non-social filler — routine, recently created, low priority
        {
          id: 50,
          title: 'Update spreadsheet',
          priority: 0,
          due_at: daysFromNowAt(3, 9, 0, tz),
          original_due_at: daysFromNowAt(3, 9, 0, tz),
          created_at: daysAgo(1),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 51,
          title: 'Evening walk',
          priority: 0,
          due_at: daysAgoAt(1, 17, 0, tz),
          original_due_at: daysAgoAt(1, 17, 0, tz),
          created_at: monthsAgo(2),
          labels: ['health'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY',
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: 60 + i,
          title: `Work task ${i + 1}`,
          priority: 0,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface social obligations: Call Granddaddy (42), thank-you card (43), RSVP (44). ' +
        'Social/family tasks become awkward if delayed and slip through the cracks. ' +
        'Task 42 (P1) commentary should reference task age (created ~6 weeks ago), not deferral. ' +
        'Task 44 commentary should reference notes (headcount for Mary by Saturday). ' +
        'Should NOT surface the recurring evening walk (51) or obvious work tasks. ' +
        'Reasons should mention the social/relational aspect.',
    },
  },
  {
    id: 'whats-next-all-routine',
    feature: 'whats_next',
    description: 'All daily recurring tasks — should return few or no recommendations',
    input: {
      timezone: 'America/Chicago',
      tasks: Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        title: `Daily affirmation ${i + 1}`,
        priority: 0,
        due_at: daysAgoAt(1, 6, 0, tz),
        original_due_at: daysAgoAt(1, 6, 0, tz),
        created_at: monthsAgo(2),
        labels: [],
        project_name: null,
        is_recurring: true,
        rrule: 'FREQ=DAILY',
        notes: null,
        recurrence_mode: 'from_due' as const,
      })),
    },
    requirements: {
      must_include: {},
      quality_notes:
        "With only recurring daily affirmations, What's Next should return an empty or very small " +
        'task list (0-2 items). These are routine tasks the user already sees in their task list. ' +
        'Surfacing all 10 would be noise. Summary should reflect that nothing needs attention.',
    },
  },
  {
    id: 'whats-next-closing-windows',
    feature: 'whats_next',
    description: 'Time-sensitive tasks without hard deadlines — closing opportunity windows',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 80,
          title: 'Order tulip bulbs for spring planting',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(7),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 81,
          title: 'Book summer camp for the kids before slots fill up',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(6),
          labels: ['family'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        // Regular tasks — recently created
        ...Array.from({ length: 10 }, (_, i) => ({
          id: 90 + i,
          title: `Regular task ${i + 1}`,
          priority: 1,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: ['work'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface the time-sensitive tasks: tulip bulbs (80) and summer camp (81). ' +
        'Both have closing windows — tulips are seasonal, camp slots fill up. ' +
        'The AI should recognize these from the task titles even without hard deadlines. ' +
        'Reasons should mention the time-sensitive nature.',
    },
  },

  // --- New scenarios testing overdue/deadline distinction ---

  {
    id: 'whats-next-high-priority-overdue',
    feature: 'whats_next',
    description:
      'Priority 3 overdue task with real deadline — AI must treat deadline seriously and reference notes',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 200,
          title: 'Pay quarterly estimated taxes',
          priority: 3,
          due_at: daysAgoAt(21, 16, 0, tz),
          original_due_at: daysAgoAt(21, 16, 0, tz),
          created_at: weeksAgo(6),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'IRS penalty for late payment. Form 1040-ES, payment via EFTPS.',
          recurrence_mode: 'from_due' as const,
        },
        // Filler: low priority recent tasks
        ...Array.from({ length: 8 }, (_, i) => ({
          id: 210 + i,
          title: `Routine task ${i + 1}`,
          priority: 0,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface the tax payment task (200). It is priority 3 and overdue — this is a real deadline. ' +
        'The AI must treat this seriously and reference the consequences from notes (IRS penalty). ' +
        'Commentary should NOT focus on "hours overdue" but on the fact that a real deadline has passed ' +
        'with financial consequences. The notes field provides critical context that should be referenced.',
    },
  },
  {
    id: 'whats-next-low-priority-overdue',
    feature: 'whats_next',
    description:
      'Low-priority overdue tasks that were snoozed multiple times — focus on age/deferral, not hours overdue',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 300,
          title: 'Organize photo albums',
          priority: 0,
          due_at: daysAgoAt(21, 14, 0, tz),
          original_due_at: daysAgoAt(56, 9, 0, tz),
          created_at: weeksAgo(8),
          labels: ['home'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 301,
          title: 'Research new internet providers',
          priority: 1,
          due_at: daysAgoAt(21, 9, 0, tz),
          original_due_at: daysAgoAt(28, 9, 0, tz),
          created_at: weeksAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 302,
          title: 'Clean out email inbox',
          priority: 0,
          due_at: daysAgoAt(21, 6, 0, tz),
          original_due_at: daysAgoAt(42, 6, 0, tz),
          created_at: weeksAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        // Filler
        ...Array.from({ length: 6 }, (_, i) => ({
          id: 310 + i,
          title: `Recent task ${i + 1}`,
          priority: 1,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface tasks 300, 301, 302. All are low priority (0-1) and have been on the list for weeks. ' +
        'ID 300: priority 0 — on the list for ~8 weeks. ' +
        'ID 301: priority 1 — on the list for ~7 weeks. ' +
        'ID 302: priority 0 — on the list for ~7 weeks. ' +
        'Commentary MUST focus on task age (how long since created_at), ' +
        'NOT on "X hours overdue" or deferral patterns. ' +
        'The AI does not see original_due_at for P0-2 tasks and must not reference deferral gaps.',
    },
  },
  {
    id: 'whats-next-mixed-priority-overdue',
    feature: 'whats_next',
    description:
      'Mix of priority 3 (real deadline), priority 0 (deferred), and recurring from_completion — different commentary styles',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 400,
          title: 'Submit insurance claim for water damage',
          priority: 3,
          due_at: daysAgoAt(21, 16, 0, tz),
          original_due_at: daysAgoAt(21, 16, 0, tz),
          created_at: weeksAgo(4),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: '7-day filing window from incident date. Claim #WD-9921.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 401,
          title: 'Clean out email inbox',
          priority: 0,
          due_at: daysAgoAt(21, 9, 0, tz),
          original_due_at: daysAgoAt(42, 9, 0, tz),
          created_at: weeksAgo(7),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 402,
          title: 'Water the plants',
          priority: 1,
          due_at: daysAgoAt(21, 9, 0, tz),
          original_due_at: daysAgoAt(21, 9, 0, tz),
          created_at: monthsAgo(2),
          labels: ['home'],
          project_name: null,
          is_recurring: true,
          rrule: 'FREQ=DAILY;INTERVAL=3',
          notes: null,
          recurrence_mode: 'from_completion' as const,
        },
        // Filler
        ...Array.from({ length: 6 }, (_, i) => ({
          id: 410 + i,
          title: `Background task ${i + 1}`,
          priority: 0,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface all three key tasks (400, 401, 402) with DIFFERENT commentary styles: ' +
        'ID 400 (priority 3, insurance claim): Must treat the deadline as real and consequential. ' +
        'Should reference notes (7-day filing window, claim #WD-9921). This is urgent. ' +
        'ID 401 (priority 0, email inbox): Must focus on task age (created ~7 weeks ago, ' +
        'on the list for weeks). NOT "X hours overdue" or deferral patterns — original_due_at is not shown for P0-2. ' +
        'ID 402 (recurring from_completion, water plants): Must recognize that from_completion + overdue ' +
        'means the plants literally need watering — the task waits for completion before advancing. ' +
        'Three different situations requiring three different kinds of commentary.',
    },
  },
  {
    id: 'whats-next-user-context-caregiver',
    feature: 'whats_next',
    description:
      'User context about caregiving should make medical/family tasks get more relevant commentary',
    input: {
      timezone: 'America/Chicago',
      userContext:
        "I'm a caregiver for my elderly father who has diabetes. I also have two kids under 5.",
      tasks: [
        {
          id: 500,
          title: "Refill dad's insulin prescription",
          priority: 2,
          due_at: daysAgoAt(21, 9, 0, tz),
          original_due_at: daysAgoAt(28, 9, 0, tz),
          created_at: weeksAgo(5),
          labels: ['health'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: 'Walgreens on Main St. Rx #4829.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 501,
          title: 'Schedule kid flu shots',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(8),
          labels: ['health'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 502,
          title: 'Call insurance about home claim',
          priority: 0,
          due_at: null,
          original_due_at: null,
          created_at: weeksAgo(6),
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        },
        // Filler
        ...Array.from({ length: 8 }, (_, i) => ({
          id: 510 + i,
          title: `Routine task ${i + 1}`,
          priority: 0,
          due_at: daysFromNowAt(i + 1, 9, 0, tz),
          original_due_at: daysFromNowAt(i + 1, 9, 0, tz),
          created_at: daysAgo(1),
          labels: [],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: null,
          recurrence_mode: 'from_due' as const,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface the insulin prescription (500) and kid flu shots (501). ' +
        "The user context says they're a caregiver for a diabetic father — the insulin refill is especially important. " +
        'Task 500 commentary should be contextually aware (caregiving role makes this more urgent than a generic errand). ' +
        'Task 501 has been sitting for ~8 weeks — easy to overlook with young kids. ' +
        'Task 502 (insurance) is also ~6 weeks old and should likely be surfaced. ' +
        'Commentary should be grounded in task data and user context without hallucinating.',
    },
  },
]
