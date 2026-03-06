/**
 * Priority inference scenarios — natural language priority phrases
 *
 * Tests how well the enrichment prompt handles indirect priority signals
 * beyond explicit keywords like "urgent" or "high priority" (which are
 * covered in enrichment-core.ts).
 *
 * Labels policy: labels must be empty unless the user explicitly requests one.
 */

import type { AITestScenario } from '../types'

const defaultProjects = [{ id: 1, name: 'Inbox', shared: false }]

export const enrichmentPriorityScenarios: AITestScenario[] = [
  {
    id: 'enrich-priority-big-deal',
    feature: 'enrichment',
    description: '"big deal" as an importance signal — should infer P3, not P4',
    input: {
      text: 'this is a big deal I need to renew my passport before the trip',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      must_not_include: {
        priority: 0,
      },
      quality_notes:
        'Priority should be 3 (high). "Big deal" signals importance but is not an urgency keyword — ' +
        'should NOT be P4. Title should be cleaned: "Renew my passport before the trip" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-not-big-deal',
    feature: 'enrichment',
    description: '"not a big deal" — explicit low-priority signal',
    input: {
      text: 'not a big deal but pick up more paper towels',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 1,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 1 (low). "Not a big deal" is a clear low-priority signal. ' +
        'Title: "Pick up more paper towels" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-top-priority',
    feature: 'enrichment',
    description: '"top priority" — strong importance signal',
    input: {
      text: 'top priority get the contract signed this week',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      must_not_include: {
        priority: 0,
      },
      quality_notes:
        'Priority should be 3-4. "Top priority" is a strong signal — P3 (high) is acceptable, ' +
        'P4 (urgent) is also reasonable given "top priority" implies maximum importance. ' +
        'Title: "Get the contract signed" or similar. due_at should reflect "this week". ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-drop-everything',
    feature: 'enrichment',
    description: '"drop everything" — urgent action signal',
    input: {
      text: 'drop everything and call the school about the emergency pickup',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 4,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 4 (urgent). "Drop everything" combined with "emergency" is a clear ' +
        'urgency signal equivalent to "immediately". ' +
        'Title: "Call the school about the emergency pickup" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-can-wait',
    feature: 'enrichment',
    description: '"can wait" — explicit low-priority signal',
    input: {
      text: 'this can wait but we should replace the air filters at some point',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 1,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 1 (low). "Can wait" and "at some point" are clear low-priority signals. ' +
        'Title: "Replace the air filters" or similar. No due_at — "at some point" is not a date. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-whenever-chance',
    feature: 'enrichment',
    description: '"whenever you get a chance" — low-priority signal',
    input: {
      text: 'whenever you get a chance clean out the junk drawer',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 1,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 1 (low). "Whenever you get a chance" is equivalent to "no rush". ' +
        'The prompt already lists "whenever" as a P1 keyword. ' +
        'Title: "Clean out the junk drawer" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-time-sensitive',
    feature: 'enrichment',
    description: '"time sensitive" — high importance with deadline',
    input: {
      text: 'time sensitive need to RSVP for the wedding by Friday',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      must_not_include: {
        priority: 0,
      },
      quality_notes:
        'Priority should be 3-4. "Time sensitive" signals high importance — P3 (high) is the ' +
        'expected value, P4 is acceptable given the explicit time pressure. ' +
        'Title: "RSVP for the wedding" or similar. due_at should be Friday. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-do-soon',
    feature: 'enrichment',
    description: '"should probably do this soon" — moderate importance',
    input: {
      text: 'should probably do this soon schedule the annual physical',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Priority should be 2 (medium). "Should probably do this soon" is a moderate signal — ' +
        'not urgent, not low priority, just a gentle nudge. P1-2 are acceptable. ' +
        'Title: "Schedule the annual physical" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-no-rush-at-all',
    feature: 'enrichment',
    description: '"no rush at all" — emphatic low-priority signal',
    input: {
      text: 'no rush at all but look into refinancing options',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 1,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 1 (low). "No rush at all" is an emphatic version of "no rush", ' +
        'which is already a listed P1 keyword. ' +
        'Title: "Look into refinancing options" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-dont-forget-important',
    feature: 'enrichment',
    description: '"don\'t forget" + "really important" — P3 signal',
    input: {
      text: "don't forget to buy anniversary gift this is really important",
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 3,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 3 (high). "Really important" is a clear P3 signal — the prompt maps ' +
        '"important" to P3. "Don\'t forget" reinforces importance but does not escalate to P4. ' +
        'Title: "Buy anniversary gift" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-nice-to-have',
    feature: 'enrichment',
    description: '"nice to have but not essential" — unset or low priority',
    input: {
      text: 'would be nice to have but not essential reorganize the bookshelf',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Priority should be 0-1. "Nice to have but not essential" signals low importance — ' +
        'P0 (unset) or P1 (low) are both acceptable. Should NOT be P2 or higher. ' +
        'Title: "Reorganize the bookshelf" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-life-and-death',
    feature: 'enrichment',
    description: '"matter of life and death" — hyperbolic urgency',
    input: {
      text: 'this is a matter of life and death pick up the prescription',
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 4,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 4 (urgent). "Matter of life and death" is hyperbolic but unquestionably ' +
        'signals extreme urgency — the prompt lists it as an extreme urgency phrase that can reach P4. ' +
        'Title: "Pick up the prescription" or similar. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-priority-important-multifield',
    feature: 'enrichment',
    description: '"it\'s important" trailing a complex multi-field dictation',
    input: {
      text: "team sync meeting every tuesday at 10am remember to send the agenda it's important",
      timezone: 'America/Chicago',
      projects: defaultProjects,
    },
    requirements: {
      must_include: {
        priority: 3,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 3 (high). "It\'s important" at the end of the input is a standalone priority ' +
        'signal — the prompt maps "important" to P3. This must trigger even when embedded in a complex ' +
        'multi-field input with recurrence, time, and notes. ' +
        'Title: "Team sync meeting" or similar. due_at should be Tuesday 10am. ' +
        'rrule should be FREQ=WEEKLY;BYDAY=TU. Notes should capture "send the agenda". ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
]
