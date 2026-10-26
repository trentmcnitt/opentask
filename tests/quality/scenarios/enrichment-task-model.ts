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
import type { AITestScenario, EnrichmentInput } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

/**
 * TIME-AGNOSTIC (2026-10-26): every scenario here runs at one pinned moment —
 * a weekday midday — so none passes or fails by when the run happens (a run
 * near midnight placed "today" at 12:00 AM tomorrow; one between midnight
 * and the 3:00 AM rollover read "tomorrow" as the calendar today, A4). The
 * dates below are counted from it, and `pinNow` (end of file) gives each
 * scenario without its own `now` this one. Wed Oct 21 2026, 12:00 PM CDT.
 */
const REF_NOW = '2026-10-21T12:00'
const refNow = DateTime.fromISO(REF_NOW, { zone: TZ })
const today = refNow.startOf('day')
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
/**
 * A time with no day (2026-10-14): its next occurrence from the run's start —
 * today while still ahead, else tomorrow. "~datetime:2026-10-14T19:00".
 */
const nextAt = (hour: number, minute = 0) => {
  let at = refNow.set({ hour, minute, second: 0, millisecond: 0 })
  if (at <= refNow) at = at.plus({ days: 1 })
  return `~datetime:${at.toFormat("yyyy-MM-dd'T'HH:mm")}`
}
/** Which day `nextAt` picked, for the notes. */
const nextDayWord = (hour: number, minute = 0) =>
  nextAt(hour, minute).slice('~datetime:'.length, '~datetime:'.length + 10) ===
  today.toFormat('yyyy-MM-dd')
    ? 'today'
    : 'tomorrow'

/**
 * RELATIVE TARGETS (2026-10-24, plan §5): a user whose periods are Morning
 * 6:30, Afternoon and Evening 8:30 PM — and one whose period names match no
 * part-of-day word (no "Evening"). `target_slot_id` in the output is the
 * 1-based position in the scenario's `slots`.
 */
const RELATIVE_SLOTS = [
  { label: 'Morning', start_time: '06:30' },
  { label: 'Afternoon', start_time: '13:00' },
  { label: 'Evening', start_time: '20:30' },
]
const AM_PM_NIGHT_SLOTS = [
  { label: 'AM', start_time: '07:00' },
  { label: 'PM', start_time: '13:00' },
  { label: 'Night', start_time: '21:00' },
]
/** The next 1st of a month ("rent due the 1st"). */
const nextFirst = today.day === 1 ? today : today.plus({ months: 1 }).startOf('month')
const dayIso = (n: number) => day(n).toFormat('yyyy-MM-dd')

