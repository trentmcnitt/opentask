/**
 * Voice preservation scenarios
 *
 * Tests that the AI preserves the user's word choices, framing, and
 * personality rather than sanitizing to generic phrasing.
 * "Act as a transcriptionist, not an editor."
 */

import type { AITestScenario } from '../types'

export const enrichmentVoiceScenarios: AITestScenario[] = [
  {
    id: 'enrich-voice-grab-not-buy',
    feature: 'enrichment',
    description: '"grab" should not be changed to "buy" or "purchase"',
    input: {
      text: 'grab some paper towels on the way home',
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
        labels: [],
      },
      quality_notes:
        'Title MUST preserve "grab" — not "Buy paper towels" or "Purchase paper towels". ' +
        'Expected: "Grab some paper towels on the way home" or "Grab some paper towels". ' +
        'The user said "grab", so the title should say "grab".',
    },
  },
  {
    id: 'enrich-voice-hit-up',
    feature: 'enrichment',
    description: '"hit up" should not be changed to "visit" or "go to"',
    input: {
      text: 'hit up the hardware store for some screws',
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
        'Title MUST preserve "hit up" — not "Visit the hardware store" or "Go to the hardware store". ' +
        'Expected: "Hit up the hardware store for some screws" or similar. ' +
        "The user's casual phrasing should be kept.",
    },
  },
  {
    id: 'enrich-voice-slang',
    feature: 'enrichment',
    description: 'Slang and colloquial phrasing should be preserved',
    input: {
      text: 'fix that janky faucet in the bathroom its driving me nuts',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title MUST preserve "janky" — not "broken" or "malfunctioning". ' +
        'Expected: "Fix that janky faucet in the bathroom" or "Fix the janky bathroom faucet". ' +
        '"driving me nuts" is emotional context, may influence priority (1-2). ' +
        'May match Home project.',
    },
  },
  {
    id: 'enrich-voice-minimal-input',
    feature: 'enrichment',
    description: 'Minimal input should stay minimal — "milk" stays "milk"',
    input: {
      text: 'milk',
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
        labels: [],
      },
      quality_notes:
        'Title should be "Milk" or "milk" — NOT "Buy milk" or "Get milk". ' +
        'The user said one word. Do not invent a verb. ' +
        'May match Shopping List project.',
    },
  },
  {
    id: 'enrich-voice-personality',
    feature: 'enrichment',
    description: 'Personality and tone should be preserved',
    input: {
      text: 'ugh finally deal with that stupid HOA letter about the fence',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        "Title should preserve the user's attitude. " +
        'Acceptable: "Deal with that stupid HOA letter about the fence" or "Deal with the HOA letter about the fence". ' +
        'NOT acceptable: "Respond to HOA fence notification" or "Address HOA correspondence". ' +
        '"ugh" and "finally" are filler and can be removed, but the rest is the user\'s voice.',
    },
  },
  {
    id: 'enrich-voice-colloquial-recurrence',
    feature: 'enrichment',
    description: 'Colloquial recurrence phrasing should parse correctly',
    input: {
      text: 'gotta take out the trash every single Tuesday night',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Take out the trash" — "gotta" is filler, "every single Tuesday night" is recurrence. ' +
        'rrule should be FREQ=WEEKLY;BYDAY=TU. ' +
        'due_at should be Tuesday evening time. ' +
        '"every single" means the same as "every" — emphasis, not a different frequency.',
    },
  },
  {
    id: 'enrich-voice-specific-claim',
    feature: 'enrichment',
    description: 'Specific claims and details in phrasing should be preserved exactly',
    input: {
      text: 'return the blue one not the red one to Target by Sunday',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title MUST preserve "the blue one not the red one" — these are specific details. ' +
        'Expected: "Return the blue one not the red one to Target" or similar. ' +
        'NOT acceptable: "Return item to Target" (lost the color detail). ' +
        'due_at should be Sunday.',
    },
  },
  {
    id: 'enrich-voice-casual-complete',
    feature: 'enrichment',
    description: 'Casual phrasing with metadata should clean metadata but keep voice',
    input: {
      text: 'gotta swing by the bank tomorrow morning and deposit that check for like two hundred bucks',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title should preserve casual voice: "Swing by the bank and deposit the check" or similar. ' +
        'NOT: "Visit bank to make deposit". ' +
        'due_at should be tomorrow morning. ' +
        'meta_notes may capture "$200" (from "two hundred bucks") or it can stay in the title. ' +
        '"like" is a filler word and should be removed.',
    },
  },
]
