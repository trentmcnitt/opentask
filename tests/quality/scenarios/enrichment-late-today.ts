/**
 * "Today" late in the evening (2026-10-17): at 10:57 PM CDT the local date is
 * still today while UTC has moved on, and the SDK put a "today" task on the
 * next day. Each scenario pins `now` at 10:57 PM local, so the case is tested
 * whatever time the run starts. `resolveTodayLocalDate` moves a "today" /
 * "tonight" target the model dated another day back to today's local date.
 *
 * These are the "golden cases" for the rule: `tests/golden/` plays task-model
 * date rules over days from a task's create body and has no model answer to
 * post-process, so the coverage is these scenarios plus the full post-process
 * test in `tests/behavioral/ai-today-local-date.test.ts`.
 */
import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]
const today = DateTime.now().setZone(TZ).startOf('day')
const todayIso = today.toFormat('yyyy-MM-dd')
const LATE = `${todayIso}T22:57`

export const enrichmentLateTodayScenarios: AITestScenario[] = [
  {
    id: 'enrich-late-today-bare',
    feature: 'enrichment',
    description: 'Real failure: "today" at 10:57 PM must stay on today\'s local date',
    input: { text: 'text Matthew today', timezone: TZ, projects: INBOX, now: LATE },
    requirements: {
      must_include: { on_deck_day: todayIso, due_at: null, deadline_at: null, rrule: null },
      quality_notes:
        'Now is 10:57 PM. "today" with no time puts it on deck for TODAY\'s local date (on_deck_day today, due_at null) — never tomorrow (the UTC date). Title "Text Matthew".',
    },
  },
  {
    id: 'enrich-late-tonight-at-11',
    feature: 'enrichment',
    description: '"tonight at 11pm" said at 10:57 PM → today 11 PM',
    input: { text: 'call mom tonight at 11pm', timezone: TZ, projects: INBOX, now: LATE },
    requirements: {
      must_include: { due_at: `~datetime:${todayIso}T23:00`, deadline_at: null, rrule: null },
      quality_notes: 'Now is 10:57 PM. due_at today at 11:00 PM. Title "Call mom".',
    },
  },
  {
    id: 'enrich-late-tonight-bare',
    feature: 'enrichment',
    description: '"tonight" at 10:57 PM stays tonight',
    input: { text: 'take out the trash tonight', timezone: TZ, projects: INBOX, now: LATE },
    requirements: {
      must_include: { due_at: `~date:${todayIso}`, deadline_at: null, rrule: null },
      quality_notes:
        'Now is 10:57 PM. "tonight" is today: a time later tonight (the sleep time, or the next hour). Never tomorrow. Title "Take out the trash".',
    },
  },
  {
    id: 'enrich-late-today-or-tomorrow-negative',
    feature: 'enrichment',
    description: 'Negative: "today or tomorrow" is a pace, not today',
    input: { text: 'call the vet today or tomorrow', timezone: TZ, projects: INBOX, now: LATE },
    requirements: {
      must_include: { deadline_at: null, rrule: null },
      quality_notes:
        '"today or tomorrow" is pace wording: horizon "days" with no date is best; on deck today or tomorrow is acceptable (the user named both). The "today" rule must not act here (another day is named). Title "Call the vet".',
    },
  },
]
