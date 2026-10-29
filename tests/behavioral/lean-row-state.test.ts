/**
 * The lean row's tint (`src/lib/lean-row-state.ts`): a passed deadline red
 * first, then over target blue, then the faint "later today" blue. Chicago,
 * a 3:00 AM day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { leanRowState } from '@/lib/lean-row-state'

const TZ = 'America/Chicago'
const iso = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const now = DateTime.fromISO('2026-10-28T15:20', { zone: TZ }).toJSDate()
const state = (due: string | null, deadline: string | null, isOverdue = false) =>
  leanRowState(
    { due_at: due && iso(due), deadline_at: deadline && iso(deadline) },
    isOverdue,
    TZ,
    '03:00',
    now,
  )

describe('leanRowState', () => {
  test('a passed deadline is red, and red wins over over-target', () => {
    expect(state(null, '2026-10-28T09:00')).toBe('passed')
    expect(state('2026-10-28T08:00', '2026-10-28T09:00', true)).toBe('passed')
  })

  test('over target is blue', () => {
    expect(state('2026-10-28T13:00', null, true)).toBe('over')
    // Over target outranks a deadline later today.
    expect(state('2026-10-28T13:00', '2026-10-28T21:00', true)).toBe('over')
  })

  test('a target or a deadline later today is the faint "soon"', () => {
    expect(state('2026-10-28T18:00', null)).toBe('soon')
    expect(state(null, '2026-10-28T21:00')).toBe('soon')
    // 1:30 AM is still today's OpenTask day (it ends at 3:00 AM).
    expect(state('2026-10-29T01:30', null)).toBe('soon')
  })

  test('tomorrow, or nothing dated, is plain', () => {
    expect(state('2026-10-29T09:00', null)).toBeNull()
    expect(state(null, '2026-10-29T04:00')).toBeNull()
    expect(state(null, null)).toBeNull()
  })
})