const scenarios: AITestScenario[] = [
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
        on_deck_day: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `deadline_at = ${monthDay(7)}, end of day. due_at (the target) = the coming ${weekday(4)} at the default task time (9:00 AM) — ` +
        'a deadline plus a day keeps a picked target, never on deck (on_deck_day null). ' +
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
        on_deck_day: null,
        horizon: null,
        rrule: null,
        labels: [],
      },
      quality_notes:
        '"today" with no time is when to do it; with a deadline in the words it stays a TARGET, not on deck (on_deck_day null) → due_at today, placed by the app like the Target today button: the next ' +
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
        on_deck_day: iso(0),
        due_at: null,
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        '"do it today" with no time puts it on deck for today (on_deck_day today, due_at null — no reminder time). ' +
        'deadline_at null ("do it today" is a day to do it, not a cutoff). ' +
        'Title "Call the pharmacy about the refill".',
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
    description: '"do it Saturday" is a day to do it (on deck) — no deadline',
    input: {
      text: `clean out the car, do it ${weekday(3)}`,
      timezone: TZ,
      projects: INBOX,
    },
    requirements: {
      must_include: {
        on_deck_day: iso(3),
        due_at: null,
        deadline_at: null,
        horizon: null,
        labels: [],
      },
      quality_notes:
        `On deck for the coming ${weekday(3)} (a day with no time, 2026-10-20): on_deck_day that day, due_at null. deadline_at MUST be null — the day says when to do it, not when it must be done by. ` +
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
  // ---------------------------------------------------------------------------
  // A time with no day (2026-10-14, Trent: "Add Matthew time 8:30am never got
  // converted. It's supposed to actually be at 8:30 am this morning.") — its
  // next occurrence: today while still ahead, otherwise tomorrow.
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-bt-name-and-time',
    feature: 'enrichment',
    description:
      'A time beside a name ("Matthew time 8:30am") is the target, not part of the title',
    input: { text: 'Add Matthew time 8:30am', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: { due_at: nextAt(8, 30), deadline_at: null, horizon: null, rrule: null },
      quality_notes:
        `due_at = ${nextDayWord(8, 30)} at 8:30 AM local (the next 8:30 AM from the current time). ` +
        'The time is when to do it, not part of what is being added. Title "Add Matthew time" — "8:30am" removed. No deadline.',
    },
  },
  {
    id: 'enrich-bt-no-colon',
    feature: 'enrichment',
    description: 'Dictated time with no colon ("830am") and no day → next 8:30 AM',
    input: { text: 'Review the slides 830am', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: { due_at: nextAt(8, 30), deadline_at: null, horizon: null, rrule: null },
      quality_notes: `"830am" is 8:30 AM. due_at = ${nextDayWord(8, 30)} at 8:30 AM local. Title "Review the slides", the time removed.`,
    },
  },
  {
    id: 'enrich-bt-at-3',
    feature: 'enrichment',
    description: '"at 3" with no am/pm and no day → the next 3:00 in waking hours (3 PM)',
    input: { text: 'Call the bank at 3', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: { due_at: nextAt(15), deadline_at: null, horizon: null, rrule: null },
      quality_notes: `"at 3" between 7 AM and 11 PM is 3 PM. due_at = ${nextDayWord(15)} at 3:00 PM local. Title "Call the bank".`,
    },
  },
  {
    id: 'enrich-bt-call-mom-7pm',
    feature: 'enrichment',
    description: '"call mom 7pm" → the next 7 PM',
    input: { text: 'call mom 7pm', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: { due_at: nextAt(19), deadline_at: null, horizon: null, rrule: null },
      quality_notes: `due_at = ${nextDayWord(19)} at 7:00 PM local. Title "Call mom".`,
    },
  },
  {
    id: 'enrich-bt-at-9-tonight',
    feature: 'enrichment',
    description: '"at 9 tonight" names the day → today at 9 PM',
    input: { text: 'at 9 tonight take out the trash', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: {
        due_at: `~datetime:${today.toFormat('yyyy-MM-dd')}T21:00`,
        deadline_at: null,
        horizon: null,
        rrule: null,
      },
      quality_notes:
        '"tonight" names today, and "at 9" tonight is 9 PM: due_at = today at 9:00 PM local. Title "Take out the trash".',
    },
  },
  // Real failure (prod, 2026-10-20): said at 10:58 AM, the model's reasoning
  // said "noon today is still ahead" but its due_at was tomorrow at noon — it
  // wrote due_at before reasoning. Both sides of noon are pinned.
  {
    id: 'enrich-bt-noon-before',
    feature: 'enrichment',
    description: 'Real failure: "at noon" said at 10:58 AM was dated tomorrow noon',
    input: {
      text: 'Order replacement books at noon urgent priority',
      timezone: TZ,
      projects: INBOX,
      now: `${today.toFormat('yyyy-MM-dd')}T10:58`,
    },
    requirements: {
      must_include: {
        due_at: `~datetime:${today.toFormat('yyyy-MM-dd')}T12:00`,
        deadline_at: null,
        horizon: null,
        rrule: null,
        priority: 4,
      },
      quality_notes:
        'Now is 10:58 AM. "at noon" names no day and noon today is still ahead: due_at = TODAY at 12:00 PM local, never tomorrow. "urgent priority" → priority 4 and is removed from the title. Title like "Order replacement books". No deadline.',
    },
  },
  {
    id: 'enrich-bt-noon-after',
    feature: 'enrichment',
    description: '"at noon" said at 12:30 PM → tomorrow at noon',
    input: {
      text: 'Order replacement books at noon urgent priority',
      timezone: TZ,
      projects: INBOX,
      now: `${today.toFormat('yyyy-MM-dd')}T12:30`,
    },
    requirements: {
      must_include: {
        due_at: `~datetime:${day(1).toFormat('yyyy-MM-dd')}T12:00`,
        deadline_at: null,
        horizon: null,
        rrule: null,
        priority: 4,
      },
      quality_notes:
        'Now is 12:30 PM. "at noon" names no day and noon today has passed: due_at = TOMORROW at 12:00 PM local. "urgent priority" → priority 4 and is removed from the title. Title like "Order replacement books". No deadline.',
    },
  },
  // ---------------------------------------------------------------------------
  // Relative targets (2026-10-24): a target counted back from the deadline
  // ---------------------------------------------------------------------------
  {
    id: 'enrich-tm-relative-evening-linked',
    feature: 'enrichment',
    description:
      '"remind me the evening before" with a period named Evening → 1 day, linked to Evening',
    input: {
      text: `submit the permit renewal by ${weekday(4)} 8:30am, remind me the evening before`,
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~datetime:${dayIso(4)}T08:30`,
        target_days_before: 1,
        target_time: '20:30',
        target_slot_id: 3,
        due_at: null,
        on_deck_day: null,
        rrule: null,
        horizon: null,
      },
      quality_notes:
        `deadline_at = the coming ${weekday(4)} (${monthDay(4)}) at 8:30 AM. "remind me the evening before" counts back from it → ` +
        'target_days_before 1, target_period "Evening" (the user\'s word IS a listed period name), so the target is linked to the Evening period ' +
        "(target_slot_id 3, target_time 20:30 — the period's start, not a guessed evening time). The model's own target_time should be null (no clock time " +
        'was said for the reminder; 8:30am is the deadline\'s). due_at null (the app derives it). Title like "Submit the permit renewal".',
    },
  },
  {
    id: 'enrich-tm-relative-evening-custom',
    feature: 'enrichment',
    description: '"the evening before" with periods AM / PM / Night → 1 day, a custom evening time',
    input: {
      text: `submit the permit renewal by ${weekday(4)} 8:30am, remind me the evening before`,
      timezone: TZ,
      projects: INBOX,
      slots: AM_PM_NIGHT_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~datetime:${dayIso(4)}T08:30`,
        target_days_before: 1,
        target_time: '18:00',
        target_slot_id: null,
        due_at: null,
        on_deck_day: null,
      },
      quality_notes:
        `deadline_at = ${monthDay(4)} at 8:30 AM. "the evening before" → target_days_before 1. No period is named Evening, so it is NOT linked ` +
        '(target_slot_id null): the model\'s target_period should be the user\'s word "evening" — never "Night" or "PM" because the time falls there. ' +
        'The code gives "evening" its custom time, 18:00. due_at null. Title like "Submit the permit renewal".',
    },
  },
  {
    id: 'enrich-tm-relative-morning-of',
    feature: 'enrichment',
    description:
      '"due Friday, target the morning of" → 0 days, the Default task time (not the Morning period)',
    input: {
      text: `pay the registration fee, due ${weekday(5)}, target the morning of`,
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~date:${dayIso(5)}`,
        target_days_before: 0,
        target_time: '09:00',
        target_slot_id: null,
        due_at: null,
        on_deck_day: null,
      },
      quality_notes:
        `"due ${weekday(5)}" is the cutoff → deadline_at ${monthDay(5)}, end of day (T23:59). "target the morning of" → target_days_before 0. ` +
        '"Morning" means the Default task time (9:00 AM, custom here) — not the 6:30 Morning period — so target_time 09:00, target_slot_id null. ' +
        'due_at null, no deck. Title like "Pay the registration fee".',
    },
  },
  {
    id: 'enrich-tm-relative-rent-two-days',
    feature: 'enrichment',
    description: '"rent due the 1st, nag me 2 days before" → 2 days, the Default task time',
    input: {
      text: 'rent due the 1st, nag me 2 days before',
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~date:${nextFirst.toFormat('yyyy-MM-dd')}`,
        target_days_before: 2,
        target_time: '09:00',
        target_slot_id: null,
        due_at: null,
        on_deck_day: null,
        auto_snooze_minutes: null,
        rrule: null,
      },
      quality_notes:
        `"due the 1st" → deadline_at ${nextFirst.toFormat('LLL d')}, end of day. "nag me 2 days before" counts back → target_days_before 2, ` +
        'no part of the day → the Default task time (09:00, custom). "nag me" here asks for a reminder, not an interval: auto_snooze_minutes null. ' +
        'No rule (one rent payment was named, not "every month"). Title like "Rent" or "Pay rent".',
    },
  },
  {
    id: 'enrich-tm-relative-clock-time',
    feature: 'enrichment',
    description: '"remind me at 6pm the day before" → 1 day at 18:00, custom',
    input: {
      text: `send the signed lease back by ${weekday(3)}, remind me at 6pm the day before`,
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~date:${dayIso(3)}`,
        target_days_before: 1,
        target_time: '18:00',
        target_slot_id: null,
        due_at: null,
      },
      quality_notes:
        `deadline_at ${monthDay(3)}, end of day. "remind me at 6pm the day before" → target_days_before 1, target_time "18:00" (a clock time ` +
        'the user said for the reminder), custom (target_slot_id null). due_at null. Title like "Send the signed lease back".',
    },
  },
  {
    id: 'enrich-tm-relative-named-day-fixed',
    feature: 'enrichment',
    description:
      'Negative: "by Monday, do it Sunday morning" names a day → a fixed target, no offsets',
    input: {
      text: `book the movers by ${weekday(4)}, do it ${weekday(3)} morning`,
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: `~date:${dayIso(4)}`,
        due_at: `~datetime:${dayIso(3)}T09:00`,
        target_days_before: null,
        target_time: null,
        on_deck_day: null,
      },
      quality_notes:
        `deadline_at ${monthDay(4)}, end of day. "do it ${weekday(3)} morning" names a day and a part of the day → a FIXED target: due_at ` +
        `${monthDay(3)} at the default task time (9:00 AM). It is not counted back from the deadline, so target_days_before / target_time / ` +
        'target_period are all null. Title like "Book the movers".',
    },
  },
  {
    id: 'enrich-tm-relative-no-deadline-birthday',
    feature: 'enrichment',
    description:
      'Negative: "the day before her birthday on the 12th" — an occasion, not a cutoff → no deadline, no offsets',
    input: {
      text: `order flowers the day before her birthday on the ${ordinal(6)}`,
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: null,
        target_days_before: null,
        target_time: null,
      },
      quality_notes:
        `A birthday is an occasion, not a cutoff: deadline_at null, and with no deadline there is nothing to count back from (the three target_* ` +
        `fields null). "the day before her birthday on the ${ordinal(6)}" names a day: ${monthDay(5)} — the date alone, so on_deck_day ${dayIso(5)} ` +
        `(or due_at that day) is right; a target on the ${ordinal(6)} itself, or no date at all, is wrong. Title like "Order flowers" (the birthday may stay ` +
        'in the title or notes).',
    },
  },
  {
    id: 'enrich-tm-relative-repeat-none',
    feature: 'enrichment',
    description:
      'Negative: "every Friday by 5pm, remind me the day before" is a repeat → no offsets',
    input: {
      text: 'every Friday by 5pm submit my timesheet, remind me the day before',
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        rrule: '~notnull',
        deadline_at: null,
        target_days_before: null,
        target_time: null,
      },
      quality_notes:
        'A repeating task: rrule weekly. A repeat never gets the relative fields (all three target_* null) or a deadline (deadline_at null). ' +
        'Either reading of the repeat is acceptable — FREQ=WEEKLY;BYDAY=FR with due_at Friday 5:00 PM and the "remind me the day before" ' +
        'wording kept in notes, or a Thursday reminder — but the reminder wording must not be silently lost. Title like "Submit my timesheet".',
    },
  },
  {
    id: 'enrich-tm-relative-no-date-trip',
    feature: 'enrichment',
    description: 'Negative: "the night before the trip" has no date → no deadline, no offsets',
    input: {
      text: 'pack the chargers, remind me the night before the trip',
      timezone: TZ,
      projects: INBOX,
      slots: RELATIVE_SLOTS,
    },
    requirements: {
      must_include: {
        deadline_at: null,
        target_days_before: null,
        target_time: null,
        due_at: null,
        on_deck_day: null,
      },
      quality_notes:
        'The trip has no date, so there is no deadline and nothing to count back from: deadline_at, due_at, on_deck_day and the three target_* ' +
        'fields all null. "the night before the trip" should stay in the title or the notes, in the user\'s words — an added explanation or advice ("no trip date given", "set a deadline…") is a never-add failure. Title like "Pack the chargers".',
    },
  },
]

/** The pinned moment for every scenario that does not pin its own (`REF_NOW`). */
function pinNow(scenario: AITestScenario): AITestScenario {
  const input = scenario.input as EnrichmentInput
  return { ...scenario, input: { ...input, now: input.now ?? REF_NOW } }
}

export const enrichmentTaskModelScenarios: AITestScenario[] = scenarios.map(pinNow)
