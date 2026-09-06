/**
 * Reminder enrichment scenarios (REDESIGN-V03 §6)
 *
 * A reminder is a thought the user wants prompted at a recurring moment, not
 * an action with a deadline. Enrichment reads the cadence and the time of day
 * out of what was typed and pins the rule to one of the user's OWN time slots.
 *
 * The interesting failure these scenarios guard against is a model that
 * resolves "evening" to a generic 7pm rather than to this user's Evening slot
 * at 8:30pm — the whole reason the slots are in the prompt.
 *
 * Output here is the SANITIZED result, so `must_include` asserts what the
 * database would actually receive: no due date, no labels, no project.
 */

import type { AITestScenario } from '../types'

/** Trent's five, and the shipped defaults (see DEFAULT_TIME_SLOTS). */
const SLOTS = [
  { label: 'Early morning', start_time: '07:00' },
  { label: 'Morning', start_time: '09:00' },
  { label: 'Midday', start_time: '12:00' },
  { label: 'Afternoon', start_time: '16:00' },
  { label: 'Evening', start_time: '20:30' },
]

export const enrichmentReminderScenarios: AITestScenario[] = [
  {
    id: 'reminder-bare-thought',
    feature: 'enrichment_reminder',
    description: 'A bare thought with no cadence and no time of day',
    input: {
      text: 'notice what I am grateful for',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Afternoon',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=16;BYMINUTE=0',
        due_at: null,
        labels: [],
        project_name: null,
        priority: 0,
      },
      quality_notes:
        'Title should preserve the user’s voice — "Notice what I am grateful for" — ' +
        'without being rewritten into an action ("Practice gratitude" is an edit, not a transcription). ' +
        'No cadence was stated, so daily is right. No time of day was stated, so the current slot ' +
        '(Afternoon, 16:00) is right. notes should be null — there is nothing the title cannot carry.',
    },
  },
  {
    id: 'reminder-weekly-evening',
    feature: 'enrichment_reminder',
    description: 'Named days plus a time-of-day word that must resolve to the user’s slot',
    input: {
      text: 'every Friday and Sunday in the evening think about the week ahead',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Morning',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=20;BYMINUTE=30',
        due_at: null,
        labels: [],
        project_name: null,
      },
      quality_notes:
        'The critical check: "evening" must resolve to THIS user’s Evening slot (20:30), ' +
        'not to a generic 6pm or 7pm. BYDAY must be FR,SU. ' +
        'Title should be the thought itself ("Think about the week ahead"), with the schedule ' +
        'phrase removed from it entirely.',
    },
  },
  {
    id: 'reminder-morning-word',
    feature: 'enrichment_reminder',
    description: '"In the morning" must pick the Morning slot, not the earliest one',
    input: {
      text: 'stretch my back in the morning',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Evening',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        due_at: null,
        labels: [],
      },
      quality_notes:
        '"Morning" names the Morning slot (09:00), not Early morning (07:00) — the word matches ' +
        'a slot label exactly. Cadence is daily: no days were named. Title: "Stretch my back".',
    },
  },
  {
    id: 'reminder-monthly',
    feature: 'enrichment_reminder',
    description: 'Monthly cadence on a specific day of the month',
    input: {
      text: 'on the first of every month look over what I spent',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Midday',
    },
    requirements: {
      must_include: {
        due_at: null,
        labels: [],
        project_name: null,
      },
      quality_notes:
        'rrule must be FREQ=MONTHLY;BYMONTHDAY=1 with BYHOUR/BYMINUTE on a slot boundary. ' +
        'No time of day was stated, so the current slot (Midday, 12:00) is expected: ' +
        'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=12;BYMINUTE=0. ' +
        'Title should read as the thought ("Look over what I spent"), not the schedule.',
    },
  },
  {
    id: 'reminder-vague-frequency',
    feature: 'enrichment_reminder',
    description: 'A frequency with no named days — the model has to choose days',
    input: {
      text: 'a couple times a week I want to remember to text my brother',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Afternoon',
    },
    requirements: {
      must_include: {
        due_at: null,
        labels: [],
        project_name: null,
      },
      quality_notes:
        'rrule must be FREQ=WEEKLY with exactly two BYDAY values (any two spread across the week ' +
        'is acceptable) and BYHOUR/BYMINUTE on a slot boundary — the current slot (16:00) is ' +
        'expected since no time of day was said. The user’s framing ("I want to remember to") ' +
        'is scaffolding: the title should be "Text my brother". ' +
        'This must NOT become a task with a due date.',
    },
  },
  {
    id: 'reminder-garbled-dictation',
    feature: 'enrichment_reminder',
    description: 'Dictation with false starts, a correction, and an aside for notes',
    input: {
      text: 'um remind me every uh every night before bed no wait every night to um to write down one thing that went well today, my therapist suggested it',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Morning',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30',
        due_at: null,
        labels: [],
        project_name: null,
      },
      quality_notes:
        'Fillers ("um", "uh") and the false start ("no wait") must be dropped. ' +
        '"Every night" is daily; "before bed" / "night" resolves to the Evening slot (20:30). ' +
        'Title should be the thought itself — "Write down one thing that went well today" — ' +
        'with the "remind me" scaffolding removed. ' +
        'The aside ("my therapist suggested it") must survive in notes, not be discarded and ' +
        'not be jammed into the title.',
    },
  },
  {
    id: 'reminder-lunch-word',
    feature: 'enrichment_reminder',
    description: 'A time word that matches no slot label must still find its slot by time',
    input: {
      text: 'at lunch check in with how my body feels',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Early morning',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
        due_at: null,
        labels: [],
      },
      quality_notes:
        'No slot is called "Lunch". "At lunch" has to be matched by time to Midday (12:00), ' +
        'not to the current slot (Early morning) and not to a generic 12:30 or 1pm. ' +
        'Daily, since no days were named. Title: "Check in with how my body feels".',
    },
  },
  {
    id: 'reminder-subject-is-not-a-clock',
    feature: 'enrichment_reminder',
    description: 'A thought whose subject suggests a time of day, with none stated',
    input: {
      text: 'drink a glass of water',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Evening',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30',
        due_at: null,
        labels: [],
        priority: 0,
      },
      quality_notes:
        'Every prior about hydration says "morning" or "throughout the day". The user said ' +
        'nothing about when, so the marked current slot (Evening, 20:30) is the answer. ' +
        'The subject of a thought is not evidence about when the user wants it. ' +
        'Title preserved as typed: "Drink a glass of water".',
    },
  },
  {
    id: 'reminder-every-other-week',
    feature: 'enrichment_reminder',
    description:
      'A cadence the editor cannot express — every other week — round-trips as a custom rule',
    input: {
      text: 'every other Sunday evening plan the next two weeks',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Midday',
    },
    requirements: {
      must_include: {
        due_at: null,
        labels: [],
        project_name: null,
      },
      quality_notes:
        'rrule must be FREQ=WEEKLY;INTERVAL=2;BYDAY=SU with BYHOUR=20;BYMINUTE=30 (Evening). ' +
        'INTERVAL=2 is the one case where an interval is right — the user asked for it. ' +
        'The sanitizer keeps custom rules intact, so the stored rule should still read as ' +
        'every other Sunday. Title: "Plan the next two weeks".',
    },
  },
  {
    id: 'reminder-stated-priority',
    feature: 'enrichment_reminder',
    description: 'An explicit priority phrase lands in the field and leaves the title',
    input: {
      text: 'high priority remember why I started this business every morning',
      timezone: 'America/Chicago',
      slots: SLOTS,
      currentSlotLabel: 'Afternoon',
    },
    requirements: {
      must_include: {
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        priority: 3,
        due_at: null,
        labels: [],
      },
      quality_notes:
        '"High priority" is the one explicit priority signal the task prompt maps to 3; it ' +
        'applies to reminders the same way. The phrase must be removed from the title, as must ' +
        '"every morning". Title: "Remember why I started this business". Morning slot (09:00).',
    },
  },
]
