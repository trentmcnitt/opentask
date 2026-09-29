/**
 * How the reminder surfaces (the Reminders page, the dashboard's reminders
 * panel and its slot bar) name and key a slot group. One definition, because
 * the key is also what `data-slot-segment` and the widget's `?slot=` deep link
 * carry, so its values ("unslotted", or the slot's id) must not change.
 */
import type { TimeSlot } from '@/lib/time-slot-assign'

/** Stable key for the un-slotted bucket (no anchor_time and no due time). */
export const UNSLOTTED_KEY = 'unslotted'

/** Un-slotted reminders group under this label. */
export const UNSLOTTED_LABEL = 'Anytime'

/** Stable identity for a group across refetches — slot id, or the un-slotted bucket. */
export function slotGroupKey(group: { slot: TimeSlot | null }): string {
  return group.slot ? String(group.slot.id) : UNSLOTTED_KEY
}

/** The name a group shows: its slot's label, or "Anytime". */
export function slotLabel(group: { slot: TimeSlot | null }): string {
  return group.slot?.label ?? UNSLOTTED_LABEL
}
