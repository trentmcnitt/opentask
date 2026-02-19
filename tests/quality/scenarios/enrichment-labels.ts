/**
 * Label-specific enrichment scenarios
 *
 * Tests the explicit-only label policy: labels must only be extracted when
 * the user explicitly requests them. Contextual inference is forbidden.
 */

import type { AITestScenario } from '../types'

export const enrichmentLabelScenarios: AITestScenario[] = [
  {
    id: 'enrich-label-explicit-single',
    feature: 'enrichment',
    description: 'Explicit label request with "label it as"',
    input: {
      text: 'pick up dry cleaning and label it as errands',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['errands'],
        priority: 0,
        rrule: null,
      },
      quality_notes:
        'Title: "Pick up dry cleaning" (label phrase removed). ' +
        'Labels MUST include "errands" — user explicitly said "label it as errands". ' +
        'The label "errands" may not exist yet — that is fine, it is the user\'s intent.',
    },
  },
  {
    id: 'enrich-label-explicit-tag',
    feature: 'enrichment',
    description: 'Explicit label request with "tag it"',
    input: {
      text: 'order birthday cake for Saturday tag it party',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['party'],
      },
      quality_notes:
        'Title: "Order birthday cake" or similar (date/tag phrase removed). ' +
        'Labels MUST include "party" — user explicitly said "tag it party". ' +
        'due_at should be Saturday.',
    },
  },
  {
    id: 'enrich-label-explicit-multiple',
    feature: 'enrichment',
    description: 'Multiple explicit label requests in one input',
    input: {
      text: 'renew passport label it as travel and also tag it documents',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['travel', 'documents'],
        priority: 0,
        rrule: null,
      },
      quality_notes:
        'Title: "Renew passport" (label phrases removed). ' +
        'Labels MUST include both "travel" and "documents" — both explicitly requested.',
    },
  },
  {
    id: 'enrich-label-no-infer-dentist',
    feature: 'enrichment',
    description: 'Dentist task — must NOT infer "medical" label',
    input: {
      text: 'schedule dentist cleaning next month',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      must_not_include: {
        labels: ['medical', 'health', 'dental'],
      },
      quality_notes:
        'Title: "Schedule dentist cleaning" or similar. ' +
        'Labels MUST be empty — mentioning a dentist does NOT warrant inferring "medical". ' +
        'The user did not ask for any label. Contextual inference is forbidden.',
    },
  },
  {
    id: 'enrich-label-no-infer-grocery',
    feature: 'enrichment',
    description: 'Grocery task — must NOT infer "shopping" label',
    input: {
      text: 'pick up bananas and bread',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      must_not_include: {
        labels: ['shopping', 'grocery', 'groceries', 'errand', 'food'],
      },
      quality_notes:
        'Title: "Pick up bananas and bread" or similar. ' +
        'Labels MUST be empty — groceries do NOT warrant inferring "shopping". ' +
        "Project matching to Shopping List is fine (that's project, not label). " +
        'Contextual inference is forbidden for labels.',
    },
  },
  {
    id: 'enrich-label-no-infer-car',
    feature: 'enrichment',
    description: 'Car task — must NOT infer "car" or "auto" label',
    input: {
      text: 'get the oil changed on the truck',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      must_not_include: {
        labels: ['car', 'auto', 'vehicle', 'truck', 'maintenance'],
      },
      quality_notes:
        'Title: "Get the oil changed on the truck" or similar. ' +
        'Labels MUST be empty — mentioning a truck does NOT warrant any label. ' +
        'Contextual inference is forbidden.',
    },
  },
  {
    id: 'enrich-label-no-infer-work',
    feature: 'enrichment',
    description: 'Work-related task — must NOT infer "work" label',
    input: {
      text: 'send the TPS report to accounting by Friday',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 5, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      must_not_include: {
        labels: ['work', 'office', 'business'],
      },
      quality_notes:
        'Title: "Send the TPS report to accounting" or similar. ' +
        'Labels MUST be empty — work context does NOT warrant a "work" label. ' +
        "Project matching to Work is fine (that's project, not label).",
    },
  },
  {
    id: 'enrich-label-ambiguous-project-vs-label',
    feature: 'enrichment',
    description: 'Ambiguous "put it in shopping" — should be project, not label',
    input: {
      text: 'oat milk put it in shopping',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      must_not_include: {
        labels: ['shopping'],
      },
      quality_notes:
        'Title: "Oat milk" or similar. ' +
        'Labels MUST be empty — "put it in shopping" is a project assignment, not a label request. ' +
        'project_name should be "Shopping List". ' +
        'This tests the distinction between project assignment and label tagging.',
    },
  },
  {
    id: 'enrich-label-critical-maps-to-priority',
    feature: 'enrichment',
    description: '"Critical alert" maps to P4 priority, not a label',
    input: {
      text: 'pick up emergency inhaler critical alert before 5pm',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 4,
        labels: [],
      },
      quality_notes:
        'Title: "Pick up emergency inhaler" or similar. ' +
        'Priority MUST be 4 — "critical" is a P4 keyword. ' +
        'Labels must be empty — "critical" is not a label, it maps to priority. ' +
        'due_at should be today at 5pm.',
    },
  },
  {
    id: 'enrich-label-explicit-with-context',
    feature: 'enrichment',
    description: 'Explicit label alongside contextual content — only explicit label should appear',
    input: {
      text: 'take the car to the mechanic for inspection label it as auto',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['auto'],
      },
      quality_notes:
        'Title: "Take the car to the mechanic for inspection" or similar. ' +
        'Labels MUST include "auto" — user explicitly said "label it as auto". ' +
        'Labels must NOT include additional contextual labels like "car" or "maintenance" — ' +
        'only the explicitly requested "auto" label should appear.',
    },
  },
]
