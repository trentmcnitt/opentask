/**
 * AI enrichment — the past-date guard (dropUnstatedPastDates, 2026-10-16)
 *
 * A target or deadline the model dated before today (the user's local date),
 * when the words state no such day, is dropped. The real failure: grok gave
 * "now that the lease is signed call the landlord" a target a year in the
 * past. A date the words could state (yesterday, a weekday, a month, an
 * ordinal, a numeric date, a year) is left alone, as is a repeating task and
 * anything dated today or later. Also pinned through postProcessTaskDates, the
 * one pipeline production and the quality harness share.
 */

import { describe, test, expect } from 'vitest'
import { dropUnstatedPastDates, postProcessTaskDates } from '@/core/ai/enrichment'
import { buildEnrichmentUserPrompt } from '@/core/ai/prompts'
import type { EnrichmentResult } from '@/core/ai/types'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

function result(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    title: 'Clean title',
    due_at: null,
    deadline_at: null,
    horizon: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: 'test',
    ...overrides,
  }
}

const TZ = 'America/Chicago'
// Fri Oct 16 2026, 2:07 PM Chicago (UTC-5).
const NOW = new Date('2026-10-16T14:07:00-05:00')
const guard = (text: string, overrides: Partial<EnrichmentResult>) =>
  dropUnstatedPastDates(result(overrides), text, TZ, NOW)

describe('a past date the words do not state is dropped', () => {
  test('the grok failure: a target a year in the past', () => {
    const out = guard('now that the lease is signed call the landlord', {
      due_at: '2025-10-16T17:15:00',
    })
    expect(out.due_at).toBeNull()
  })

  test('yesterday, by a day', () => {
    expect(guard('call the plumber', { due_at: '2026-10-15T09:00:00' }).due_at).toBeNull()
  })

  test('a deadline in the past gets the same rule; a valid target beside it stays', () => {
    const out = guard('renew the parking permit', {
      due_at: '2026-10-17T09:00:00',
      deadline_at: '2026-09-30T23:59:00',
    })
    expect(out.deadline_at).toBeNull()
    expect(out.due_at).toBe('2026-10-17T09:00:00')
  })

  test('both at once', () => {
    const out = guard('file the claim', {
      due_at: '2026-10-01T09:00:00',
      deadline_at: '2026-10-02T23:59:00',
    })
    expect(out.due_at).toBeNull()
    expect(out.deadline_at).toBeNull()
  })

  test('a past date-only value is a past date', () => {
    expect(guard('call the bank', { due_at: '2026-10-15' }).due_at).toBeNull()
  })
})

describe('left alone', () => {
  test('today (any time) and later', () => {
    expect(guard('call the bank', { due_at: '2026-10-16T08:00:00' }).due_at).toBe(
      '2026-10-16T08:00:00',
    )
    expect(guard('call the bank', { due_at: '2026-10-20T09:00:00' }).due_at).toBe(
      '2026-10-20T09:00:00',
    )
  })

  test('the words could state a past day', () => {
    const past = { due_at: '2026-10-15T09:00:00', deadline_at: '2026-10-15T23:59:00' }
    for (const text of [
      'I was supposed to call the bank yesterday',
      'follow up on the email from 3 days ago',
      'send the notes from last Tuesday',
      'the coupon expired Monday',
      'the deadline was Oct 15',
      'pay the invoice due the 15th',
      'return the form dated 10/15',
      'resubmit the 2025 tax form',
      'this past weekend I forgot to water the plants',
    ]) {
      const out = guard(text, past)
      expect(out.due_at, text).toBe(past.due_at)
      expect(out.deadline_at, text).toBe(past.deadline_at)
    }
  })

  test("a repeating task: its first date is the rule's", () => {
    expect(
      guard('pay rent monthly', { due_at: '2026-10-01T09:00:00', rrule: 'FREQ=MONTHLY' }).due_at,
    ).toBe('2026-10-01T09:00:00')
  })

  test('nulls and unparseable values pass through', () => {
    expect(guard('call the bank', {})).toEqual(result({}))
    expect(guard('call the bank', { due_at: 'not a date' }).due_at).toBe('not a date')
  })
})

describe('the prompt names the year', () => {
  test('"Current local time" carries it, so a model cannot assume its training year', () => {
    const prompt = buildEnrichmentUserPrompt({
      dayStart: CALENDAR_DAY_START,
      timezone: TZ,
      morningTime: '09:00',
      wakeTime: '07:00',
      sleepTime: '22:00',
      projects: [{ id: 1, name: 'Inbox' }],
      taskText: 'call the dentist tomorrow morning',
      now: NOW,
    })
    expect(prompt).toContain('Current local time: Fri, Oct 16, 2026, 2:07 PM')
  })
})

describe('in the shared pipeline (postProcessTaskDates)', () => {
  const run = (text: string, overrides: Partial<EnrichmentResult>) =>
    postProcessTaskDates(result(overrides), text, TZ, {
      dayStart: CALENDAR_DAY_START,
      morningTime: '09:00',
      todayTarget: '2026-10-16T19:30:00.000Z',
      now: NOW,
    })

  test('the grok failure ends with no target', () => {
    expect(
      run('now that the lease is signed call the landlord', { due_at: '2025-10-16T17:15:00' })
        .due_at,
    ).toBeNull()
  })

  test('a bare time is moved forward first, so it is never dropped', () => {
    // resolveBareTime runs before the guard and gives the next 7 PM.
    expect(run('call mom 7pm', { due_at: '2025-10-16T19:00:00' }).due_at).toBe(
      '2026-10-16T19:00:00',
    )
  })

  test('"right now" is recomputed first, so a stale year never reaches the guard', () => {
    expect(run('call the landlord right now', { due_at: '2025-10-16T14:07:00' }).due_at).toBe(
      '2026-10-16T14:30:00',
    )
  })

  test('a stated month and day in a past year is still rolled forward, not dropped', () => {
    const out = run('the deadline is February 28th', {
      deadline_at: '2026-02-28T23:59:00',
    })
    expect(out.deadline_at).toBe('2027-02-28T23:59:00')
  })
})
