import { describe, expect, test } from 'vitest'
import { naturalSlotIndex, type SlotIndexed, type TimeSlot } from '@/lib/time-slot-assign'

/**
 * `naturalSlotIndex` picks the GROUP index the day is naturally in right now —
 * the dashboard Reminders panel's default page, mirroring
 * `RemindersTimeline.naturalSlotIndex` in `ios/OpenTaskWidgets/RemindersWidget.swift`.
 * Unlike `currentSlot`, it always resolves to an index (a pager has to land on
 * something) and it never lands on the trailing un-slotted group by falling
 * back — only by finding nothing slotted at all.
 */
function slot(id: number, label: string, start_time: string): TimeSlot {
  return { id, user_id: 1, label, start_time, sort_order: id, created_at: '2026-01-01T00:00:00Z' }
}

const SLOTS = [
  slot(1, 'Early morning', '07:00'),
  slot(2, 'Morning', '09:00'),
  slot(3, 'Midday', '12:00'),
  slot(4, 'Afternoon', '16:00'),
  slot(5, 'Evening', '20:30'),
]

/** Groups in slot order with the un-slotted bucket last, as `groupBySlot` always produces. */
const GROUPS: SlotIndexed[] = [...SLOTS.map((s) => ({ slot: s })), { slot: null }]

const CHICAGO = 'America/Chicago'

describe('naturalSlotIndex', () => {
  test('NSI-001: mid-window picks the group whose slot started most recently', () => {
    // 10:15 AM Chicago
    expect(naturalSlotIndex(GROUPS, CHICAGO, new Date('2026-09-04T15:15:00Z'))).toBe(1) // Morning
  })

  test('NSI-002: exactly at a boundary belongs to the slot that starts then', () => {
    // 12:00 PM Chicago
    expect(naturalSlotIndex(GROUPS, CHICAGO, new Date('2026-09-04T17:00:00Z'))).toBe(2) // Midday
  })

  test('NSI-003: before the first boundary falls back to the first slotted group, never the trailing un-slotted one', () => {
    // 6:30 AM Chicago — before Early morning starts
    expect(naturalSlotIndex(GROUPS, CHICAGO, new Date('2026-09-04T11:30:00Z'))).toBe(0)
  })

  test('NSI-004: late night stays in the last slot of the day', () => {
    // 11:45 PM Chicago
    expect(naturalSlotIndex(GROUPS, CHICAGO, new Date('2026-09-05T04:45:00Z'))).toBe(4) // Evening
  })

  test('NSI-005: the timezone decides, not the machine clock', () => {
    const at = new Date('2026-09-04T15:15:00Z') // 10:15 Chicago, 16:15 London
    expect(naturalSlotIndex(GROUPS, 'Europe/London', at)).toBe(3) // Afternoon
    expect(naturalSlotIndex(GROUPS, CHICAGO, at)).toBe(1) // Morning
  })

  test('NSI-006: only the un-slotted group exists — nothing slotted to fall back to', () => {
    expect(naturalSlotIndex([{ slot: null }], CHICAGO, new Date('2026-09-04T11:30:00Z'))).toBe(0)
  })

  test('NSI-007: no groups at all yields 0', () => {
    expect(naturalSlotIndex([], CHICAGO)).toBe(0)
  })
})
