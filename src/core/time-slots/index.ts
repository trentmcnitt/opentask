/**
 * Time slots (REDESIGN-V03 §6.0)
 *
 * Life-moment containers — "Early morning", "Morning", "Evening" — that
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

/**
 * The pure assignment logic lives in `@/lib/time-slot-assign` so the dashboard
 * can group by slot client-side without dragging better-sqlite3 into the
 * browser bundle. Re-exported here so server callers have one import.
 */
export {
  parseHHMM,
  itemTimeOfDayMinutes,
  assignSlot,
  groupBySlot,
  DEFAULT_TIME_SLOTS,
  type TimeSlot,
  type SlottableItem,
} from '@/lib/time-slot-assign'

import { DEFAULT_TIME_SLOTS, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

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
