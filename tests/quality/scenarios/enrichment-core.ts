/**
 * Core enrichment scenarios — updated from original scenarios.ts
 *
 * These test fundamental enrichment capabilities: title cleaning, date extraction,
 * priority inference, recurrence, auto-snooze, recurrence mode, meta_notes,
 * wall-of-text decomposition, critical labels, and complex combinations.
 *
 * Labels policy: labels must be empty unless the user explicitly requests one.
 */

import type { AITestScenario } from '../types'

export const enrichmentCoreScenarios: AITestScenario[] = [
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
        labels: [],
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Title should be unchanged or minimally cleaned. ' +
        'May match Shopping List project given "Buy milk". ' +
        'Labels must be an empty array — no explicit label request in input. ' +
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
        labels: [],
      },
      quality_notes:
        'Title should be clean (e.g., "Call the dentist"). ' +
        'due_at must be tomorrow morning in UTC (Chicago is UTC-6 or UTC-5). ' +
        '"Morning" typically means 8-10am local. ' +
        'Labels must be an empty array — no explicit label request in input. Priority should be 0 (no urgency signal).',
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
        labels: [],
      },
      quality_notes:
        'Title should be cleaned of dictation artifacts (um, like, you know, or whatever). ' +
        'Something like "Get the car fixed" or "Go get the car fixed". ' +
        'due_at should be approximately next week. ' +
        'Labels must be an empty array — no explicit label request in input. Priority 0 or 1.',
    },
  },
  {
    id: 'enrich-priority-urgent',
    feature: 'enrichment',
    description: 'Explicit urgent priority signal (lowercase for dictation realism)',
    input: {
      text: 'urgent fix the leak in the kitchen right now',
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
        labels: [],
      },
      quality_notes:
        'Priority MUST be 4 (urgent). ' +
        'Title should remove "urgent" and "right now" (extracted into priority/date). ' +
        'Something like "Fix the leak in the kitchen". ' +
        'due_at could be now/today given "right now". ' +
        'Should match Home project. Labels must be an empty array — no explicit label request in input.',
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
      must_include: {
        labels: [],
      },
      quality_notes:
        'Title: "Take vitamins" (recurrence phrase removed). ' +
        'rrule MUST be "FREQ=DAILY" (no DTSTART). ' +
        'due_at should be set to 8am Chicago time converted to UTC. ' +
        'Labels must be an empty array — no explicit label request in input. Priority 0.',
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
        labels: [],
      },
      quality_notes:
        'Priority should be 3 (high). ' +
        'Title: "Call mom" (priority/date/project phrases removed). ' +
        'due_at should be next Tuesday. ' +
        'project_name should be "Family". ' +
        'Labels must be an empty array — "add it to family" is a project assignment, not a label request.',
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
        labels: [],
      },
      quality_notes:
        'Title should be unchanged: "Fix van arm". ' +
        'No date, priority, recurrence, or project should be inferred. ' +
        'Labels must be an empty array — no explicit label request in input. ' +
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
        labels: [],
      },
      quality_notes:
        'Title should be "Whole milk" or unchanged. ' +
        'project_name should be "Shopping List" (clear shopping context). ' +
        'Labels must be an empty array — no explicit label request in input. ' +
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
        labels: [],
      },
      quality_notes:
        'Title should be cleaned: "Call the insurance company" or similar. ' +
        'Priority should be >= 2 (the emotional intensity "really really", "killing me" signals importance). ' +
        'No date should be inferred (no temporal signal). ' +
        'Labels must be an empty array — no explicit label request in input.',
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
        labels: [],
      },
      quality_notes:
        'Title should be "Check the mail" or unchanged. ' +
        'Priority must be 0 — no urgency signal. ' +
        'No due date should be inferred. ' +
        'Labels must be an empty array — no explicit label request in input. ' +
        'This tests conservative extraction — better to leave empty than guess wrong.',
    },
  },

  // -------------------------------------------------------------------------
  // Wall-of-Text Decomposition — dense dictation with reference info
  // -------------------------------------------------------------------------

  {
    id: 'enrich-wall-medical-appointment',
    feature: 'enrichment',
    description: 'Dense medical appointment with address, phone, and prep instructions',
    input: {
      text: 'doctor patel appointment at 4200 medical parkway suite 310 his number is 512-555-0847 um its next Thursday at 2:30 pm and I need to bring my insurance card and the MRI results and they said to fast for 4 hours before',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        rrule: null,
        auto_snooze_minutes: null,
        recurrence_mode: null,
        labels: [],
      },
      quality_notes:
        'Title should be clean: "Doctor Patel appointment" or similar. ' +
        'due_at should be next Thursday at 2:30pm Chicago time in UTC. ' +
        'meta_notes MUST preserve: address (4200 Medical Parkway Suite 310), ' +
        'phone (512-555-0847), what to bring (insurance card, MRI results), ' +
        'and fasting instructions (fast 4 hours before). ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-wall-contractor-quote',
    feature: 'enrichment',
    description: 'Contractor quote with dollar amount, phone, and expiration deadline',
    input: {
      text: 'so ABC plumbing gave me a quote for forty eight hundred dollars for the water heater replacement their number is 847-555-0192 and the quote expires at the end of the month I would say medium priority',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        priority: 2,
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should be something like "ABC Plumbing water heater replacement" or similar. ' +
        'Priority must be 2 (explicit "medium priority"). ' +
        'due_at should be end of the current month. ' +
        'meta_notes MUST preserve: quote amount ($4,800), phone (847-555-0192). ' +
        'Labels must be an empty array — no explicit label request in input. May match Home project.',
    },
  },
  {
    id: 'enrich-wall-travel-booking',
    feature: 'enrichment',
    description: 'Travel booking with multiple confirmation numbers and details',
    input: {
      text: 'ok so I got the flight booked Southwest flight ABC123 confirmation number 2847 leaving Saturday at 6:15 am from Midway then I have a Hertz rental car and the Marriott confirmation is H-99281',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title should capture the core action: something about travel/flight or trip prep. ' +
        'due_at should be Saturday at 6:15am Chicago time in UTC. ' +
        'meta_notes MUST preserve ALL confirmation numbers and details: ' +
        'Southwest flight ABC123, confirmation 2847, Midway departure, ' +
        'Hertz rental, Marriott confirmation H-99281. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-wall-legal-deadline',
    feature: 'enrichment',
    description: 'Legal deadline with case number, dollar amounts, and phone with extension',
    input: {
      text: 'I need to file the property tax appeal case number 2026-PT-44821 the deadline is February 28th the county appraised it at 285 thousand but the assessment is 340 thousand the county phone is 312-555-0400 extension 247',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        rrule: null,
        labels: [],
      },
      quality_notes:
        'Title: "File property tax appeal" or similar. ' +
        'Priority: 0 is acceptable (no explicit keyword), but >= 1 would also be reasonable given the legal deadline. ' +
        'due_at should be February 28th. ' +
        'meta_notes MUST preserve: case number (2026-PT-44821), dollar amounts ($285k vs $340k), ' +
        'phone with extension (312-555-0400 ext 247). ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },

  // -------------------------------------------------------------------------
  // Auto-Snooze Variations
  // -------------------------------------------------------------------------

  {
    id: 'enrich-autosnooze-explicit',
    feature: 'enrichment',
    description: 'Explicit auto-snooze in minutes',
    input: {
      text: 'check on the laundry auto-snooze 30 minutes',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 30,
        priority: 0,
        rrule: null,
        meta_notes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Check on the laundry" (auto-snooze phrase removed). ' +
        'auto_snooze_minutes must be exactly 30. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-autosnooze-hours',
    feature: 'enrichment',
    description: 'Auto-snooze specified in hours — must convert to minutes',
    input: {
      text: 'take the dog out every 4 hours snooze every 2 hours starts at 7am',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 120,
        recurrence_mode: null,
        labels: [],
      },
      quality_notes:
        'Title: "Take the dog out" or similar. ' +
        'auto_snooze_minutes must be 120 (2 hours converted to minutes). ' +
        'rrule should reflect "every 4 hours" — likely FREQ=HOURLY;INTERVAL=4 or FREQ=DAILY. ' +
        'due_at should be 7am Chicago time in UTC. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-autosnooze-off',
    feature: 'enrichment',
    description: 'Explicitly disabled auto-snooze — must be 0, not null',
    input: {
      text: 'weekly standup every Monday 9am no auto-snooze high priority',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 5, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 0,
        priority: 3,
        labels: [],
      },
      quality_notes:
        'Title: "Weekly standup" (recurrence/priority/snooze phrases removed). ' +
        'auto_snooze_minutes must be exactly 0 (explicitly disabled, not null). ' +
        'priority must be 3 (high). ' +
        'rrule should be FREQ=WEEKLY;BYDAY=MO. ' +
        'Labels must be an empty array — no explicit label request in input. May match Work project.',
    },
  },

  // -------------------------------------------------------------------------
  // Recurrence Mode
  // -------------------------------------------------------------------------

  {
    id: 'enrich-recurrence-from-completion',
    feature: 'enrichment',
    description: 'Explicit from-completion signal — "start counting from when I actually do it"',
    input: {
      text: 'clean the fish tank every 2 weeks but start counting from when I actually do it',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        recurrence_mode: 'from_completion',
        auto_snooze_minutes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Clean the fish tank" (recurrence phrase removed). ' +
        'recurrence_mode MUST be "from_completion" — "start counting from when I actually do it" is an explicit signal. ' +
        'rrule should be FREQ=WEEKLY;INTERVAL=2 or FREQ=DAILY;INTERVAL=14. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-recurrence-after-finish',
    feature: 'enrichment',
    description: 'From-completion + auto-snooze combination — "after I finish it"',
    input: {
      text: 'mow the lawn every 10 days after I finish it auto-snooze 4 hours',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        recurrence_mode: 'from_completion',
        auto_snooze_minutes: 240,
        labels: [],
      },
      quality_notes:
        'Title: "Mow the lawn" (recurrence/snooze phrases removed). ' +
        'recurrence_mode MUST be "from_completion" — "after I finish it" is explicit. ' +
        'auto_snooze_minutes must be 240 (4 hours). ' +
        'rrule should reflect 10-day interval. ' +
        'Labels must be an empty array — no explicit label request in input. May match Home project.',
    },
  },
  {
    id: 'enrich-recurrence-no-mode',
    feature: 'enrichment',
    description: 'Standard recurrence — no from-completion signal, mode should be null',
    input: {
      text: 'pay rent on the 1st of every month',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        recurrence_mode: null,
        priority: 0,
        auto_snooze_minutes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Pay rent" (recurrence phrase removed). ' +
        'recurrence_mode MUST be null — no from-completion signal present. ' +
        'rrule should be FREQ=MONTHLY;BYMONTHDAY=1. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },

  // -------------------------------------------------------------------------
  // Critical Labels
  // -------------------------------------------------------------------------

  {
    id: 'enrich-critical-explicit',
    feature: 'enrichment',
    description: 'Explicit "critical alert" — labels must include critical',
    input: {
      text: "pick up Ellie's EpiPen before Friday critical alert",
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: ['critical'],
        auto_snooze_minutes: null,
      },
      quality_notes:
        'Title: "Pick up Ellie\'s EpiPen" or similar (date/alert phrase removed). ' +
        'Labels MUST include "critical" — explicit "critical alert" language. ' +
        'due_at should be Friday. ' +
        'Priority should be >= 3 given the medical urgency context.',
    },
  },
  {
    id: 'enrich-critical-false-positive',
    feature: 'enrichment',
    description: 'Emotional urgency without "critical" keyword — must NOT trigger critical label',
    input: {
      text: 'really really important submit the quarterly report by Wednesday end of day',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 5, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_not_include: {
        labels: ['critical'],
        priority: 0,
      },
      quality_notes:
        'Title: "Submit the quarterly report" or similar (urgency phrase removed). ' +
        'Labels must NOT include "critical" — "really really important" is emotional urgency, not a critical alert. ' +
        'Labels should be an empty array — no explicit label request in input. ' +
        'Priority should be 2-3 (importance signal without "urgent" keyword). ' +
        'due_at should be Wednesday EOD. May match Work project.',
    },
  },
  {
    id: 'enrich-critical-non-alert-context',
    feature: 'enrichment',
    description: 'Word "critical" used in non-alert context — must NOT trigger critical label',
    input: {
      text: 'read the critical thinking chapter for philosophy class by Monday',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        labels: [],
      },
      must_not_include: {
        labels: ['critical'],
      },
      quality_notes:
        'Title: "Read the critical thinking chapter" or similar. ' +
        'Labels must NOT include "critical" — "critical thinking" is an academic concept, not an alert. ' +
        'Labels must be an empty array — no explicit label request in input. ' +
        'Priority should be 0 (no urgency signal). due_at should be Monday.',
    },
  },

  // -------------------------------------------------------------------------
  // Complex Combinations
  // -------------------------------------------------------------------------

  {
    id: 'enrich-combo-wall-snooze-recurrence',
    feature: 'enrichment',
    description: 'Wall-of-text + auto-snooze + from-completion recurrence',
    input: {
      text: "flush the water heater it's an AO Smith GCR-50 model need to do this every 3 months from the last time I actually did it auto-snooze 2 hours and there are specific steps you gotta close the cold water valve first then connect a hose to the drain valve",
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 120,
        recurrence_mode: 'from_completion',
        labels: [],
      },
      quality_notes:
        'Title: "Flush the water heater" or similar. ' +
        'auto_snooze_minutes must be 120 (2 hours). ' +
        'recurrence_mode MUST be "from_completion" — "from the last time I actually did it". ' +
        'rrule should reflect 3-month interval. ' +
        'meta_notes MUST preserve: model (AO Smith GCR-50), instructions. ' +
        'Labels must be an empty array — no explicit label request in input. May match Home project.',
    },
  },
  {
    id: 'enrich-combo-critical-urgent-date',
    feature: 'enrichment',
    description: 'Critical + urgent + time-sensitive — all high-signal fields at once',
    input: {
      text: "urgent critical alert refill mom's heart medication prescription number RX-7742190 Walgreens on Main closes at 9pm tonight",
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 4,
        labels: ['critical'],
      },
      quality_notes:
        'Title: "Refill mom\'s heart medication" or similar (urgency/alert phrases removed). ' +
        'Priority MUST be 4 (explicit "urgent"). ' +
        'Labels MUST include "critical" (explicit "critical alert"). ' +
        'due_at should be tonight at 9pm Chicago time in UTC. ' +
        'meta_notes MUST preserve: Rx number (RX-7742190), Walgreens location (on Main).',
    },
  },
  {
    id: 'enrich-combo-full-dictation',
    feature: 'enrichment',
    description:
      'Garbled dictation exercising every new field — priority, project, recurrence, mode, snooze, meta',
    input: {
      text: 'um ok so like the payroll reconciliation needs to happen every two weeks on Friday and uh start counting from when I complete it high priority it goes in the Work project oh and auto-snooze every hour and my ADP login is in the shared drive under HR folder',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 5, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_include: {
        priority: 3,
        auto_snooze_minutes: 60,
        recurrence_mode: 'from_completion',
        labels: [],
      },
      quality_notes:
        'Title: "Payroll reconciliation" (dictation artifacts and metadata removed). ' +
        'Priority must be 3 (explicit "high priority"). ' +
        'auto_snooze_minutes must be 60 (1 hour). ' +
        'recurrence_mode MUST be "from_completion". ' +
        'rrule should be biweekly Friday. project_name should be "Work". ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-combo-garbled-multi-signal',
    feature: 'enrichment',
    description: 'Garbled input with form reference, vague priority, project match',
    input: {
      text: 'HOA meeting is next Wednesday at 7 pm I need to bring that noise complaint form B-12 its kinda important add it to Home',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 3, name: 'Home', shared: false },
      ],
    },
    requirements: {
      must_include: {
        rrule: null,
        auto_snooze_minutes: null,
        labels: [],
      },
      must_not_include: {
        priority: 4,
      },
      quality_notes:
        'Title: "HOA meeting" or similar. ' +
        'due_at should be next Wednesday at 7pm Chicago time in UTC. ' +
        'priority should be 1-2 ("kinda important" is a mild signal, not urgent). ' +
        'project_name should be "Home". ' +
        'meta_notes should preserve: form reference (noise complaint form B-12). ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  {
    id: 'enrich-edge-autosnooze-no-recurrence',
    feature: 'enrichment',
    description: 'Auto-snooze on a non-recurring task — snooze without rrule',
    input: {
      text: 'call the cable company about the bill auto-snooze every hour tomorrow afternoon',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 60,
        rrule: null,
        recurrence_mode: null,
        labels: [],
      },
      quality_notes:
        'Title: "Call the cable company about the bill" or similar. ' +
        'auto_snooze_minutes must be 60 (1 hour). ' +
        'rrule MUST be null — "every hour" is auto-snooze, not recurrence. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-edge-recurrence-mode-no-rrule',
    feature: 'enrichment',
    description: 'From-completion intent without explicit recurrence interval',
    input: {
      text: 'deep clean the oven and when I do it remind me to do it again from when I finish',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        priority: 0,
        auto_snooze_minutes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Deep clean the oven" or similar. ' +
        'The user signals from-completion intent ("from when I finish") but gives no interval. ' +
        'Acceptable outcomes: recurrence_mode="from_completion" with a reasonable default rrule, ' +
        'OR the from-completion intent captured in meta_notes so it is not lost. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
  {
    id: 'enrich-edge-meta-notes-minimal',
    feature: 'enrichment',
    description: 'Simple task with nothing extra — meta_notes must be null',
    input: {
      text: 'buy new socks tomorrow',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        meta_notes: null,
        priority: 0,
        rrule: null,
        auto_snooze_minutes: null,
        labels: [],
      },
      quality_notes:
        'Title: "Buy new socks" (date phrase removed). ' +
        'meta_notes MUST be null — there is no extra context to capture. ' +
        'due_at should be tomorrow. ' +
        'Labels must be an empty array — no explicit label request in input.',
    },
  },
]
