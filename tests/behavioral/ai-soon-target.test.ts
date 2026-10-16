/**
 * AI enrichment — "soon today" (resolveSoonTarget, 2026-10-16)
 *
 * The arithmetic of "now" and "in an hour", done in code on the model's local
 * answer:
 * - "now" / "right now" / "immediately" → ~15 minutes out, rounded UP to the
 *   next quarter hour
 * - "in an hour" / "in N hours" → now + N hours, rounded up to the quarter hour
 * - adjust only: a null target stays null; an explicit time or day beside the
 *   cue, a range ("an hour or two"), a repeating task, and a "now" that is not
 *   a time ("now that …", "for now") are left as the model wrote them
 */

import { describe, test, expect } from 'vitest'
import { resolveSoonTarget } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'

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

// Fri Oct 16 2026, Chicago (UTC-5, CDT).
const at = (local: string) => new Date(`${local}-05:00`)
const soon = (
  due_at: string | null,
  text: string,
  now: string,
  extra: Partial<EnrichmentResult> = {},
) => resolveSoonTarget(result({ due_at, ...extra }), text, 'America/Chicago', at(now)).due_at

describe('"now" → about 15 minutes out, rounded up to the quarter hour', () => {
  test('rounds now + 15 minutes up to the next :00/:15/:30/:45', () => {
    const text = 'call the landlord right now'
    expect(soon('2026-10-16T14:07:00', text, '2026-10-16T14:07:00')).toBe('2026-10-16T14:30:00')
    expect(soon('2026-10-16T14:44:00', text, '2026-10-16T14:44:00')).toBe('2026-10-16T15:00:00')
    expect(soon('2026-10-16T14:45:00', text, '2026-10-16T14:45:00')).toBe('2026-10-16T15:00:00')
    expect(soon('2026-10-16T14:46:00', text, '2026-10-16T14:46:00')).toBe('2026-10-16T15:15:00')
    // Seconds don't push it a quarter further: 2:45:40 reads as 2:45.
    expect(soon('2026-10-16T14:45:00', text, '2026-10-16T14:45:40')).toBe('2026-10-16T15:00:00')
  })

  test('near midnight it rolls to tomorrow, even when the model kept today', () => {
    expect(soon('2026-10-16T23:52:00', 'move the car now', '2026-10-16T23:52:00')).toBe(
      '2026-10-17T00:15:00',
    )
  })

  test('"immediately" and a trailing "now" are the same cue', () => {
    expect(soon('2026-10-16T10:01:00', 'fix the leak immediately', '2026-10-16T10:01:00')).toBe(
      '2026-10-16T10:30:00',
    )
    expect(soon('2026-10-16T10:01:00', 'Text Sam back now!', '2026-10-16T10:01:00')).toBe(
      '2026-10-16T10:30:00',
    )
  })
})

describe('"in an hour" → now + N hours, rounded up to the quarter hour', () => {
  test('one hour, and N hours in words or digits', () => {
    expect(soon('2026-10-16T15:07:00', 'check the oven in an hour', '2026-10-16T14:07:00')).toBe(
      '2026-10-16T15:15:00',
    )
    expect(soon('2026-10-16T15:00:00', 'check the oven in an hour', '2026-10-16T14:00:00')).toBe(
      '2026-10-16T15:00:00',
    )
    expect(soon('2026-10-16T17:00:00', 'call back in 3 hours', '2026-10-16T14:20:00')).toBe(
      '2026-10-16T17:30:00',
    )
    expect(soon('2026-10-16T16:00:00', 'call back in two hours', '2026-10-16T14:50:00')).toBe(
      '2026-10-16T17:00:00',
    )
  })

  test('across midnight', () => {
    expect(soon('2026-10-16T00:40:00', 'take the pills in an hour', '2026-10-16T23:40:00')).toBe(
      '2026-10-17T00:45:00',
    )
  })
})

