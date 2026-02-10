/**
 * AI quality test scenarios
 *
 * Each scenario defines an input, the feature it tests, and requirements
 * for both Layer 1 (structural) and Layer 2 (quality) validation.
 *
 * To add a scenario: append to the appropriate array below, then run
 * `npm run test:quality` to generate outputs and evaluate quality.
 */

import type { AITestScenario } from './types'

// ---------------------------------------------------------------------------
// Enrichment scenarios
// ---------------------------------------------------------------------------

export const enrichmentScenarios: AITestScenario[] = [
  {
    id: 'enrich-simple-clean',
    feature: 'enrichment',
    description: 'Simple, clean input — should extract minimal fields',
    input: {
      text: 'Buy milk',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Title should be unchanged or minimally cleaned. ' +
        'May match Shopping List project given "Buy milk". ' +
        'Labels should be conservative — "shopping" or "errand" are reasonable. ' +
        'No due date or recurrence should be inferred.',
    },
  },
  {
    id: 'enrich-date-relative',
    feature: 'enrichment',
    description: 'Relative date extraction — "tomorrow morning"',
    input: {
      text: 'call the dentist tomorrow morning',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
      },
      quality_notes:
        'Title should be clean (e.g., "Call the dentist"). ' +
        'due_at must be tomorrow morning in UTC (Chicago is UTC-6 or UTC-5). ' +
        '"Morning" typically means 8-10am local. ' +
        'Labels like "medical" are reasonable. Priority should be 0 (no urgency signal).',
    },
  },
  {
    id: 'enrich-garbled-dictation',
    feature: 'enrichment',
    description: 'Garbled dictation with filler words — clean up while preserving intent',
    input: {
      text: 'um I need to like go get the car you know fixed or whatever maybe next week',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
      },
      quality_notes:
        'Title should be cleaned of dictation artifacts (um, like, you know, or whatever). ' +
        'Something like "Get the car fixed" or "Go get the car fixed". ' +
        'due_at should be approximately next week. ' +
        'Labels like "car" or "errand" are reasonable. Priority 0 or 1.',
    },
  },
  {
    id: 'enrich-priority-urgent',
    feature: 'enrichment',
    description: 'Explicit urgent priority signal',
    input: {
      text: 'URGENT fix the leak in the kitchen right now',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        priority: 4,
        rrule: null,
      },
      quality_notes:
        'Priority MUST be 4 (urgent). ' +
        'Title should remove "URGENT" and "right now" (extracted into priority/date). ' +
        'Something like "Fix the leak in the kitchen". ' +
        'due_at could be now/today given "right now". ' +
        'Should match Home project. Labels like "home" are reasonable.',
    },
  },
  {
    id: 'enrich-recurrence-daily',
    feature: 'enrichment',
    description: 'Daily recurrence with time — "every morning at 8am"',
    input: {
      text: 'take vitamins every morning at 8am',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {},
      quality_notes:
        'Title: "Take vitamins" (recurrence phrase removed). ' +
        'rrule MUST be "FREQ=DAILY" (no DTSTART). ' +
        'due_at should be set to 8am Chicago time converted to UTC. ' +
        'Labels like "health" are reasonable. Priority 0.',
    },
  },
  {
    id: 'enrich-multi-field',
    feature: 'enrichment',
    description: 'Multiple fields extracted at once — priority, date, project',
    input: {
      text: 'high priority call mom next tuesday, add it to family',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 4, name: 'Family', shared: false },
      ],
    },
    requirements: {
      must_include: {
        rrule: null,
      },
      quality_notes:
        'Priority should be 3 (high). ' +
        'Title: "Call mom" (priority/date/project phrases removed). ' +
        'due_at should be next Tuesday. ' +
        'project_name should be "Family". ' +
        'Labels like "family" are reasonable.',
    },
  },
  {
    id: 'enrich-already-clean',
    feature: 'enrichment',
    description: 'Already clean input — should not over-extract',
    input: {
      text: 'Fix van arm',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        project_name: null,
      },
      quality_notes:
        'Title should be unchanged: "Fix van arm". ' +
        'No date, priority, recurrence, or project should be inferred. ' +
        'Labels like "car" are reasonable (from "van" context). ' +
        'This tests the "do not over-extract" principle.',
    },
  },
  {
    id: 'enrich-shopping-context',
    feature: 'enrichment',
    description: 'Shopping item with Shopping List project available',
    input: {
      text: 'whole milk',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
      },
      quality_notes:
        'Title should be "Whole milk" or unchanged. ' +
        'project_name should be "Shopping List" (clear shopping context). ' +
        'Labels like "shopping" or "dairy" are reasonable. ' +
        'No date or priority should be inferred.',
    },
  },
  {
    id: 'enrich-emotional-cue',
    feature: 'enrichment',
    description: 'Emotional urgency — should infer some priority from language cues',
    input: {
      text: 'I really really need to remember to call the insurance company this is killing me',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
      },
      quality_notes:
        'Title should be cleaned: "Call the insurance company" or similar. ' +
        'Priority should be >= 2 (the emotional intensity "really really", "killing me" signals importance). ' +
        'No date should be inferred (no temporal signal). ' +
        'Labels like "finance" or "personal" are reasonable.',
    },
  },
  {
    id: 'enrich-no-over-infer',
    feature: 'enrichment',
    description: 'Ambiguous task — should not over-infer fields',
    input: {
      text: 'check the mail',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        project_name: null,
      },
      quality_notes:
        'Title should be "Check the mail" or unchanged. ' +
        'Priority must be 0 — no urgency signal. ' +
        'No due date should be inferred. ' +
        'Minimal labels — "errand" or "home" at most. ' +
        'This tests conservative extraction — better to leave empty than guess wrong.',
    },
  },
]

// ---------------------------------------------------------------------------
// Bubble scenarios
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shopping scenarios
// ---------------------------------------------------------------------------

export const shoppingScenarios: AITestScenario[] = [
  {
    id: 'shopping-produce',
    feature: 'shopping',
    description: 'Basic produce item — straightforward classification',
    input: { item: 'bananas' },
    requirements: {
      must_include: { section: 'produce' },
      quality_notes: 'Bananas are unambiguously produce. Section must be "produce".',
    },
  },
  {
    id: 'shopping-ambiguous',
    feature: 'shopping',
    description: 'Ambiguous item — could be pantry (canned) or meat',
    input: { item: 'chicken broth' },
    requirements: {
      must_include: { section: 'pantry' },
      quality_notes:
        'Chicken broth is typically a pantry/canned good, not a meat item. ' +
        'Section should be "pantry". Accept "other" if reasoning is sensible.',
    },
  },
  {
    id: 'shopping-non-food',
    feature: 'shopping',
    description: 'Non-food household item',
    input: { item: 'paper towels' },
    requirements: {
      must_include: { section: 'household' },
      quality_notes: 'Paper towels are unambiguously household. Section must be "household".',
    },
  },
]

// ---------------------------------------------------------------------------
// All scenarios combined
// ---------------------------------------------------------------------------

export const allScenarios: AITestScenario[] = [
  ...enrichmentScenarios,
  ...bubbleScenarios,
  ...shoppingScenarios,
]
