/**
 * Context-aware enrichment scenarios — name resolution and work-schedule time
 *
 * Tests that the enrichment prompt correctly uses user context to:
 * - Resolve relationship references ("my wife") to names from context
 * - Resolve work-schedule-relative phrases ("after work") to times from context
 * - Avoid leaking context into output when the user didn't reference it
 */

import type { AITestScenario } from '../types'

export const enrichmentContextScenarios: AITestScenario[] = [
  {
    id: 'enrich-context-name-and-schedule',
    feature: 'enrichment',
    description: 'Name resolution + work schedule: "flowers for my wife after work"',
    input: {
      text: 'flowers for my wife after work',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext:
        'My wife is Kelly. My kids are Annie (born Dec 2018) and Troy (born May 2021). I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'Title MUST include "Kelly" instead of "my wife" — e.g., "Flowers for Kelly". ' +
        'No parenthetical like "(wife)" after the name. ' +
        'due_at MUST be around 4pm local (end of work day per context) converted to UTC. ' +
        'NOT 9am (default morning time) — "after work" means after 4pm. ' +
        'Priority should be 0 (no urgency signal). Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-after-work',
    feature: 'enrichment',
    description: 'Work schedule: "pick up kids after work" with named children',
    input: {
      text: 'pick up kids after work',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext:
        'My wife is Kelly. My kids are Annie (born Dec 2018) and Troy (born May 2021). I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'due_at MUST be around 4pm local (end of work day per context) converted to UTC. ' +
        'Title should keep "kids" — the user said "kids" not a specific child, ' +
        'so substituting both names or keeping "kids" are both acceptable. ' +
        'Do NOT use one child name when the user said "kids" (plural/ambiguous). ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-before-work',
    feature: 'enrichment',
    description: 'Work schedule: "drop off dry cleaning before work"',
    input: {
      text: 'drop off dry cleaning before work',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext: 'I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'due_at MUST be before 8am local (before start of work day per context). ' +
        'Reasonable times: 7:00-7:45am local converted to UTC. ' +
        'NOT 9am (default morning time) — "before work" means before 8am. ' +
        'Title should be clean, e.g., "Drop off dry cleaning". ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-family-name',
    feature: 'enrichment',
    description: 'Name resolution: "call my daughter about her birthday"',
    input: {
      text: 'call my daughter about her birthday',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext:
        'My wife is Kelly. My kids are Annie (born Dec 2018) and Troy (born May 2021). I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'Title MUST include "Annie" instead of "my daughter" — e.g., "Call Annie about her birthday". ' +
        'No parenthetical like "(daughter)" after the name. ' +
        'Context clearly identifies daughter as Annie (born Dec 2018). ' +
        'due_at should be null (no time reference in input). ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-no-leakage',
    feature: 'enrichment',
    description: 'No-leakage: "buy groceries" should NOT inject context names',
    input: {
      text: 'buy groceries',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Shopping List', shared: true },
      ],
      userContext: 'My wife is Kelly. She usually handles groceries. I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Title MUST NOT mention Kelly or "wife" — the user said "buy groceries" with no reference to anyone. ' +
        'Title should be "Buy groceries" or similar. ' +
        "Context says wife handles groceries, but user didn't reference her — no leakage. " +
        'due_at should be null (no time reference). ' +
        'May match Shopping List project. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-at-lunch',
    feature: 'enrichment',
    description: 'Work schedule: "meet Sarah at lunch"',
    input: {
      text: 'meet Sarah at lunch',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext: 'I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'due_at MUST be around 12pm local (midday / lunch time per work schedule context) converted to UTC. ' +
        'NOT 9am (default morning time) — "at lunch" means midday. ' +
        'Title should preserve "Sarah" — e.g., "Meet Sarah at lunch" or "Meet Sarah". ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-ambiguous-name',
    feature: 'enrichment',
    description: 'Ambiguous relationship: "buy a gift for my brother" — no brother in context',
    input: {
      text: 'buy a gift for my brother',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext:
        'My wife is Kelly. My kids are Annie (born Dec 2018) and Troy (born May 2021). I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'Title MUST keep "my brother" — context does NOT provide a brother\'s name. ' +
        'Do NOT hallucinate a name or substitute any name from context (Kelly, Annie, Troy are not the brother). ' +
        'Title should be something like "Buy a gift for my brother". ' +
        'due_at should be null (no time reference). ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
  {
    id: 'enrich-context-no-schedule-fallback',
    feature: 'enrichment',
    description:
      'No work schedule in context: "grab coffee after work" should use reasonable default',
    input: {
      text: 'grab coffee after work',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Personal', shared: false },
      ],
      userContext: 'My wife is Kelly.',
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: null,
      },
      quality_notes:
        'Context has no work schedule, so "after work" should fall back to a reasonable default. ' +
        'due_at should be around 5pm local converted to UTC (reasonable default for end-of-workday). ' +
        'Acceptable range: 4:30pm-6pm local. NOT 9am (default morning time). ' +
        'Title should be clean — e.g., "Grab coffee after work" or "Grab coffee". ' +
        'Priority should be 0. Labels must be empty.',
    },
  },
]
