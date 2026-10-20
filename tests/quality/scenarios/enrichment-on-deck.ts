/**
 * ON DECK FROM ENRICHMENT (D3, 2026-10-20; spec rule 11, red team A1/A4/A5).
 * A day with no time puts the task on deck for that day (`on_deck_day`,
 * `due_at` null); a clock time or a part of day is a target; a deadline word
 * is still a deadline, and a deadline plus a day keeps a picked target.
 *
 * Every scenario pins `now` to this week's Monday (2 PM unless it says
 * otherwise), so "Wednesday", "Saturday" and "this weekend" each name one day
 * whatever day the run starts. The harness's rollover is a default user's
 * (7:00 AM), so A4's 00:30 is before it and 23:30 after it.
 */
import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

const monday = DateTime.now().setZone(TZ).startOf('week')
const day = (n: number) => monday.plus({ days: n }).toFormat('yyyy-MM-dd')
/** Monday + n days at a local clock time: "2026-10-19T14:00". */
const at = (n: number, clock: string) => `${day(n)}T${clock}`
const MON_2PM = at(0, '14:00')
const MON = day(0)
const TUE = day(1)
const WED = day(2)
const THU = day(3)
const FRI = day(4)
const SAT = day(5)

const input = (text: string, now = MON_2PM) => ({ text, timezone: TZ, projects: INBOX, now })

