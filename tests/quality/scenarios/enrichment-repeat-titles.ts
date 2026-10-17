/**
 * Repeat words in titles, and a repeat's first date (2026-10-16).
 *
 * - Repeat wording leaves the title once it is in the rule (the prompt's title
 *   rule; `stripRepeatPhrase` strips a trailing phrase, or a leading time
 *   clause, that says exactly what the rule says). Real misses from Haiku:
 *   "Water the ferns every other day", "Go to the gym twice a week".
 * - A repeat word that is part of a name stays ("Weekly standup").
 * - A repeat made on its day after its time starts at the next occurrence
 *   (`rollPassedRepeatStart` / `rollPassedFirstOccurrence`).
 *
 * `~lacks:` / `~has:` check the title's text; Layer 2 judges the rest.
 */
import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

const today = DateTime.now().setZone(TZ).startOf('day')
const todayAt = (clock: string) => `${today.toFormat('yyyy-MM-dd')}T${clock}`
/** Today's weekday, for a weekly repeat made on its own day ("Friday"). */
const todayName = today.toFormat('cccc')
const inAWeek = today.plus({ days: 7 }).toFormat('yyyy-MM-dd')

const repeat = (
  id: string,
  text: string,
  phrase: string,
  rruleHas: string,
  notes: string,
): AITestScenario => ({
  id,
  feature: 'enrichment',
  description: `Repeat words leave the title: "${text}"`,
  input: { text, timezone: TZ, projects: INBOX },
  requirements: {
    must_include: { title: `~lacks:${phrase}`, rrule: `~rrule-has:${rruleHas}` },
    quality_notes: `${notes} The repeat lives in rrule; the title must not repeat "${phrase}". No deadline, no horizon.`,
  },
})

export const enrichmentRepeatTitleScenarios: AITestScenario[] = [
  repeat(
    'enrich-rtitle-every-other-day',
    'water the ferns every other day',
    'every other day',
    'FREQ=DAILY;INTERVAL=2',
    'Title "Water the ferns".',
  ),
  repeat(
    'enrich-rtitle-twice-a-week',
    'go to the gym twice a week',
    'twice a week',
    'FREQ=WEEKLY',
    'Title "Go to the gym"; the rule is weekly on two days.',
  ),
  repeat(
    'enrich-rtitle-every-monday',
    'take out the recycling every monday',
    'every monday',
    'BYDAY=MO',
    'Title "Take out the recycling".',
  ),
  repeat(
    'enrich-rtitle-daily-at-time',
    'stretch daily at 7am',
    'daily',
    'FREQ=DAILY',
    'Title "Stretch"; 7 AM is the time (due_at / BYHOUR), not in the title either.',
  ),
  repeat(
    'enrich-rtitle-every-weekday-at-time',
    'check email every weekday at 9am',
    'every weekday',
    'BYDAY=MO,TU,WE,TH,FR',
    'Title "Check email"; "at 9am" belongs in the time, not the title.',
  ),
  {
    id: 'enrich-rtitle-name-keeps-weekly',
    feature: 'enrichment',
    description: 'A repeat word that is part of a name stays: "Weekly standup"',
    input: { text: 'weekly standup every Monday 9am', timezone: TZ, projects: INBOX },
    requirements: {
      must_include: {
        title: '~has:weekly',
        rrule: '~rrule-has:BYDAY=MO',
      },
      quality_notes:
        'Title "Weekly standup" — "Weekly" names the meeting and stays; "every Monday 9am" goes. Rule weekly on Monday at 9.',
    },
  },
  {
    id: 'enrich-rtitle-made-after-its-time',
    feature: 'enrichment',
    description: 'A weekly repeat made on its own day after its time starts next week',
    input: {
      text: `submit my timesheet every ${todayName} at 5pm`,
      timezone: TZ,
      projects: INBOX,
      now: todayAt('20:30'),
    },
    requirements: {
      must_include: { due_at: `~date:${inAWeek}`, deadline_at: null },
      quality_notes: `Now is ${todayName} 8:30 PM. Today's 5 PM has passed, so the first occurrence is NEXT ${todayName} at 5 PM (${inAWeek}) — not today (over target at birth). Title "Submit my timesheet".`,
    },
  },
]
