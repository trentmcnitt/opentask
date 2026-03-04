/**
 * Edge case enrichment scenarios
 *
 * Tests unusual inputs that push the boundaries of the enrichment pipeline:
 * near-empty input, question-form tasks, very long rambling, embedded URLs,
 * conflicting signals, no-verb tasks, all-metadata-no-task.
 */

import type { AITestScenario } from '../types'

export const enrichmentEdgeScenarios: AITestScenario[] = [
  {
    id: 'enrich-edge-near-empty',
    feature: 'enrichment',
    description: 'Near-empty input — "do it" with no context',
    input: {
      text: 'do it',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "Do it" — there is nothing to clean or extract. ' +
        'All other fields should be null/0/empty. ' +
        'The AI should not hallucinate a task from nothing.',
    },
  },
  {
    id: 'enrich-edge-question-form',
    feature: 'enrichment',
    description: 'Task phrased as a question — should still extract intent',
    input: {
      text: 'should I call the dentist about the crown thing?',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should capture the intent: "Call the dentist about the crown" or similar. ' +
        'The question mark and "should I" framing should be cleaned up. ' +
        "It's still a task even though it was phrased as a question.",
    },
  },
  {
    id: 'enrich-edge-very-long-rambling',
    feature: 'enrichment',
    description: 'Very long rambling input — must extract a concise title',
    input: {
      text: 'ok so this is a long one bear with me so my neighbor told me that there was this guy who does really great work on gutters and I think his name was Mike or Mark or something and anyway I should call him because our gutters are totally trashed from the last storm and we really need to get them fixed before spring when all the rain comes and I think his number is somewhere on the neighborhood Facebook group page',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should be concise: "Call the gutter repair guy" or "Get gutters fixed" or similar. ' +
        'notes should capture relevant details: neighbor referral, name (Mike or Mark), ' +
        'number on Facebook group page, storm damage context. ' +
        'The title should NOT be a paragraph.',
    },
  },
  {
    id: 'enrich-edge-embedded-url',
    feature: 'enrichment',
    description: 'Input with an embedded URL — URL should be preserved',
    input: {
      text: 'sign up for the webinar at https://example.com/webinar next Thursday at 2pm',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "Sign up for the webinar" or similar (date removed from title). ' +
        'The URL (https://example.com/webinar) MUST be preserved — in the title or notes. ' +
        'due_at should be next Thursday at 2pm.',
    },
  },
  {
    id: 'enrich-edge-embedded-email',
    feature: 'enrichment',
    description: 'Input with an embedded email address — must be preserved',
    input: {
      text: 'email john.smith@example.com about the invoice by Friday',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Email john.smith@example.com about the invoice" or similar. ' +
        'The email address MUST be preserved exactly — in title or notes. ' +
        'due_at should be Friday.',
    },
  },
  {
    id: 'enrich-edge-conflicting-signals',
    feature: 'enrichment',
    description: 'Conflicting priority signals — "low priority but urgent"',
    input: {
      text: 'low priority but kind of urgent order new printer ink',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "Order new printer ink" (priority phrases removed). ' +
        'Priority handling of conflicting signals: "low priority" suggests 1, "urgent" suggests 4. ' +
        'Reasonable outcomes: priority 1-2 (giving weight to the initial "low priority" statement) ' +
        'or priority 3-4 (giving weight to "urgent"). Either interpretation is defensible. ' +
        'The worst outcome would be priority 0 (ignoring both signals).',
    },
  },
  {
    id: 'enrich-edge-no-verb',
    feature: 'enrichment',
    description: 'No-verb task — just a noun phrase',
    input: {
      text: 'new tires',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should be "New tires" — NOT "Buy new tires" or "Get new tires". ' +
        'The user said "new tires" and nothing else. Do not invent a verb. ' +
        'All other fields should be null/0/empty.',
    },
  },
  {
    id: 'enrich-edge-all-metadata-no-task',
    feature: 'enrichment',
    description: 'Input that is mostly metadata with minimal task content',
    input: {
      text: 'that thing tomorrow at 3pm high priority auto-snooze 30 minutes',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 3,
        auto_snooze_minutes: 30,
        labels: [],
      },
      quality_notes:
        'The input is almost entirely metadata with minimal task content ("that thing"). ' +
        'The AI should extract what it can: priority 3, auto_snooze 30, due_at tomorrow 3pm. ' +
        'Title will be minimal — something like "That thing" or the remaining text after extraction. ' +
        'This tests graceful handling of metadata-heavy, task-light input.',
    },
  },
  {
    id: 'enrich-user-context-no-project-inference',
    feature: 'enrichment',
    description:
      'User context must NOT trigger content-based project matching — context says software engineer but no explicit project assignment',
    input: {
      text: 'fix that deployment bug',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Work', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
      userContext: 'I work from home as a software engineer. My main project at work is a web app.',
    },
    requirements: {
      must_include: {
        project_name: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should be clean (e.g., "Fix that deployment bug" or "Fix deployment bug"). ' +
        'project_name MUST be null — even though user context says "software engineer" and a Work project exists, ' +
        'content-based project inference is forbidden. Only explicit assignment (e.g., "add to Work") triggers project matching. ' +
        'The user context should NOT appear in the title or notes — it is background knowledge only. ' +
        'Priority should remain 0 (no urgency signal in the input).',
    },
  },
  {
    id: 'enrich-user-context-no-leakage',
    feature: 'enrichment',
    description:
      'User context must not leak into output fields — context says "my wife handles groceries"',
    input: {
      text: 'buy milk',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
      userContext: 'My wife handles most grocery shopping. I have two young kids in daycare.',
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should be "Buy milk" or similar — the user context about wife/kids must NOT appear in the title. ' +
        'Notes should be null — do not add context like "wife usually handles groceries" to the notes field. ' +
        'The AI should still structurally extract the task normally. ' +
        'project_name should be null — no explicit project assignment. ' +
        'This tests that user context is used as background knowledge without leaking into any output field.',
    },
  },
]
