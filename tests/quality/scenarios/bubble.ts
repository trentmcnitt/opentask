/**
 * Bubble recommendation scenarios
 *
 * Tests the Bubble feature which surfaces tasks that are easy to overlook:
 * old lingering tasks, social obligations, routine-only lists,
 * time-sensitive tasks without hard deadlines, and overdue/deadline distinction.
 */

import type { AITestScenario } from '../types'

export const bubbleScenarios: AITestScenario[] = [
  {
    id: 'bubble-old-lingering-tasks',
    feature: 'bubble',
    description: 'Old one-off tasks that have been lingering for weeks should be surfaced',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 10,
          title: 'Schedule oil change',
          priority: 0,
          due_at: '2026-01-20T15:00:00Z',
          original_due_at: '2026-01-10T15:00:00Z',
          created_at: '2026-01-05T16:00:00Z',
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
          due_at: '2026-01-25T15:00:00Z',
          original_due_at: '2026-01-15T15:00:00Z',
          created_at: '2026-01-12T16:00:00Z',
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
          created_at: '2025-12-20T16:00:00Z',
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
          due_at: '2026-02-09T12:00:00Z',
          original_due_at: '2026-02-09T12:00:00Z',
          created_at: '2026-01-01T12:00:00Z',
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
          due_at: '2026-02-09T15:00:00Z',
          original_due_at: '2026-02-09T15:00:00Z',
          created_at: '2026-02-09T12:00:00Z',
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
          due_at: '2026-02-09T15:00:00Z',
          original_due_at: '2026-02-09T15:00:00Z',
          created_at: '2026-02-09T14:00:00Z',
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
          due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
        'ID 10: created Jan 5, priority 0 — on the list for 5+ weeks. ' +
        'ID 11: created Jan 12, priority 1 — lingering for nearly 4 weeks. ' +
        'ID 12: created in December with no due date — sitting for 7+ weeks. ' +
        'Must NOT surface: daily recurring affirmation (20), shopping (21), or urgent task (22). ' +
        'Reasons should mention how long the task has been on the list (based on created_at). ' +
        'Reasons must NOT reference original_due_at or deferral counts for P0-2 tasks. ' +
        'Summary should reflect the pattern of tasks lingering without resolution.',
    },
  },
  {
    id: 'bubble-social-obligations',
    feature: 'bubble',
    description: 'Social obligations should be surfaced',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 42,
          title: 'Call Granddaddy',
          priority: 1,
          due_at: '2026-02-08T15:00:00Z',
          original_due_at: '2026-01-20T15:00:00Z',
          created_at: '2026-01-18T16:00:00Z',
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
          created_at: '2026-01-25T16:00:00Z',
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
          due_at: '2026-02-15T15:00:00Z',
          original_due_at: '2026-02-15T15:00:00Z',
          created_at: '2026-02-01T16:00:00Z',
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
          due_at: '2026-02-12T15:00:00Z',
          original_due_at: '2026-02-12T15:00:00Z',
          created_at: '2026-02-08T15:00:00Z',
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
          due_at: '2026-02-09T23:00:00Z',
          original_due_at: '2026-02-09T23:00:00Z',
          created_at: '2026-01-01T23:00:00Z',
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
          due_at: `2026-02-${String(13 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(13 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
        'Task 42 (P1) commentary should reference task age (created Jan 18, ~3 weeks), not deferral. ' +
        'Task 44 commentary should reference notes (headcount for Mary by Saturday). ' +
        'Should NOT surface the recurring evening walk (51) or obvious work tasks. ' +
        'Reasons should mention the social/relational aspect.',
    },
  },
  {
    id: 'bubble-all-routine',
    feature: 'bubble',
    description: 'All daily recurring tasks — should return few or no recommendations',
    input: {
      timezone: 'America/Chicago',
      tasks: Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        title: `Daily affirmation ${i + 1}`,
        priority: 0,
        due_at: '2026-02-09T12:00:00Z',
        original_due_at: '2026-02-09T12:00:00Z',
        created_at: '2026-01-01T12:00:00Z',
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
        'With only recurring daily affirmations, Bubble should return an empty or very small ' +
        'task list (0-2 items). These are routine tasks the user already sees in their task list. ' +
        'Surfacing all 10 would be noise. Summary should reflect that nothing needs attention.',
    },
  },
  {
    id: 'bubble-closing-windows',
    feature: 'bubble',
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
          created_at: '2026-01-15T16:00:00Z',
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
          created_at: '2026-01-20T16:00:00Z',
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
          due_at: `2026-02-${String(15 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(15 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
    id: 'bubble-high-priority-overdue',
    feature: 'bubble',
    description:
      'Priority 3 overdue task with real deadline — AI must treat deadline seriously and reference notes',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 200,
          title: 'Pay quarterly estimated taxes',
          priority: 3,
          due_at: '2026-02-08T22:00:00Z',
          original_due_at: '2026-02-08T22:00:00Z',
          created_at: '2026-01-20T16:00:00Z',
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
          due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
    id: 'bubble-low-priority-overdue',
    feature: 'bubble',
    description:
      'Low-priority overdue tasks that were snoozed multiple times — focus on age/deferral, not hours overdue',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 300,
          title: 'Organize photo albums',
          priority: 0,
          due_at: '2026-02-08T20:00:00Z',
          original_due_at: '2026-01-10T15:00:00Z',
          created_at: '2026-01-05T16:00:00Z',
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
          due_at: '2026-02-07T15:00:00Z',
          original_due_at: '2026-01-15T15:00:00Z',
          created_at: '2026-01-12T16:00:00Z',
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
          due_at: '2026-02-09T12:00:00Z',
          original_due_at: '2026-01-18T12:00:00Z',
          created_at: '2026-01-15T16:00:00Z',
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
          due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
        'ID 300: created Jan 5, priority 0 — on the list for over a month. ' +
        'ID 301: created Jan 12, priority 1 — on the list for nearly a month. ' +
        'ID 302: created Jan 15, priority 0 — on the list for nearly a month. ' +
        'Commentary MUST focus on task age (how long since created_at), ' +
        'NOT on "X hours overdue" or deferral patterns. ' +
        'The AI does not see original_due_at for P0-2 tasks and must not reference deferral gaps.',
    },
  },
  {
    id: 'bubble-mixed-priority-overdue',
    feature: 'bubble',
    description:
      'Mix of priority 3 (real deadline), priority 0 (deferred), and recurring from_completion — different commentary styles',
    input: {
      timezone: 'America/Chicago',
      tasks: [
        {
          id: 400,
          title: 'Submit insurance claim for water damage',
          priority: 3,
          due_at: '2026-02-07T22:00:00Z',
          original_due_at: '2026-02-07T22:00:00Z',
          created_at: '2026-02-01T16:00:00Z',
          labels: ['finance'],
          project_name: null,
          is_recurring: false,
          rrule: null,
          notes: '7-day filing window from incident date (Feb 1). Claim #WD-9921.',
          recurrence_mode: 'from_due' as const,
        },
        {
          id: 401,
          title: 'Clean out email inbox',
          priority: 0,
          due_at: '2026-02-08T15:00:00Z',
          original_due_at: '2026-01-18T15:00:00Z',
          created_at: '2026-01-15T16:00:00Z',
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
          due_at: '2026-02-07T15:00:00Z',
          original_due_at: '2026-02-07T15:00:00Z',
          created_at: '2026-01-01T16:00:00Z',
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
          due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
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
        'ID 401 (priority 0, email inbox): Must focus on task age (created Jan 15, nearly a month ' +
        'on the list). NOT "X hours overdue" or deferral patterns — original_due_at is not shown for P0-2. ' +
        'ID 402 (recurring from_completion, water plants): Must recognize that from_completion + overdue ' +
        'means the plants literally need watering — the task waits for completion before advancing. ' +
        'Three different situations requiring three different kinds of commentary.',
    },
  },
]
