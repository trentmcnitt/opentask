/**
 * Dictation realism and typo tolerance scenarios
 *
 * Tests the AI's ability to handle real-world dictation artifacts:
 * lowercase keywords, stream-of-consciousness, false starts,
 * numbers as words, typos, and missing spaces.
 */

import type { AITestScenario } from '../types'

export const enrichmentDictationScenarios: AITestScenario[] = [
  {
    id: 'enrich-dictation-lowercase-urgent',
    feature: 'enrichment',
    description: 'Lowercase "urgent" from dictation — must still trigger priority 4',
    input: {
      text: 'urgent call the plumber the pipe is leaking everywhere',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 4,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 4 — "urgent" (lowercase) is the same as "URGENT". ' +
        'Dictation software typically produces lowercase. ' +
        'Title: "Call the plumber" or "Call the plumber, the pipe is leaking everywhere".',
    },
  },
  {
    id: 'enrich-dictation-stream-of-consciousness',
    feature: 'enrichment',
    description: 'Long stream-of-consciousness dictation with buried intent',
    input: {
      text: 'so I was thinking about it and I guess I really should probably go ahead and schedule that eye exam thing I keep putting off maybe sometime next week would work I think',
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
        'Title: "Schedule eye exam" or similar — extract the core action from the rambling. ' +
        'due_at should be approximately next week. ' +
        'Priority 0 — no urgency signal. All the hedging language should be removed.',
    },
  },
  {
    id: 'enrich-dictation-false-starts',
    feature: 'enrichment',
    description: 'Dictation with false starts and self-corrections',
    input: {
      text: 'no wait not that um I mean I need to pick up no actually drop off the package at the post office tomorrow',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "Drop off the package at the post office" — the correction ("no actually drop off") is the real intent. ' +
        '"pick up" was a false start. due_at should be tomorrow.',
    },
  },
  {
    id: 'enrich-dictation-numbers-as-words',
    feature: 'enrichment',
    description: 'Dollar amounts and numbers dictated as words',
    input: {
      text: 'pay the electrician four hundred fifty dollars his invoice number is three two seven nine',
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
        'Title: "Pay the electrician" or similar. ' +
        'notes MUST preserve: dollar amount ($450) and invoice number (3279). ' +
        'Numbers dictated as words should be converted to digits in notes.',
    },
  },
  {
    id: 'enrich-dictation-typo-urgent',
    feature: 'enrichment',
    description: 'Typo "urget" for "urgent" — should still trigger priority 4',
    input: {
      text: 'urget fix the garage door its stuck open',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 4,
        labels: [],
      },
      quality_notes:
        'Priority MUST be 4 — "urget" is clearly a typo for "urgent". ' +
        'The prompt instructs generous typo interpretation. ' +
        'Title: "Fix the garage door" or similar.',
    },
  },
  {
    id: 'enrich-dictation-typo-tomorrow',
    feature: 'enrichment',
    description: 'Typo "tommorow" for "tomorrow" — date should still parse',
    input: {
      text: 'dentist appointment tommorow at 3pm',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "Dentist appointment" (date phrase removed). ' +
        'due_at should be tomorrow at 3pm Chicago time in UTC. ' +
        '"tommorow" is a common misspelling — must still parse correctly.',
    },
  },
  {
    id: 'enrich-dictation-typo-critical',
    feature: 'enrichment',
    description: 'Typo "critcal alert" — should still trigger critical label',
    input: {
      text: 'critcal alert pick up seizure medication from pharmacy',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['critical'],
      },
      quality_notes:
        'Labels MUST include "critical" — "critcal alert" is clearly a typo for "critical alert". ' +
        'Title: "Pick up seizure medication from pharmacy" or similar.',
    },
  },
  {
    id: 'enrich-dictation-extreme-typos',
    feature: 'enrichment',
    description: 'Extreme typos and garbled text — still extract core intent',
    input: {
      text: 'tke the dog out evry day at 7 in the mornin',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Take the dog out" or similar. ' +
        'rrule should be FREQ=DAILY (from "evry day"). ' +
        'due_at should be 7am Chicago time in UTC. ' +
        'Multiple typos ("tke", "evry", "mornin") should all be interpreted correctly.',
    },
  },
  {
    id: 'enrich-dictation-missing-spaces',
    feature: 'enrichment',
    description: 'Words run together from poor dictation',
    input: {
      text: 'callmom tuesday afternoon highpriority',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Call mom" or similar. ' +
        'due_at should be Tuesday afternoon. ' +
        'Priority should be 3 ("highpriority" = "high priority"). ' +
        'Missing spaces between words should not prevent extraction.',
    },
  },
  {
    id: 'enrich-dictation-pause-artifacts',
    feature: 'enrichment',
    description: 'Dictation with long pauses producing repeated words and fragments',
    input: {
      text: 'um um buy buy a new new charger for the laptop the the USB-C one',
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
        'Title: "Buy a new charger for the laptop" or "Buy a new USB-C charger for the laptop". ' +
        'All repeated words and filler should be cleaned up. ' +
        'The "USB-C" detail should be preserved (either in title or notes).',
    },
  },
]
