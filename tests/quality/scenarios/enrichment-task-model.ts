/**
 * Task model enrichment scenarios (2026-10-10)
 *
 * The task model split the old single `due_at` into three fields
 * (docs/TASK-MODEL.md § Deadline, target, horizon):
 * - `due_at` is the TARGET — the day the user said to do it;
 * - `deadline_at` is a real cutoff, set ONLY from stated cutoff wording;
 * - `horizon` is the pace, set ONLY from stated pace wording.
 *
 * An AI-guessed deadline is worse than an AI-guessed date (it caps snoozing),
 * and a horizon from topic breaks Trent's 09-28 "no inference from topic"
 * ruling. These scenarios cover both directions: the wording that must set a
 * field, and the tempting wording that must not.
 *
 * Dates are computed relative to the run (America/Chicago), so the text names
 * a day a fixed distance ahead and `~date:` checks the day the model chose.
 * Layer 1 sees the model's LOCAL datetimes (before UTC conversion), after the
 * production deadline/horizon guard (`sanitizeTaskModelFields`).
 */

import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

const today = DateTime.now().setZone(TZ).startOf('day')
const day = (n: number) => today.plus({ days: n })
/** "Oct 17" */
const monthDay = (n: number) => day(n).toFormat('LLL d')
/** "Wednesday" — always within the coming week, so it names exactly one day. */
const weekday = (n: number) => day(n).toFormat('cccc')
/** "13th" */
const ordinal = (n: number) => {
  const d = day(n).day
  const suffix =
    d % 10 === 1 && d !== 11
      ? 'st'
      : d % 10 === 2 && d !== 12
        ? 'nd'
        : d % 10 === 3 && d !== 13
          ? 'rd'
          : 'th'
  return `${d}${suffix}`
}
const iso = (n: number) => `~date:${day(n).toFormat('yyyy-MM-dd')}`

