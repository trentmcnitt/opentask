/**
 * Time slots (REDESIGN-V03 §6.0)
 *
 * Life-moment containers — "Early morning", "Before work", "Evening" — that
 * items are grouped into by their time of day. Shared infrastructure: the
 * dashboard (§7.3) and the Reminders surface (§6) group by this SAME table, so
 * "morning" means one thing in the app rather than two that drift apart.
 *
 * NAMING GUARD (§6.0): this is a **time slot**, never a "bucket". `bucket`
 * already names the due-date classifier in `useFilterState.ts` /
 * `DueDateFilterBar.tsx` (overdue / today / this-week). Reusing the word would
 * silently attach new behavior to an existing concept.
 *
 * The default boundaries are not invented — they are the clusters the user's
 * corpus already schedules against, so slots emerge from real data. Labels and
 * boundaries are user-editable.
 */

import { getDb } from '@/core/db'
import { ValidationError } from '@/core/errors'
import { utcToLocal } from '@/core/recurrence'

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

export function listTimeSlots(userId: number): TimeSlot[] {
  return getDb()
    .prepare('SELECT * FROM time_slots WHERE user_id = ? ORDER BY start_time')
    .all(userId) as TimeSlot[]
}

/**
 * Install the default slots for a user. Idempotent — a user who already has
 * slots keeps them, so this can be called at login or on startup without
 * clobbering customised boundaries.
 */
export function seedDefaultTimeSlots(userId: number): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT COUNT(*) as c FROM time_slots WHERE user_id = ?')
    .get(userId) as { c: number }
  if (existing.c > 0) return

  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  DEFAULT_TIME_SLOTS.forEach((slot, index) => {
    insert.run(userId, slot.label, slot.start_time, index)
  })
}

export function createTimeSlot(
  userId: number,
  label: string,
  startTime: string,
  sortOrder = 0,
): TimeSlot {
  if (parseHHMM(startTime) === null) {
    throw new ValidationError(`Invalid start_time "${startTime}" — expected HH:MM`)
  }
  const db = getDb()
  const res = db
    .prepare('INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)')
    .run(userId, label, startTime, sortOrder)
  return db
    .prepare('SELECT * FROM time_slots WHERE id = ?')
    .get(res.lastInsertRowid as number) as TimeSlot
}

export function deleteTimeSlot(userId: number, slotId: number): boolean {
  return (
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ? AND id = ?').run(userId, slotId)
      .changes > 0
  )
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

  const local = utcToLocal(item.due_at, timezone)
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
