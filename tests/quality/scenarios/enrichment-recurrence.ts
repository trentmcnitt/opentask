/**
 * Expanded recurrence pattern scenarios
 *
 * Tests a wider variety of recurrence expressions beyond the basics:
 * weekdays, specific days, biweekly, monthly by date, quarterly,
 * yearly, every other day, twice a week, multi-day complex, hourly.
 */

import type { AITestScenario } from '../types'

export const enrichmentRecurrenceScenarios: AITestScenario[] = [
  {
    id: 'enrich-recurrence-weekdays',
    feature: 'enrichment',
    description: 'Every weekday recurrence',
    input: {
      text: 'check email every weekday at 9am',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 5, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_include: {
        priority: 0,
        labels: [],
      },
      quality_notes:
        'Title: "Check email" (recurrence phrase removed). ' +
        'rrule should be FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR. ' +
        'due_at should be 9am Chicago time in UTC. ' +
        'Labels must be empty — no explicit label request.',
    },
  },
  {
    id: 'enrich-recurrence-specific-days',
    feature: 'enrichment',
    description: 'Recurrence on specific days — Monday and Wednesday',
    input: {
      text: 'go to the gym every Monday and Wednesday at 6pm',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Go to the gym" (recurrence phrase removed). ' +
        'rrule should be FREQ=WEEKLY;BYDAY=MO,WE. ' +
        'due_at should be 6pm Chicago time in UTC.',
    },
  },
  {
    id: 'enrich-recurrence-biweekly',
    feature: 'enrichment',
    description: 'Biweekly recurrence — every 2 weeks',
    input: {
      text: 'submit timesheet every two weeks on Friday',
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
      quality_notes:
        'Title: "Submit timesheet" (recurrence phrase removed). ' +
        'rrule should be FREQ=WEEKLY;INTERVAL=2;BYDAY=FR. ' +
        'May match Work project.',
    },
  },
  {
    id: 'enrich-recurrence-monthly-date',
    feature: 'enrichment',
    description: 'Monthly recurrence by specific date',
    input: {
      text: 'pay mortgage on the 15th of every month',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Pay mortgage" (recurrence phrase removed). ' +
        'rrule should be FREQ=MONTHLY;BYMONTHDAY=15.',
    },
  },
  {
    id: 'enrich-recurrence-quarterly',
    feature: 'enrichment',
    description: 'Quarterly recurrence',
    input: {
      text: 'file quarterly taxes every 3 months',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "File quarterly taxes" (recurrence phrase removed). ' +
        'rrule should be FREQ=MONTHLY;INTERVAL=3.',
    },
  },
  {
    id: 'enrich-recurrence-yearly',
    feature: 'enrichment',
    description: 'Yearly recurrence',
    input: {
      text: 'renew car registration every year in March',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Renew car registration" (recurrence phrase removed). ' +
        'rrule should be FREQ=YEARLY or FREQ=MONTHLY;INTERVAL=12. ' +
        'due_at should be in March.',
    },
  },
  {
    id: 'enrich-recurrence-every-other-day',
    feature: 'enrichment',
    description: 'Every other day recurrence',
    input: {
      text: 'water the garden every other day in the morning',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Water the garden" (recurrence phrase removed). ' +
        'rrule should be FREQ=DAILY;INTERVAL=2. ' +
        'due_at should be a morning time.',
    },
  },
  {
    id: 'enrich-recurrence-twice-a-week',
    feature: 'enrichment',
    description: 'Twice a week recurrence — vague day specification',
    input: {
      text: 'practice piano twice a week',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Practice piano" (recurrence phrase removed). ' +
        'rrule should reflect twice a week — could be FREQ=WEEKLY with two BYDAY values ' +
        'or FREQ=DAILY;INTERVAL=3 or similar approximation. ' +
        'Reasonable default day choices are acceptable.',
    },
  },
  {
    id: 'enrich-recurrence-multi-day-complex',
    feature: 'enrichment',
    description: 'Complex multi-day recurrence with time',
    input: {
      text: 'team standup every Tuesday Thursday and Friday at 10am',
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
      quality_notes:
        'Title: "Team standup" (recurrence phrase removed). ' +
        'rrule should be FREQ=WEEKLY;BYDAY=TU,TH,FR. ' +
        'due_at should be 10am Chicago time in UTC. May match Work project.',
    },
  },
  {
    id: 'enrich-recurrence-hourly',
    feature: 'enrichment',
    description: 'Hourly recurrence — must use FREQ=HOURLY, not auto-snooze',
    input: {
      text: 'check the oven every 2 hours starting at noon',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Check the oven" (recurrence phrase removed). ' +
        'rrule should be FREQ=HOURLY;INTERVAL=2 — this is actual recurrence, not auto-snooze. ' +
        'auto_snooze_minutes should be null (no "auto-snooze" or "snooze" keyword). ' +
        'due_at should be noon Chicago time in UTC.',
    },
  },
]
