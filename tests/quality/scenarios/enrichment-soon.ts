/**
 * Soon today (2026-10-16) — a target counted from now:
 * - "now" / "right now" / "immediately" → about 15 minutes out, rounded UP to
 *   the next quarter hour (never the current minute: that is over target the
 *   moment the task is made)
 * - "in an hour" / "in N hours" → now + N hours, rounded up to the quarter hour
 * - "in an hour or two" / "in 2 or 3 hours" → a whole hour (hh:00) inside the
 *   range — the model picks; a quarter hour inside it is kept, anything else
 *   is replaced in code; Layer 2 prefers the whole hour
 * - a "now" that is not a time ("now that …", "for now") → no target
 *
 * Each scenario pins `now` (today's date at a chosen clock time, America/
 * Chicago), so the prompt, the post-processes and the matchers all read the
 * same minute — and "near midnight" is tested whatever time the run starts.
 * The arithmetic is checked in code (`resolveSoonTarget`); the model still has
 * to see "now" and a range as a time at all.
 */

import { DateTime } from 'luxon'
import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'
const INBOX = [{ id: 1, name: 'Inbox', shared: false }]

/** Today (in the run's Chicago day) at a local clock time: "2026-10-16T14:07". */
const todayAt = (clock: string) => `${DateTime.now().setZone(TZ).toFormat('yyyy-MM-dd')}T${clock}`

const NO_EXTRAS = { deadline_at: null, horizon: null, rrule: null, labels: [] }