describe('left as the model wrote it', () => {
  test('a null target stays null — the model decides whether "now" is a time', () => {
    expect(soon(null, 'call the landlord right now', '2026-10-16T14:07:00')).toBeNull()
    expect(soon(null, 'check the oven in an hour', '2026-10-16T14:07:00')).toBeNull()
  })

  test('"now" that is not the time to do it', () => {
    const now = '2026-10-16T14:07:00'
    expect(soon('2026-10-16T14:07:00', 'now that the lease is signed, call landlord', now)).toBe(
      '2026-10-16T14:07:00',
    )
    expect(soon('2026-10-17T09:00:00', 'leave it in the inbox for now', now)).toBe(
      '2026-10-17T09:00:00',
    )
    expect(soon('2026-10-17T09:00:00', 'renew the domain, it should be done by now', now)).toBe(
      '2026-10-17T09:00:00',
    )
    expect(soon('2026-10-17T09:00:00', 'snowboard tune up', now)).toBe('2026-10-17T09:00:00')
  })

  test("a range keeps the model's pick when it is a quarter hour inside it", () => {
    const now = '2026-10-16T14:30:00'
    expect(soon('2026-10-16T16:00:00', 'call the bank in an hour or two', now)).toBe(
      '2026-10-16T16:00:00',
    )
    // The short end is the user's too (designer, 2026-10-16: 3:30 or 4:00).
    expect(soon('2026-10-16T15:30:00', 'call the bank in an hour or two', now)).toBe(
      '2026-10-16T15:30:00',
    )
    expect(soon('2026-10-16T17:00:00', 'walk the dog in 2 or 3 hours', now)).toBe(
      '2026-10-16T17:00:00',
    )
    expect(soon('2026-10-16T17:00:00', 'walk the dog in 2-3 hours', now)).toBe(
      '2026-10-16T17:00:00',
    )
  })
})

describe('a range the model missed → the first whole hour inside it', () => {
  test('before the range, off a quarter hour, or after it', () => {
    // At 2:10, "in 2 or 3 hours" is 4:10–5:10; the model said 4:00 (quality run).
    expect(soon('2026-10-16T16:00:00', 'walk the dog in 2 or 3 hours', '2026-10-16T14:10:00')).toBe(
      '2026-10-16T17:00:00',
    )
    expect(
      soon('2026-10-16T14:45:00', 'call the bank in an hour or two', '2026-10-16T14:30:00'),
    ).toBe('2026-10-16T16:00:00')
    expect(
      soon('2026-10-16T16:07:00', 'call the bank in an hour or two', '2026-10-16T14:30:00'),
    ).toBe('2026-10-16T16:00:00')
    expect(soon('2026-10-16T20:00:00', 'water the lawn in 1-2 hrs', '2026-10-16T14:30:00')).toBe(
      '2026-10-16T16:00:00',
    )
  })

  test('near midnight, the date the model kept today rolls to tomorrow', () => {
    expect(
      soon('2026-10-16T01:00:00', 'take the laundry out in an hour or two', '2026-10-16T23:20:00'),
    ).toBe('2026-10-17T01:00:00')
  })

  test('a whole-hour short end is itself a whole hour', () => {
    expect(soon('2026-10-16T14:00:00', 'call back in an hour or two', '2026-10-16T13:00:00')).toBe(
      '2026-10-16T14:00:00',
    )
  })
})

describe('left as the model wrote it (more)', () => {
  test('an explicit time or day beside the cue is never moved', () => {
    const now = '2026-10-16T14:07:00'
    expect(soon('2026-10-16T17:00:00', 'call mom now, or at 5pm at the latest', now)).toBe(
      '2026-10-16T17:00:00',
    )
    expect(soon('2026-10-17T09:00:00', 'tomorrow morning call the vet in an hour', now)).toBe(
      '2026-10-17T09:00:00',
    )
    expect(soon('2026-10-19T09:00:00', 'Monday, right now is too busy, email Kim', now)).toBe(
      '2026-10-19T09:00:00',
    )
    // "now" and "in an hour" together state two times: the model's call.
    expect(
      soon('2026-10-16T15:00:00', 'start the rice right now and check it in an hour', now),
    ).toBe('2026-10-16T15:00:00')
  })

  test('"this" and "next" alone don\'t count as a day', () => {
    expect(soon('2026-10-16T14:07:00', 'do this right now', '2026-10-16T14:07:00')).toBe(
      '2026-10-16T14:30:00',
    )
  })

  test("a repeating task is the rule's business", () => {
    expect(
      soon('2026-10-16T14:07:00', 'start stretching now', '2026-10-16T14:07:00', {
        rrule: 'FREQ=DAILY',
      }),
    ).toBe('2026-10-16T14:07:00')
  })
})
