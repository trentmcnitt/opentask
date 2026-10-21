/**
 * Same-day fixes (2026-10-16) — the enrichment post-process's guards for a
 * target the model dated TODAY (`resolveSameDayPast`) and for a "now" phrase
 * that names no time (`dropNowPhraseTarget`). Both real failures came from
 * claude-haiku-5-5 in API mode on the demo; the negatives pin what the rules
 * must leave alone.
 *
 * These are enrichment cases, not golden timelines: `tests/golden/` plays
 * task-model date rules over days from a task's create body, and has no model
 * answer to post-process. So the "golden cases" for these rules are these
 * scenarios (each pins `now`) plus the unit tests in
 * `tests/behavioral/ai-same-day-fixes.test.ts`.
 */

import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

const today = DateTime.now().setZone(TZ).startOf('day')
/** Today (in the run's Chicago day) at a local clock time: "2026-10-16T19:52". */
const todayAt = (clock: string) => `${today.toFormat('yyyy-MM-dd')}T${clock}`
const tomorrow = today.plus({ days: 1 }).toFormat('yyyy-MM-dd')
/** The next Tuesday strictly after today ("on Tuesday" in the text). */
const nextTuesday = (() => {
  let d = today.plus({ days: 1 })
  while (d.weekday !== 2) d = d.plus({ days: 1 })
  return d.toFormat('yyyy-MM-dd')
})()

export const enrichmentSameDayScenarios: AITestScenario[] = [
  {
    id: 'enrich-sameday-tomorrow-evening',
    feature: 'enrichment',
    description: 'Real failure: "call mom tomorrow evening" at 7:52 PM was dated today 7 PM',
    input: {
      text: 'call mom tomorrow evening',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('19:52'),
    },
    requirements: {
      must_include: {
        due_at: `~date:${tomorrow}`,
        on_deck_day: null,
        deadline_at: null,
        rrule: null,
      },
      quality_notes:
        'Now is 7:52 PM. due_at must be TOMORROW in the evening (about 5–8 PM; 7 PM is typical) — never today. Title "Call mom".',
    },
  },
  {
    id: 'enrich-sameday-evening-passed',
    feature: 'enrichment',
    description: 'A part of day already past today, with no day named, lands tomorrow',
    input: {
      text: 'call mom in the evening',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('20:40'),
    },
    requirements: {
      must_include: { due_at: '~notnull', deadline_at: null, rrule: null },
      quality_notes:
        'Now is 8:40 PM. "in the evening" with no day: a target this evening already passed would be over target at once. Acceptable: tomorrow evening (the code moves a passed time today to tomorrow at the same time), or later this evening (before about 11 PM). A target earlier than 8:40 PM today is a fail. Title "Call mom".',
    },
  },
  {
    id: 'enrich-sameday-now-that-landlord',
    feature: 'enrichment',
    description: 'Real failure: "now that the lease is signed" read as now (7:45 PM at 7:38)',
    input: {
      text: 'now that the lease is signed call the landlord',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('19:38'),
    },
    requirements: {
      must_include: { due_at: null, deadline_at: null, horizon: null, rrule: null },
      quality_notes:
        '"now that the lease is signed" is the reason, not a time: due_at MUST be null. Title like "Call the landlord"; the lease detail may go in notes.',
    },
  },
  {
    id: 'enrich-sameday-tonight-at-7-negative',
    feature: 'enrichment',
    description:
      'Negative: "tonight at 7" said at 8 PM — the user said today; the same-day rule leaves it',
    input: {
      text: 'call mom tonight at 7',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('20:00'),
    },
    requirements: {
      must_include: {
        due_at: `~date:${todayAt('20:00').slice(0, 10)}`,
        deadline_at: null,
        rrule: null,
      },
      quality_notes:
        'Now is 8 PM; the user said "tonight at 7". The target stays TODAY (7 PM as said, already over target — the user\'s own words). Moving it to tomorrow would contradict "tonight". Title "Call mom".',
    },
  },
  {
    id: 'enrich-sameday-tomorrowland-negative',
    feature: 'enrichment',
    description: 'Negative: "Tomorrowland" is a name, not a day',
    input: {
      text: 'buy Tomorrowland tickets',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('10:00'),
    },
    requirements: {
      must_include: { due_at: null, deadline_at: null, horizon: null, rrule: null },
      quality_notes:
        '"Tomorrowland" is the festival: no day, no target. Title "Buy Tomorrowland tickets" (the name kept intact).',
    },
  },
  {
    id: 'enrich-sameday-for-now-with-day-negative',
    feature: 'enrichment',
    description: 'Negative: "for now" beside a real day keeps the day',
    input: {
      text: 'for now park the bathroom remodel, revisit it on Tuesday',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('19:38'),
    },
    requirements: {
      must_include: {
        on_deck_day: `~date:${nextTuesday}`,
        due_at: null,
        deadline_at: null,
        rrule: null,
      },
      quality_notes:
        '"revisit it on Tuesday" names the day with no time: on deck for the coming Tuesday (on_deck_day), due_at null. "for now" names no time and must not produce a target tonight. Title like "Revisit the bathroom remodel".',
    },
  },
]