export const enrichmentTaskModelScenarios: AITestScenario[] = [
  // ---------------------------------------------------------------------------
  // Explicit deadlines
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm-deadline-only',
    feature: 'enrichment',
    description: 'Explicit cutoff with no day to do it → deadline only, no target',
    input: {
      text: `cancel M365 by ${monthDay(7)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(7),
        due_at: null,
        horizon: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        `"by ${monthDay(7)}" is a cutoff → deadline_at on ${monthDay(7)} at the END of the day (T23:59:00 or very close). ` +
        'due_at MUST be null — the user named no day to do it, and the app nags from the deadline on its own. ' +
        'horizon null (no pace wording). Title "Cancel M365" (date phrase removed).',
    },
  },
  {
    id: 'enrich-tm-deadline-and-target',
    feature: 'enrichment',
    description: 'Quick capture: a cutoff AND a separate day to do it → both fields',
    input: {
      text: `Cancel M365 by ${monthDay(7)}, do it ${weekday(4)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(7),
        due_at: iso(4),
        horizon: null,
        labels: [],
      },
      quality_notes:
        `deadline_at = ${monthDay(7)}, end of day. due_at (the target) = the coming ${weekday(4)} at the default task time (9:00 AM). ` +
        'Both must be set, and they must not be swapped. Title "Cancel M365" with both date phrases removed.',
    },
  },
  {
    id: 'enrich-tm-voucher-expires',
    feature: 'enrichment',
    description: 'Voucher "expires the 13th" → deadline (Trent\'s own example)',
    input: {
      text: `use the restaurant voucher before it expires on the ${ordinal(3)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(3),
        due_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `"expires on the ${ordinal(3)}" is the cutoff → deadline_at on ${monthDay(3)}, end of day (the voucher is good through that day). ` +
        'due_at null — no day to use it was named. Title "Use the restaurant voucher" or similar.',
    },
  },
  {
    id: 'enrich-tm-deadline-with-time',
    feature: 'enrichment',
    description: 'Client deadline with a stated time keeps that time',
    input: {
      text: `send the mockups, they're due to the client ${weekday(5)} at 10am`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(5),
        horizon: null,
        labels: [],
      },
      quality_notes:
        `deadline_at = the coming ${weekday(5)} at 10:00 AM local (T10:00:00) — a stated time is kept, not moved to end of day. ` +
        'due_at should be null (no day to do it was named); a target at or before the deadline is a minor deviation, a target AFTER it is wrong. ' +
        'Title "Send the mockups" or similar; "to the client" may stay in the title or go to notes.',
    },
  },
  {
    id: 'enrich-tm-end-of-month',
    feature: 'enrichment',
    description: '"by the end of the month" is a cutoff, not a pace',
    input: {
      text: 'pay the contractor by the end of the month',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: `~date:${today.endOf('month').toFormat('yyyy-MM-dd')}`,
        horizon: null,
        due_at: null,
        labels: [],
      },
      quality_notes:
        `deadline_at = the last day of this month (${today.endOf('month').toFormat('LLL d')}), end of day. ` +
        'horizon MUST be null — "by the end of the month" is a cutoff, not "sometime this month". Title "Pay the contractor".',
    },
  },

  {
    id: 'enrich-tm-target-today-latest-tomorrow',
    feature: 'enrichment',
    description:
      'Quick capture: "today, latest tomorrow 10 AM" → target today AND deadline tomorrow 10 AM',
    input: {
      text: 'text Matthew today, latest tomorrow 10 AM',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(0),
        deadline_at: iso(1),
        horizon: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        '"today" with no time is when to do it → due_at today, placed by the app like the Target today button: the next ' +
        'period start, or the top of the next hour — NEVER the current minute (that is instantly over target). ' +
        '(A run after ~11 PM may land on midnight — minor.) ' +
        '"latest tomorrow 10 AM" is the cutoff → deadline_at tomorrow at 10:00 AM local (T10:00:00), not end of day. ' +
        'The target must not fall after the deadline. Title "Text Matthew" (both date phrases removed).',
    },
  },
  {
    id: 'enrich-tm-do-it-today',
    feature: 'enrichment',
    description: '"do it today" with no time → target today, placed like Target today (not now)',
    input: {
      text: 'call the pharmacy about the refill, do it today',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(0),
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        'due_at today, at the next period start or the top of the next hour (the app places a bare "today"), never the ' +
        'current minute and never a time already past. deadline_at null ("do it today" is a target, not a cutoff). ' +
        'Title "Call the pharmacy about the refill". (A run after ~11 PM may land on midnight — minor.)',
    },
  },
  {
    id: 'enrich-tm-today-at-time',
    feature: 'enrichment',
    description: 'A stated time today stays as stated',
    input: {
      text: 'water the tomatoes today at 11:45pm',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(0),
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        'due_at today at 11:45 PM local (T23:45:00) — a stated time is kept exactly, not moved to a period or the next hour. ' +
        'deadline_at null. Title "Water the tomatoes".',
    },
  },
  {
    id: 'enrich-tm-at-the-latest',
    feature: 'enrichment',
    description: '"<day> at the latest" is a cutoff → deadline only, no target',
    input: {
      text: `return the library books ${weekday(4)} at the latest`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(4),
        due_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `"${weekday(4)} at the latest" is a cutoff → deadline_at the coming ${weekday(4)}, end of day (T23:59:00). ` +
        'due_at MUST be null — no day to do it was named, only the latest day. Title "Return the library books".',
    },
  },
  {
    id: 'enrich-tm-good-through',
    feature: 'enrichment',
    description: '"good through the 20th" is a cutoff → deadline only',
    input: {
      text: `use the bookstore gift card, it's good through the ${ordinal(9)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(9),
        due_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `"good through the ${ordinal(9)}" means usable through that day → deadline_at ${monthDay(9)}, end of day. ` +
        'due_at null (no day to use it was named). Title "Use the bookstore gift card"; the validity phrase may go to notes or be dropped.',
    },
  },
  {
    id: 'enrich-tm-pace-and-deadline',
    feature: 'enrichment',
    description: 'Pace wording AND a cutoff in one line → horizon and deadline, no target',
    input: {
      text: `sometime this week give Dana a heads-up about the schedule change, it needs to happen by ${weekday(5)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: 'weeks',
        deadline_at: iso(5),
        due_at: null,
        labels: [],
      },
      quality_notes:
        `"sometime this week" is a pace → horizon weeks. "by ${weekday(5)}" is the cutoff → deadline_at the coming ${weekday(5)}, end of day. ` +
        'due_at MUST be null — neither phrase names a day to do it. Title "Give Dana a heads-up about the schedule change".',
    },
  },

  // ---------------------------------------------------------------------------
  // A date that is a target, not a deadline
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm-do-it-day-is-target',
    feature: 'enrichment',
    description: '"do it Saturday" is a target — no deadline',
    input: {
      text: `clean out the car, do it ${weekday(3)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(3),
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `due_at = the coming ${weekday(3)} at the default task time. deadline_at MUST be null — the day says when to do it, not when it must be done by. ` +
        'Title "Clean out the car".',
    },
  },
  {
    id: 'enrich-tm-remind-me-is-target',
    feature: 'enrichment',
    description: '"remind me Thursday at 9" is a target — no deadline',
    input: {
      text: `remind me ${weekday(2)} at 9 to call the vet about the vaccine records`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(2),
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `due_at = the coming ${weekday(2)} at 9:00 AM. deadline_at null, horizon null. ` +
        'Title "Call the vet about the vaccine records" (the "remind me" scaffolding removed).',
    },
  },
  {
    id: 'enrich-tm-urgent-is-not-deadline',
    feature: 'enrichment',
    description: 'Urgency without a cutoff sets priority only, never a deadline',
    input: {
      text: 'urgent call the bank about the fraud alert on my card',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        priority: 4,
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        'priority 4 ("urgent"). deadline_at MUST be null — urgency is not a stated cutoff. horizon null — "urgent" is a priority word, not a pace. ' +
        'due_at null is preferred (no day named). Title "Call the bank about the fraud alert on my card".',
    },
  },
  {
    id: 'enrich-tm-recurring-cutoff',
    feature: 'enrichment',
    description: 'A cutoff on a recurring task stays in due_at; no deadline or horizon',
    input: {
      text: 'submit my timesheet every Friday by 5pm',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        'rrule FREQ=WEEKLY;BYDAY=FR. due_at = the coming Friday at 5:00 PM (the cutoff becomes the recurring time). ' +
        'deadline_at and horizon MUST be null for a recurring task (the production guard also enforces this). Title "Submit my timesheet".',
    },
  },

  // ---------------------------------------------------------------------------
  // Pace wording → horizon
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm-pace-month',
    feature: 'enrichment',
    description: '"sometime this month" → horizon months',
    input: {
      text: 'sometime this month I should reorganize the pantry',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: 'months',
        due_at: null,
        deadline_at: null,
        labels: [],
      },
      quality_notes:
        'horizon months. due_at and deadline_at null — a pace is neither a day nor a cutoff. ' +
        'Title "Reorganize the pantry" (pace phrase and "I should" removed).',
    },
  },
  {
    id: 'enrich-tm-pace-week',
    feature: 'enrichment',
    description: '"this week" → horizon weeks',
    input: {
      text: 'call the plumber about the water heater this week',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: 'weeks',
        deadline_at: null,
        labels: [],
      },
      quality_notes:
        'horizon weeks. deadline_at null ("this week" is a pace, not a stated cutoff). ' +
        'due_at null preferred — no day was named; a target set to a day this week is a minor deviation. ' +
        'Title "Call the plumber about the water heater".',
    },
  },
  {
    id: 'enrich-tm-pace-days',
    feature: 'enrichment',
    description: '"in the next few days" → horizon days',
    input: {
      text: 'um in the next few days get the car washed',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: 'days',
        due_at: null,
        deadline_at: null,
        labels: [],
      },
      quality_notes:
        'horizon days. due_at and deadline_at null. Title "Get the car washed" (dictation filler and pace phrase removed).',
    },
  },
  {
    id: 'enrich-tm-pace-eventually',
    feature: 'enrichment',
    description: '"someday" → horizon eventually',
    input: {
      text: 'someday I want to learn to play the banjo',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: 'eventually',
        due_at: null,
        deadline_at: null,
        priority: 0,
        labels: [],
      },
      quality_notes:
        'horizon eventually. No dates. Priority 0 ("someday" is pace, not a priority signal). ' +
        'Title "Learn to play the banjo" or keeps "I want to" — the user\'s voice is fine either way.',
    },
  },

  // ---------------------------------------------------------------------------
  // No pace wording → horizon null (including topics that tempt one)
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm-no-pace-plain',
    feature: 'enrichment',
    description: 'Plain task with no pace or cutoff wording → horizon and deadline null',
    input: {
      text: 'buy a new phone charger',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: null,
        deadline_at: null,
        due_at: null,
        priority: 0,
        labels: [],
      },
      quality_notes: 'Everything null/empty except the title. Title "Buy a new phone charger".',
    },
  },
  {
    id: 'enrich-tm-topic-tempts-eventually',
    feature: 'enrichment',
    description: 'A low-stakes home repair tempts "eventually" — must stay null',
    input: {
      text: 'fix the squeaky hinge on the back door',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: null,
        deadline_at: null,
        due_at: null,
        priority: 0,
        labels: [],
      },
      quality_notes:
        'horizon MUST be null — a squeaky hinge sounds like an "eventually" chore, but the user said nothing about pace. ' +
        'Inference from topic is forbidden. Title unchanged apart from capitalization.',
    },
  },
  {
    id: 'enrich-tm-topic-tempts-deadline',
    feature: 'enrichment',
    description: 'A bill tempts a deadline and a "days" horizon — both must stay null',
    input: {
      text: 'pay the electric bill',
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        horizon: null,
        deadline_at: null,
        due_at: null,
        priority: 0,
        labels: [],
      },
      quality_notes:
        'Bills have due dates in real life, but none was stated: deadline_at MUST be null, horizon MUST be null, due_at null. ' +
        'Title "Pay the electric bill".',
    },
  },

  // ---------------------------------------------------------------------------
  // Target vs deadline wording (spec §8.8, 2026-10-12). A target the AI sets
  // is a PICKED target: it makes the task quiet until its date. A cutoff is a
  // deadline, and the app stores the deadline's AUTOMATIC target itself — so
  // the AI sets a target only from explicit start or time wording.
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm8-by-weekday-is-deadline',
    feature: 'enrichment',
    description: '"by Friday" → deadline; the target is left to the app (auto)',
    input: {
      text: `pay the AT&T card by ${weekday(4)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(4),
        due_at: null,
        horizon: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        `"by ${weekday(4)}" is a cutoff → deadline_at the coming ${weekday(4)}, end of day (T23:59:00). ` +
        'due_at MUST be null: no day to do it was named, and the app sets the automatic target a few days before the deadline. ' +
        'A due_at here (even on or before the deadline) is a failure — it would make the task quiet until that date. ' +
        'Title "Pay the AT&T card" or similar, date phrase removed.',
    },
  },
  {
    id: 'enrich-tm8-due-the-ordinal-is-deadline',
    feature: 'enrichment',
    description: '"due the 23rd" → deadline only, no target',
    input: {
      text: `rebate form is due the ${ordinal(9)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        deadline_at: iso(9),
        due_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `"due the ${ordinal(9)}" is a cutoff → deadline_at ${monthDay(9)}, end of day. due_at MUST be null (the app sets the automatic target). ` +
        'Title "Send the rebate form", "Rebate form" or similar.',
    },
  },
  {
    id: 'enrich-tm8-weekday-at-time-is-target',
    feature: 'enrichment',
    description: '"Thursday at 3" → a target at 3 PM, no deadline',
    input: {
      text: `call the plumber ${weekday(3)} at 3`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(3),
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `due_at = the coming ${weekday(3)} at 3:00 PM local (T15:00:00 — "at 3" for a call is the afternoon). ` +
        'deadline_at MUST be null: a day and time to do it is a target, not a cutoff. Title "Call the plumber".',
    },
  },
  {
    id: 'enrich-tm8-remind-monday-with-due-date',
    feature: 'enrichment',
    description: '"remind me Monday at 3 … it\'s due the 23rd" → target AND deadline',
    input: {
      text: `remind me ${weekday(5)} at 3 to send the invoice, it's due the ${ordinal(9)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        due_at: iso(5),
        deadline_at: iso(9),
        horizon: null,
        labels: [],
      },
      quality_notes:
        `due_at (the target) = the coming ${weekday(5)} at 3:00 PM local; deadline_at = ${monthDay(9)}, end of day. ` +
        'Both must be set and not swapped; the target is before the deadline. Title "Send the invoice".',
    },
  },
]
