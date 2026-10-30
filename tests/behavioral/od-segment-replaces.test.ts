/**
 * The segment rows' faded buttons (Trent, 2026-10-29, of a weekly repeat
 * targeted for 4 PM: "it has a target already, so decking it or targeting it
 * would remove that"): On deck, On deck tomorrow and Today fade — and ask —
 * when the row already has a target or is on deck. `segmentReplaces`.
 */
import { describe, expect, test } from 'vitest'
import { segmentReplaces } from '@/lib/deck-menu'

const TZ = 'America/Chicago'
const DAY_START = '03:00'
// Thursday 2026-01-15, 10:00 AM in Chicago.
const NOW = new Date('2026-01-15T16:00:00Z')
// Friday 2026-01-16, 4:00 PM in Chicago.
const FRI_4PM = '2026-01-16T22:00:00.000Z'

describe('segmentReplaces', () => {
  test('OD-SR01: a repeat with its occurrence time is faded: a deck or Today moves THIS occurrence', () => {
    const weekly = { due_at: FRI_4PM, rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0' }
    expect(segmentReplaces(weekly, TZ, DAY_START, NOW)).toEqual({
      label: 'this Friday’s 4 PM occurrence',
      deck: 'Moves this Friday’s 4 PM occurrence to the deck',
      today: 'Moves this Friday’s 4 PM target to today',
    })
  })

  test('OD-SR02: a one-off with a target — picked or automatic — is faded', () => {
    const picked = { due_at: '2026-01-16T15:00:00.000Z', rrule: null }
    expect(segmentReplaces(picked, TZ, DAY_START, NOW)).toEqual({
      label: 'target Fri 9 AM',
      deck: 'Replaces target Fri 9 AM',
      today: 'Replaces target Fri 9 AM',
    })
    const automatic = { ...picked, target_auto: true }
    expect(segmentReplaces(automatic, TZ, DAY_START, NOW)?.label).toBe('target Fri 9 AM')
    const halfPast = { due_at: '2026-01-16T15:30:00.000Z', rrule: null }
    expect(segmentReplaces(halfPast, TZ, DAY_START, NOW)?.label).toBe('target Fri 9:30 AM')
  })

  test('OD-SR03: a row on deck is faded: a deck elsewhere, or Today, replaces the deck', () => {
    const decked = { due_at: null, rrule: null, on_deck_day: '2026-01-17' }
    expect(segmentReplaces(decked, TZ, DAY_START, NOW)).toEqual({
      label: 'On deck Sat',
      deck: 'Replaces On deck Sat',
      today: 'Replaces On deck Sat',
    })
  })

  test('OD-SR04: no target and not on deck: nothing to replace', () => {
    expect(segmentReplaces({ due_at: null, rrule: null }, TZ, DAY_START, NOW)).toBeNull()
    expect(
      segmentReplaces({ due_at: null, rrule: 'FREQ=DAILY', on_deck_day: null }, TZ, DAY_START, NOW),
    ).toBeNull()
  })
})
