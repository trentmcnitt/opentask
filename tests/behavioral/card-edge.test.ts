/**
 * Card v2's left edge (`src/lib/card-edge.ts`): a passed deadline red first,
 * then over target blue, and no edge for anything else — a target later
 * today and a deadline's safety net included. Chicago.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { cardEdge } from '@/lib/card-edge'

const TZ = 'America/Chicago'
const iso = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const now = DateTime.fromISO('2026-10-29T10:07', { zone: TZ }).toJSDate()
const edge = (deadline: string | null, isOverdue = false) =>
  cardEdge({ deadline_at: deadline && iso(deadline) }, isOverdue, now)

describe('cardEdge', () => {
  test('a passed deadline is red, and red beats over target', () => {
    expect(edge('2026-10-28T17:00')).toBe('passed')
    expect(edge('2026-10-29T09:00', true)).toBe('passed')
  })

  test('over target is blue', () => {
    expect(edge(null, true)).toBe('over')
    expect(edge('2026-10-31T17:00', true)).toBe('over')
  })

  test('no edge for a row later today or in a deadline safety net', () => {
    // A target later today, not yet over: no edge (the pale edge was skipped).
    expect(edge(null, false)).toBeNull()
    // A deadline later today with no target (in the safety net): no edge.
    expect(edge('2026-10-29T17:00', false)).toBeNull()
    // A deadline tomorrow (the safety net's day before): no edge.
    expect(edge('2026-10-30T12:00', false)).toBeNull()
  })
})