export const enrichmentSoonScenarios: AITestScenario[] = [
  {
    id: 'enrich-soon-right-now',
    feature: 'enrichment',
    description:
      '"right now" mid-afternoon → 15 minutes out, rounded up to the quarter (2:07 → 2:30)',
    input: {
      text: 'call the pharmacy right now',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:07'),
    },
    requirements: {
      must_include: { due_at: '~soon', ...NO_EXTRAS },
      quality_notes:
        'Now is 2:07 PM. due_at must be today at 2:30 PM (15 minutes out, rounded UP to the quarter hour) — not 2:07 and not 2:15. ' +
        'Title "Call the pharmacy" (the time phrase removed). No deadline, horizon or labels. Priority: 0, or 3-4 if the model reads "right now" as urgency like "immediately" — either is acceptable; the target is what this scenario tests.',
    },
  },
  {
    id: 'enrich-soon-now-quarter-boundary',
    feature: 'enrichment',
    description: '"now" a minute before a quarter hour (2:44 → 3:00)',
    input: { text: 'text Jordan back now', timezone: TZ, projects: INBOX, now: todayAt('14:44') },
    requirements: {
      must_include: { due_at: '~soon', ...NO_EXTRAS },
      quality_notes:
        'Now is 2:44 PM; +15 minutes is 2:59, rounded up → today 3:00 PM. Title "Text Jordan back".',
    },
  },
  {
    id: 'enrich-soon-now-past-quarter',
    feature: 'enrichment',
    description: '"right now" a minute after a quarter hour (2:46 → 3:15)',
    input: {
      text: 'reply to the plumber right now',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:46'),
    },
    requirements: {
      must_include: { due_at: '~soon', ...NO_EXTRAS },
      quality_notes:
        'Now is 2:46 PM; +15 minutes is 3:01, rounded up → today 3:15 PM. Title "Reply to the plumber".',
    },
  },
  {
    id: 'enrich-soon-right-now-near-midnight',
    feature: 'enrichment',
    description: '"right now" at 11:52 PM → 12:15 AM tomorrow',
    input: {
      text: 'move the car off the street right now',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('23:52'),
    },
    requirements: {
      must_include: { due_at: '~soon', ...NO_EXTRAS },
      quality_notes:
        "Now is 11:52 PM; +15 minutes is 12:07 AM, rounded up → 12:15 AM on TOMORROW's date. " +
        'Title "Move the car off the street". No deadline. Priority 0 or 3-4 ("right now" may read as urgency) is acceptable.',
    },
  },
  {
    id: 'enrich-soon-immediately',
    feature: 'enrichment',
    description: '"immediately" is urgent AND soon today',
    input: {
      text: 'email the contractor immediately',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('09:31'),
    },
    requirements: {
      must_include: { due_at: '~soon', priority: 4, ...NO_EXTRAS },
      quality_notes:
        'Now is 9:31 AM → due_at today 10:00 AM (9:46 rounded up). "immediately" is also an urgent priority word → 4. ' +
        'Title "Email the contractor".',
    },
  },
  {
    id: 'enrich-soon-dictated-like-right-now',
    feature: 'enrichment',
    description: 'Dictated filler around "right now"',
    input: {
      text: 'um I need to call mom like right now',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('09:58'),
    },
    requirements: {
      must_include: { due_at: '~soon', ...NO_EXTRAS },
      quality_notes:
        'Now is 9:58 AM → due_at today 10:15 AM (10:13 rounded up). Title "Call mom" with the filler ("um", "I need to", "like") cleaned. Priority 0 or 3-4 ("right now" may read as urgency) is acceptable.',
    },
  },
  {
    id: 'enrich-soon-in-an-hour',
    feature: 'enrichment',
    description: '"in an hour" → now + 1h, rounded up to the quarter (2:07 → 3:15)',
    input: {
      text: 'check on the bread in an hour',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:07'),
    },
    requirements: {
      must_include: { due_at: '~in-hours:1', ...NO_EXTRAS },
      quality_notes: 'Now is 2:07 PM → due_at today 3:15 PM. Title "Check on the bread".',
    },
  },
  {
    id: 'enrich-soon-in-three-hours-near-midnight',
    feature: 'enrichment',
    description: '"in 3 hours" late in the evening crosses midnight',
    input: {
      text: 'take the next dose in 3 hours',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('21:50'),
    },
    requirements: {
      must_include: { due_at: '~in-hours:3', ...NO_EXTRAS },
      quality_notes:
        'Now is 9:50 PM → +3h is 12:50 AM, rounded up → 1:00 AM on TOMORROW\'s date. Title "Take the next dose". ' +
        'Not a repeat: no rrule, no auto-snooze.',
    },
  },
  {
    id: 'enrich-soon-hour-or-two',
    feature: 'enrichment',
    description: '"in an hour or two" at 2:30 → a whole hour inside 3:30–4:30 (4:00)',
    input: {
      text: 'call the bank back in an hour or two',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:30'),
    },
    requirements: {
      must_include: { due_at: '~hours-range:1-2', ...NO_EXTRAS },
      quality_notes:
        'Now is 2:30 PM. due_at should be today at 4:00 PM — the whole hour inside 3:30–4:30. 3:30 PM is acceptable (the designer accepted either). ' +
        'Anything before 3:30 (e.g. 2:45, "15 minutes") is WRONG — the old behaviour this replaces. Title "Call the bank back". No horizon: a time, not a pace.',
    },
  },
  {
    id: 'enrich-soon-two-or-three-hours',
    feature: 'enrichment',
    description: '"in 2 or 3 hours" at 2:10 → a whole hour inside 4:10–5:10 (5:00)',
    input: {
      text: 'walk the dog in 2 or 3 hours',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:10'),
    },
    requirements: {
      must_include: { due_at: '~hours-range:2-3', ...NO_EXTRAS },
      quality_notes:
        'Now is 2:10 PM. due_at should be today at 5:00 PM (the only whole hour in 4:10–5:10). A quarter hour in the range (4:15, 4:30, 4:45) is a minor miss; ' +
        'outside the range is a fail. Title "Walk the dog". Not a repeat.',
    },
  },
  {
    id: 'enrich-soon-hour-or-two-near-midnight',
    feature: 'enrichment',
    description: '"in an hour or two" at 11:20 PM → 1:00 AM tomorrow',
    input: {
      text: 'take the laundry out of the dryer in an hour or two',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('23:20'),
    },
    requirements: {
      must_include: { due_at: '~hours-range:1-2', ...NO_EXTRAS },
      quality_notes:
        "Now is 11:20 PM. due_at should be 1:00 AM on TOMORROW's date (the whole hour inside 12:20–1:20 AM). " +
        'Today\'s date at 1:00 AM (in the past) is a fail. Title like "Take the laundry out of the dryer".',
    },
  },
  {
    id: 'enrich-soon-now-that-negative',
    feature: 'enrichment',
    description: '"now that …" is a clause, not a time — no target',
    input: {
      text: 'now that the lease is signed, call landlord',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('14:07'),
    },
    requirements: {
      must_include: { due_at: null, ...NO_EXTRAS },
      quality_notes:
        '"now that the lease is signed" is the reason, not a time to do it: due_at MUST be null. ' +
        'Title like "Call landlord"; "the lease is signed" may go in notes or stay in the title. Priority 0.',
    },
  },
  {
    id: 'enrich-soon-for-now-negative',
    feature: 'enrichment',
    description: '"for now" names no time',
    input: {
      text: 'leave the boxes in the garage for now, sort them later',
      timezone: TZ,
      projects: INBOX,
      now: todayAt('11:05'),
    },
    requirements: {
      must_include: { due_at: null, ...NO_EXTRAS },
      quality_notes:
        '"for now" and "later" name no time: due_at null, no horizon. Title keeps the user\'s words, e.g. "Sort the boxes in the garage" or close to the original.',
    },
  },
]
