import { describe, expect, test } from 'vitest'
import { currentSlot, type TimeSlot } from '@/lib/time-slot-assign'

/**
 * `currentSlot` picks the slot whose window contains "now" — the latest
 * `start_time` at or before the current local time. The Reminders surface
 * opens that slot by default and folds the rest behind a header.
 */
function slot(id: number, label: string, start_time: string): TimeSlot {
  return { id, user_id: 1, label, start_time, sort_order: id, created_at: '2026-01-01T00:00:00Z' }
}

const SLOTS = [
  slot(1, 'Early morning', '07:00'),
  slot(2, 'Before work', '09:00'),
  slot(3, 'Midday', '12:00'),
  slot(4, 'Afternoon', '16:00'),
  slot(5, 'Evening', '20:30'),
]

// All times below are America/Chicago; the instants are the UTC equivalents.
const CHICAGO = 'America/Chicago'

describe('currentSlot', () => {
  test('CS-001: mid-window picks the slot that started most recently', () => {
    // 10:15 AM Chicago (CDT, UTC-5)
    expect(currentSlot(SLOTS, CHICAGO, new Date('2026-09-04T15:15:00Z'))?.label).toBe('Before work')
  })

  test('CS-002: exactly at a boundary belongs to the slot that starts then', () => {
    // 12:00 PM Chicago
    expect(currentSlot(SLOTS, CHICAGO, new Date('2026-09-04T17:00:00Z'))?.label).toBe('Midday')
  })

  test('CS-003: before the first slot there is no current slot', () => {
    // 6:30 AM Chicago
    expect(currentSlot(SLOTS, CHICAGO, new Date('2026-09-04T11:30:00Z'))).toBeNull()
  })

  test('CS-004: late night stays in the last slot of the day', () => {
    // 11:45 PM Chicago
    expect(currentSlot(SLOTS, CHICAGO, new Date('2026-09-05T04:45:00Z'))?.label).toBe('Evening')
  })

  test('CS-005: the timezone decides, not the machine clock', () => {
    // 15:15 UTC is 10:15 in Chicago but 4:15 PM in London.
    const at = new Date('2026-09-04T15:15:00Z')
    expect(currentSlot(SLOTS, 'Europe/London', at)?.label).toBe('Afternoon')
    expect(currentSlot(SLOTS, CHICAGO, at)?.label).toBe('Before work')
  })

  test('CS-006: unordered input and a malformed start_time are tolerated', () => {
    const messy = [slot(9, 'Broken', 'noon'), SLOTS[4], SLOTS[0], SLOTS[2]]
    // 1:00 PM Chicago
    expect(currentSlot(messy, CHICAGO, new Date('2026-09-04T18:00:00Z'))?.label).toBe('Midday')
  })

  test('CS-007: no slots at all yields null', () => {
    expect(currentSlot([], CHICAGO)).toBeNull()
  })
})
