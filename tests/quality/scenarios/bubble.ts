/**
 * Bubble recommendation scenarios
 *
 * Tests the Bubble feature which surfaces tasks that are easy to overlook:
 * old lingering tasks, social obligations, routine-only lists, and
 * time-sensitive tasks without hard deadlines.
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
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface the old lingering tasks (IDs 10, 11, 12). ' +
        'ID 10: created over a month ago, originally due Jan 10 but snoozed to Jan 20. ' +
        'ID 11: created almost a month ago, originally due Jan 15 but snoozed. ' +
        'ID 12: created in December with no due date — sitting for 7+ weeks. ' +
        'Must NOT surface: daily recurring affirmation (20), shopping (21), or urgent task (22). ' +
        'Reasons should mention how long the task has been on the list. ' +
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
        },
        {
          id: 44,
          title: 'RSVP to neighborhood cookout',
          priority: 0,
          due_at: '2026-02-20T15:00:00Z',
          original_due_at: '2026-02-20T15:00:00Z',
          created_at: '2026-02-01T16:00:00Z',
          labels: ['social'],
          project_name: null,
          is_recurring: false,
        },
        // Non-social tasks
        {
          id: 50,
          title: 'Update spreadsheet',
          priority: 2,
          due_at: '2026-02-10T15:00:00Z',
          original_due_at: '2026-02-10T15:00:00Z',
          created_at: '2026-02-08T15:00:00Z',
          labels: ['work'],
          project_name: null,
          is_recurring: false,
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
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: 60 + i,
          title: `Work task ${i + 1}`,
          priority: 1,
          due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          original_due_at: `2026-02-${String(10 + i).padStart(2, '0')}T15:00:00Z`,
          created_at: '2026-02-08T15:00:00Z',
          labels: ['work'],
          project_name: null,
          is_recurring: false,
        })),
      ],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'MUST surface social obligations: Call Granddaddy (42), thank-you card (43), RSVP (44). ' +
        'Social/family tasks become awkward if delayed and slip through the cracks. ' +
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
]
