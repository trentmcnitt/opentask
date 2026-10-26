/**
 * Expanded recurrence pattern scenarios
 *
 * Tests a wider variety of recurrence expressions beyond the basics:
 * weekdays, specific days, biweekly, monthly by date, quarterly,
 * yearly, every other day, twice a week, multi-day complex, hourly.
 */

import type { AITestScenario } from '../types'
import { DEFAULT_DAY_START } from '@/lib/anchor-times'
import { openTaskLocalDay } from '@/lib/opentask-day'

/**
 * A repeat with no day named starts from today (Trent, 2026-10-12): "every 2
 * weeks" said on a Thursday is BYDAY=TH, "every month" said on the 12th is
 * BYMONTHDAY=12 (the last day of a month is -1). Read when the run starts, in
 * the scenarios' zone, like the prompt's own "Current local time". A yearly
 * repeat in a named month with no day is the exception: the 1st ("every year
 * in March" → BYMONTH=3;BYMONTHDAY=1; Trent, 2026-10-13).
 */
// TODAY is the user's OpenTask day ("OpenTask day everywhere" part 2): the
// harness's default user starts the day at 3:00 AM, so a run between midnight
// and 3:00 expects the day before (as `pinUnnamedDay` pins it).
const TODAY = openTaskLocalDay(new Date(), 'America/Chicago', DEFAULT_DAY_START)
const TODAY_BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][TODAY.weekday - 1]
const TODAY_BYMONTHDAY =
  TODAY.day === TODAY.daysInMonth && TODAY.day > 28 ? '-1' : String(TODAY.day)

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
        'due_at should be 9:00 AM local (e.g., T09:00:00, no Z suffix). ' +
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
        'due_at should be 6:00 PM local (e.g., T18:00:00, no Z suffix).',
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
        rrule: `~rrule-has:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${TODAY_BYMONTHDAY}`,
      },
      quality_notes:
        'Title: "File quarterly taxes" (recurrence phrase removed). ' +
        `rrule should be FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${TODAY_BYMONTHDAY} — no date is ` +
        "named, so it repeats on today's day of the month (never a default 1st).",
    },
  },
  {
    id: 'enrich-recurrence-every-2-weeks-no-day',
    feature: 'enrichment',
    description: 'Every 2 weeks with no day named — starts today (BYDAY = today)',
    input: {
      text: 'clean the fish tank every 2 weeks',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: `~rrule-has:FREQ=WEEKLY;INTERVAL=2;BYDAY=${TODAY_BYDAY}`,
      },
      quality_notes:
        'Title: "Clean the fish tank" (recurrence phrase removed). ' +
        `rrule should be FREQ=WEEKLY;INTERVAL=2;BYDAY=${TODAY_BYDAY} — no weekday is named, so ` +
        "it is today's weekday (never a default Monday). due_at null or today; no deadline, " +
        'no horizon.',
    },
  },
  {
    id: 'enrich-recurrence-every-other-week-no-day',
    feature: 'enrichment',
    description: 'Every other week with no day named — starts today (BYDAY = today)',
    input: {
      text: 'take the recycling out every other week',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: `~rrule-has:FREQ=WEEKLY;INTERVAL=2;BYDAY=${TODAY_BYDAY}`,
      },
      quality_notes:
        'Title: "Take the recycling out" or similar (recurrence phrase removed). ' +
        `rrule should be FREQ=WEEKLY;INTERVAL=2;BYDAY=${TODAY_BYDAY} (today's weekday).`,
    },
  },
  {
    id: 'enrich-recurrence-every-month-no-date',
    feature: 'enrichment',
    description: 'Every month with no date named — starts today (BYMONTHDAY = today)',
    input: {
      text: 'review the household budget every month',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: `~rrule-has:FREQ=MONTHLY;BYMONTHDAY=${TODAY_BYMONTHDAY}`,
      },
      quality_notes:
        'Title: "Review the household budget" (recurrence phrase removed). ' +
        `rrule should be FREQ=MONTHLY;BYMONTHDAY=${TODAY_BYMONTHDAY} (today's day of the ` +
        'month, never a default 1st).',
    },
  },
  {
    id: 'enrich-recurrence-yearly',
    feature: 'enrichment',
    description: 'Yearly in a named month with no day — starts on the 1st, not today’s date',
    input: {
      text: 'renew car registration every year in March',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: '~rrule-has:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
      },
      quality_notes:
        'Title: "Renew car registration" (recurrence phrase removed). ' +
        'rrule should be FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1 — March 1st: a month with no day ' +
        "named is the 1st, never March <today's date> (Trent, 2026-10-13). A BYHOUR/BYMINUTE " +
        'may be present. due_at is null after the post-process (the rule gives the first ' +
        'occurrence, the next March 1st); no deadline, no horizon.',
    },
  },
  {
    id: 'enrich-recurrence-yearly-named-day',
    feature: 'enrichment',
    description: 'Yearly on a named month and day — the stated day is kept',
    input: {
      text: 'pay the property tax every year on March 15',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        labels: [],
        rrule: '~rrule-has:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15',
      },
      quality_notes:
        'Title: "Pay the property tax" (recurrence phrase removed). ' +
        'rrule should be FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15 (the stated day, not the 1st and ' +
        "not today's date). A BYHOUR/BYMINUTE may be present. due_at null or the next March 15 " +
        '(2027); no deadline (no cutoff wording), no horizon.',
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
        'due_at should be 10:00 AM local (e.g., T10:00:00, no Z suffix). May match Work project.',
    },
  },
  {
    id: 'enrich-recurrence-hourly',
    feature: 'enrichment',
    description: 'Sub-daily recurrence — must use auto_snooze_minutes, not rrule',
    input: {
      text: 'check the oven every 2 hours starting at noon',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 120,
        labels: [],
      },
      quality_notes:
        'Title: "Check the oven" (recurrence phrase removed). ' +
        'auto_snooze_minutes should be 120 — this is sub-daily recurrence, not rrule. ' +
        'FREQ=HOURLY is not supported; sub-daily intervals use auto_snooze_minutes instead. ' +
        'due_at should be noon local (e.g., T12:00:00, no Z suffix).',
    },
  },
  {
    id: 'enrich-recurrence-byday-matches-due-at',
    feature: 'enrichment',
    description:
      'Weekly recurrence — due_at weekday must match BYDAY (regression: model sometimes picks an adjacent day)',
    input: {
      text: 'weekly newsletter post thursdays 9am',
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
        'Title: "Weekly newsletter post" or similar (recurrence phrase removed). ' +
        'rrule must be FREQ=WEEKLY;BYDAY=TH. ' +
        "CRITICAL: due_at's weekday MUST be Thursday — not Friday, not Wednesday. " +
        'The model must correctly count forward from the Current local time to the NEXT Thursday ' +
        '(which is today if today is Thursday before 9am, else the following Thursday). ' +
        'Time must be 09:00 local (T09:00:00, no Z suffix).',
    },
  },
  // THE NAG, 2026-10-21: the app's word for auto_snooze_minutes is now "nag"
  // ("auto-snooze" before) and moving a target is "defer" ("snooze" before).
  // Users may say either word; the old words stay covered by
  // enrich-recurrence-hourly above and enrich-edge-*'s "auto-snooze 30 minutes".
  {
    id: 'enrich-nag-every-30-minutes',
    feature: 'enrichment',
    description: 'The nag (new word): "nag me every 30 minutes" → auto_snooze_minutes 30, no rrule',
    input: {
      text: 'take the chicken out of the freezer, nag me every 30 minutes',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 30,
        rrule: null,
        labels: [],
      },
      quality_notes:
        '"nag me every 30 minutes" is the nag interval (what the app called auto-snooze): ' +
        'auto_snooze_minutes 30, rrule null. Title "Take the chicken out of the freezer" — the nag phrase ' +
        'leaves the title. No day or time named, so due_at null.',
    },
  },
  {
    id: 'enrich-nag-defer-reminders-hourly',
    feature: 'enrichment',
    description: 'The nag via "defer": "defer reminders every hour" → auto_snooze_minutes 60',
    input: {
      text: 'renew the parking permit tomorrow at 10am, defer reminders every hour',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 60,
        rrule: null,
        due_at: '~notnull',
        labels: [],
      },
      quality_notes:
        '"defer reminders every hour" is the nag interval (the old "snooze every hour"): auto_snooze_minutes 60, ' +
        'rrule null. due_at tomorrow 10:00 local. Title "Renew the parking permit".',
    },
  },
  {
    id: 'enrich-nag-snooze-every-hour',
    feature: 'enrichment',
    description: 'The old word still works: "snooze every hour" → auto_snooze_minutes 60',
    input: {
      text: 'call the pharmacy about the refill at 2pm, snooze every hour',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 60,
        rrule: null,
        due_at: '~notnull',
        labels: [],
      },
      quality_notes:
        '"snooze every hour" (the word before 2026-10-21) still sets the nag: auto_snooze_minutes 60, rrule null. ' +
        'due_at 2:00 PM local (today if still ahead, else tomorrow). Title "Call the pharmacy about the refill".',
    },
  },
  {
    id: 'enrich-nag-off',
    feature: 'enrichment',
    description: 'The nag turned off: "don\'t nag me" → auto_snooze_minutes 0',
    input: {
      text: "pay the water bill friday at 9am, don't nag me",
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: 0,
        rrule: null,
        labels: [],
      },
      quality_notes:
        '"don\'t nag me" turns the nag off: auto_snooze_minutes 0 (not null — the user said it). ' +
        'due_at Friday 9:00 local. No deadline (no cutoff wording). Title "Pay the water bill".',
    },
  },
  {
    id: 'enrich-nag-verb-not-interval',
    feature: 'enrichment',
    description:
      'The bare verbs set nothing: "nag Dave" is the task; "defer it till Monday" is a day',
    input: {
      text: 'nag Dave about the invoice, defer it till monday',
      timezone: 'America/Chicago',
      projects: [{ id: 1, name: 'Inbox', shared: false }],
    },
    requirements: {
      must_include: {
        auto_snooze_minutes: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        '"nag Dave" is the task itself (nagging someone), not the nag interval, and "defer it till monday" names a day ' +
        'with no interval: auto_snooze_minutes null, rrule null. The title keeps the verb: "Nag Dave about the invoice". ' +
        'Monday is the day to do it — a day with no time: due_at the date alone (or on_deck_day Monday after post-processing). ' +
        'No deadline (no cutoff wording).',
    },
  },
]
