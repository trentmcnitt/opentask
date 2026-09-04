/**
 * Time-slot assignment — the pure half (REDESIGN-V03 §6.0)
 *
 * Separated from `@/core/time-slots` because that module imports `getDb`, and
 * the dashboard needs to group by slot on the CLIENT. Importing the core module
 * from a component would drag better-sqlite3 into the browser bundle.
 *
 * NAMING GUARD: this is a **time slot**, never a "bucket" — `bucket` already
 * names the due-date classifier in useFilterState.ts / DueDateFilterBar.tsx.
 */

import { DateTime } from 'luxon'

export interface TimeSlot {
  id: number
  user_id: number
  label: string
  /** HH:MM local */
  start_time: string
  sort_order: number
  created_at: string
}

/** Seeded from the production clusters measured at spec time (§6.0). */
export const DEFAULT_TIME_SLOTS: ReadonlyArray<{ label: string; start_time: string }> = [
  { label: 'Early morning', start_time: '07:00' },
  { label: 'Before work', start_time: '09:00' },
  { label: 'Midday', start_time: '12:00' },
  { label: 'Afternoon', start_time: '16:00' },
  { label: 'Evening', start_time: '20:30' },
]

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseHHMM(value: string): number | null {
  const match = HHMM.exec(value)
  if (!match) return null
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
}

/**
 * The item shape slot assignment needs.
 *
 * `anchor_time` wins over `due_at` because for a recurring item it is the
 * *intended* time of day, and §4.6 establishes that a recurring item's `due_at`
 * cannot be trusted — it only stays fresh while the user keeps sweeping.
 */
export interface SlottableItem {
  anchor_time: string | null
  due_at: string | null
}

/**
 * Resolve an item's local time of day in minutes, or null if it has none.
 *
 * `anchor_time` is already local HH:MM. `due_at` is UTC and must be converted
 * through the user's timezone — reading its UTC hour directly would put a 07:00
 * Chicago task in the afternoon slot.
 */
export function itemTimeOfDayMinutes(item: SlottableItem, timezone: string): number | null {
  if (item.anchor_time) {
    const parsed = parseHHMM(item.anchor_time)
    if (parsed !== null) return parsed
  }
  if (!item.due_at) return null

  const local = DateTime.fromISO(item.due_at, { zone: 'utc' }).setZone(timezone)
  if (!local.isValid) return null
  return local.hour * 60 + local.minute
}

/**
 * Assign an item to a slot.
 *
 * §6.0's rule: the slot with the latest `start_time` less than or equal to the
 * item's time of day. An item earlier than every slot boundary, or with no time
 * of day at all, gets null — those render in the un-slotted group ("Anytime
 * today", §7.3) rather than being silently dropped from the front door.
 */
export function assignSlot(
  item: SlottableItem,
  slots: TimeSlot[],
  timezone: string,
): TimeSlot | null {
  const minutes = itemTimeOfDayMinutes(item, timezone)
  if (minutes === null) return null

  let best: TimeSlot | null = null
  let bestStart = -1
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minutes) continue
    if (start > bestStart) {
      bestStart = start
      best = slot
    }
  }
  return best
}

/**
 * Group items into slots, in slot order, with the un-slotted items last.
 *
 * Empty slots are retained: a slot the user defined is part of how they read
 * their day, and silently omitting it makes the view's shape change based on
 * data rather than on their configuration.
 */
export function groupBySlot<T extends SlottableItem>(
  items: T[],
  slots: TimeSlot[],
  timezone: string,
): { slot: TimeSlot | null; items: T[] }[] {
  const ordered = [...slots].sort(
    (a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0),
  )
  const groups = new Map<number | null, T[]>()
  for (const slot of ordered) groups.set(slot.id, [])
  groups.set(null, [])

  for (const item of items) {
    const slot = assignSlot(item, ordered, timezone)
    groups.get(slot?.id ?? null)!.push(item)
  }

  const result: { slot: TimeSlot | null; items: T[] }[] = ordered.map((slot) => ({
    slot,
    items: groups.get(slot.id)!,
  }))
  result.push({ slot: null, items: groups.get(null)! })
  return result
}

/**
 * The slot the day is "in" right now: the slot with the latest `start_time`
 * at or before the current local time. Before the first slot starts there is
 * no current slot (null) — the day hasn't reached its first moment yet.
 *
 * Used by the Reminders surface to decide which slot opens by default: the
 * user asked for the screen to read as "a handful", and the current slot is
 * the only one whose thoughts are timely. Everything else stays one tap away.
 */
export function currentSlot(
  slots: TimeSlot[],
  timezone: string,
  now: Date = new Date(),
): TimeSlot | null {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const minutes = local.hour * 60 + local.minute
  let best: TimeSlot | null = null
  let bestStart = -1
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minutes) continue
    if (start > bestStart) {
      bestStart = start
      best = slot
    }
  }
  return best
}