export const enrichmentOnDeckScenarios: AITestScenario[] = [
  // -------------------------------------------------------------------------
  // A day with no time → on deck
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-today',
    feature: 'enrichment',
    description: '"today" with no time → on deck today',
    input: input('return the library books today'),
    requirements: {
      must_include: { on_deck_day: MON, due_at: null, deadline_at: null, rrule: null },
      quality_notes:
        'Now is Monday 2 PM. "today" names a day with no time: on deck today (on_deck_day today), due_at null, no deadline. Title "Return the library books".',
    },
  },
  {
    id: 'enrich-deck-tomorrow',
    feature: 'enrichment',
    description: '"tomorrow" with no time → on deck tomorrow',
    input: input('call the insurance company tomorrow'),
    requirements: {
      must_include: { on_deck_day: TUE, due_at: null, deadline_at: null, rrule: null },
      quality_notes:
        'Now is Monday 2 PM. "tomorrow" with no time: on deck Tuesday, due_at null. Title "Call the insurance company".',
    },
  },
  {
    id: 'enrich-deck-saturday',
    feature: 'enrichment',
    description: '"do it Saturday" → on deck Saturday',
    input: input('grab winter gloves, do it Saturday'),
    requirements: {
      must_include: { on_deck_day: SAT, due_at: null, deadline_at: null, horizon: null },
      quality_notes:
        'Now is Monday. "do it Saturday" is the day to do it, with no time: on deck for this Saturday, due_at null. Title "Grab winter gloves".',
    },
  },
  {
    id: 'enrich-deck-this-weekend',
    feature: 'enrichment',
    description: 'A bare "this weekend" decks the check-in Saturday',
    input: input('clean out the garage this weekend'),
    requirements: {
      must_include: { on_deck_day: SAT, due_at: null, deadline_at: null },
      quality_notes:
        'Now is Monday. A bare "this weekend" is a day: on deck for this Saturday (the check-in day). A horizon of days alongside is a minor deviation. Title "Clean out the garage".',
    },
  },

  // -------------------------------------------------------------------------
  // A time or a part of day → target (A5)
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-tomorrow-morning-target',
    feature: 'enrichment',
    description: 'Negative: "tomorrow morning" is a target, not a deck',
    input: input('call the vet tomorrow morning'),
    requirements: {
      must_include: { due_at: `~date:${TUE}`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday 2 PM. "tomorrow morning" names a part of the day → a TARGET: due_at Tuesday in the morning (the default task time, 9:00 AM), on_deck_day null. Title "Call the vet".',
    },
  },
  {
    id: 'enrich-deck-tonight-target',
    feature: 'enrichment',
    description: 'Negative: "tonight" is a target, not a deck',
    input: input('take the recycling out tonight'),
    requirements: {
      must_include: { due_at: `~date:${MON}`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday 2 PM. "tonight" is a time → due_at today in the evening (the sleep time, 10 PM, is typical), on_deck_day null. Title "Take the recycling out".',
    },
  },
  {
    id: 'enrich-deck-this-afternoon-target',
    feature: 'enrichment',
    description: 'Negative: "this afternoon" is a target, not a deck',
    input: input('pick up the dry cleaning this afternoon', at(0, '10:15')),
    requirements: {
      must_include: { due_at: `~date:${MON}`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday 10:15 AM. "this afternoon" → due_at today in the early afternoon (about 1–3 PM), on_deck_day null. Title "Pick up the dry cleaning".',
    },
  },
  {
    id: 'enrich-deck-this-evening-target',
    feature: 'enrichment',
    description: 'Negative: "this evening" is a target, not a deck',
    input: input('call grandma this evening'),
    requirements: {
      must_include: { due_at: `~date:${MON}`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday 2 PM. "this evening" → due_at today in the evening (about 5–8 PM), on_deck_day null. Title "Call grandma".',
    },
  },
  {
    id: 'enrich-deck-stated-time-target',
    feature: 'enrichment',
    description: 'Negative: a day with a stated time is a target',
    input: input('call the plumber Thursday at 2pm'),
    requirements: {
      must_include: { due_at: `~datetime:${THU}T14:00`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday. "Thursday at 2pm" → due_at Thursday 2:00 PM (T14:00:00), on_deck_day null. Title "Call the plumber".',
    },
  },

  // -------------------------------------------------------------------------
  // Paces stay paces
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-sometime-this-weekend-pace',
    feature: 'enrichment',
    description: 'Negative: "sometime this weekend" is a pace (horizon days), not a deck',
    input: input('sometime this weekend wash the car'),
    requirements: {
      must_include: { horizon: 'days', on_deck_day: null, due_at: null, deadline_at: null },
      quality_notes:
        '"sometime this weekend" is pace wording → horizon "days", no date at all (on_deck_day and due_at null). Title "Wash the car".',
    },
  },
  {
    id: 'enrich-deck-next-week-pace',
    feature: 'enrichment',
    description: 'Negative: "next week" is a window (horizon weeks), not a deck',
    input: input('schedule the furnace tune-up next week'),
    requirements: {
      must_include: { horizon: 'weeks', on_deck_day: null, due_at: null, deadline_at: null },
      quality_notes:
        '"next week" names a window, not a day → horizon "weeks", no date (on_deck_day and due_at null). Title "Schedule the furnace tune-up".',
    },
  },

  // -------------------------------------------------------------------------
  // A deadline plus a day keeps a picked target (A1)
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-deadline-and-day-target',
    feature: 'enrichment',
    description: 'A1: "by Friday, do it Wednesday" → target Wednesday + deadline Friday, no deck',
    input: input('send the permit forms by Friday, do it Wednesday'),
    requirements: {
      must_include: {
        due_at: `~date:${WED}`,
        deadline_at: `~date:${FRI}`,
        on_deck_day: null,
        horizon: null,
      },
      quality_notes:
        'Now is Monday. "by Friday" is the cutoff → deadline_at Friday 23:59. "do it Wednesday" is the day to do it; with a deadline it stays a picked TARGET: due_at Wednesday at the default task time (9:00 AM), on_deck_day null. Title "Send the permit forms".',
    },
  },

  // -------------------------------------------------------------------------
  // A4: "tomorrow" between midnight and the rollover is the coming day
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-tomorrow-after-midnight',
    feature: 'enrichment',
    description: 'A4: "tomorrow" said at 00:30 → on deck the calendar today',
    input: input('order the replacement filter tomorrow', at(1, '00:30')),
    requirements: {
      must_include: { on_deck_day: TUE, due_at: null, deadline_at: null },
      quality_notes:
        'Now is 12:30 AM on Tuesday — before the rollover, so the user is still in Monday night. "tomorrow" means the coming day: on deck for Tuesday (the calendar today), due_at null. Title "Order the replacement filter".',
    },
  },
  {
    id: 'enrich-deck-tomorrow-late-evening',
    feature: 'enrichment',
    description: 'A4 negative: "tomorrow" said at 23:30 → on deck the calendar tomorrow',
    input: input('order the replacement filter tomorrow', at(0, '23:30')),
    requirements: {
      must_include: { on_deck_day: TUE, due_at: null, deadline_at: null },
      quality_notes:
        'Now is Monday 11:30 PM. "tomorrow" is Tuesday: on deck Tuesday, due_at null. Title "Order the replacement filter".',
    },
  },

  {
    id: 'enrich-a4-timed-tomorrow-after-midnight',
    feature: 'enrichment',
    description: 'A4 for a target: "tomorrow at 3pm" said at 00:30 → the calendar today at 3 PM',
    input: input('call the dentist tomorrow at 3pm', at(1, '00:30')),
    requirements: {
      must_include: { due_at: `~datetime:${TUE}T15:00`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is 12:30 AM on Tuesday — before the rollover, so the user is still in Monday night. "tomorrow at 3pm" means the coming day: due_at Tuesday 3:00 PM (the calendar today), never Wednesday. A time is a target, not on deck. Title "Call the dentist".',
    },
  },
  {
    id: 'enrich-a4-timed-tomorrow-late-evening',
    feature: 'enrichment',
    description:
      'A4 negative for a target: "tomorrow at 3pm" said at 23:30 → the next calendar day',
    input: input('call the dentist tomorrow at 3pm', at(0, '23:30')),
    requirements: {
      must_include: { due_at: `~datetime:${TUE}T15:00`, on_deck_day: null, deadline_at: null },
      quality_notes:
        'Now is Monday 11:30 PM. "tomorrow at 3pm" is Tuesday 3:00 PM. A time is a target, not on deck. Title "Call the dentist".',
    },
  },

  // -------------------------------------------------------------------------
  // Repeating tasks are unchanged
  // -------------------------------------------------------------------------
  {
    id: 'enrich-deck-repeating-unchanged',
    feature: 'enrichment',
    description: 'Negative: "every Saturday" repeats — never on deck',
    input: input('mow the lawn every Saturday'),
    requirements: {
      must_include: {
        rrule: '~rrule-has:FREQ=WEEKLY;BYDAY=SA',
        on_deck_day: null,
        deadline_at: null,
        horizon: null,
      },
      quality_notes:
        'A weekly repeat on Saturdays: rrule FREQ=WEEKLY;BYDAY=SA, first date this Saturday (due_at Saturday at the default task time is fine), never on deck. Title "Mow the lawn".',
    },
  },
]
