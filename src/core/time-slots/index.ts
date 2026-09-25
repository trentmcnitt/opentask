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
 * boundaries are user-editable (Settings → Reminder periods; the edit and
 * delete semantics live in `./edit.ts`).
 *
 * HOW EVERYTHING DEPENDS ON SLOTS (investigated 2026-09-24, before slots
 * became editable — read this before changing a slot's shape):
 *
 * - NOTHING STORES A SLOT ID. A reminder (or any item) belongs to a slot only
 *   through its time of day: `assignSlot` picks the slot with the latest
 *   `start_time` <= the item's minutes, where the minutes come from
 *   `anchor_time` (local HH:MM, derived from the rrule's BYHOUR/BYMINUTE), else
 *   the rrule's own BYHOUR/BYMINUTE (`timeOfDay` in reminder-rule.ts), else
 *   `due_at` in the user's zone (a one-time reminder's only carrier). Every
 *   consumer recomputes membership from `start_time` at read time. So moving a
 *   slot's start re-buckets reminders instantly, and deleting a slot drops its
 *   reminders into the previous slot — or out of every slot, if it was the
 *   first. That is why `./edit.ts` moves reminders along with the slot.
 * - "On the boundary" is how reminders normally sit: the reminder editor's
 *   slot chips and the AI enrichment guard (`sanitizeReminderEnrichment`)
 *   both write the slot's exact start into the rule, and `describeTimeOfDay`
 *   shows such a reminder as just the slot's name ("Morning") versus
 *   "Morning, 10:15 AM" for one inside the slot.
 * - Dashboard Today grouping (§7.3, `groupBySlot` in DashboardClient/TaskList
 *   via `useTimeSlots`) groups ALL of today's items, tasks included, by the
 *   same rule. Tasks are not moved when slots change: their due time is a real
 *   time, and they simply regroup.
 * - Reminders surface / widgets: `getRemindersBySlot` groups server-side;
 *   `/api/reminders` hands each group its slot, so the phone Reminders widget
 *   gets new labels/starts with its next timeline reload.
 * - SLOT_REMINDER notifications (`slot-reminders.ts`) fire on the minute a
 *   slot's `start_time` matches the local clock and count that slot's
 *   waiting reminders; the payload carries `slot_id` (transient, for the
 *   content extension's checklist) and `collapseId: slot-<id>`. Hourly nags
 *   (`slot-nags.ts`) use the same grouping and the slots' starts.
 * - Snooze to a slot: `POST /api/tasks/bulk/snooze-overdue` `slot` is a
 *   start_time ("HH:MM") or "next"; the server resolves it with
 *   `nextSlotStart`/`nextPeriodStart`. Any HH:MM is accepted, so a native
 *   client holding a stale start still snoozes — just to the old time.
 *   "Next period" everywhere is `nextPeriodStart` over the current slots.
 * - AI reminder parsing snaps a stated time to the nearest slot start, using
 *   the user's current slots (`buildPromptFor`).
 * - Native caches: `TimeSlotStore` (App Group) is refreshed by
 *   `refreshSlotActions()` on launch AND on every foreground in the iPhone,
 *   watch and Mac apps; the watch Smart Stack widget re-fetches on each
 *   timeline reload; the phone Tasks widget does too (added with this change).
 *   Every slot mutation emits a sync event, which drives the SSE stream (open
 *   web tabs) and the WidgetKit push debouncer (widget timeline reloads).
 * - `sort_order` is vestigial: every reader sorts by `start_time`
 *   (`listTimeSlots`, `groupBySlot`, `TimeSlotStore.cachedSlots`), so there is
 *   no reorder operation — the order IS the times.
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

/**
 * Refuse a start time another of the user's slots already has. Two slots on
 * one boundary would make `assignSlot` pick between them arbitrarily, and the
 * slot notification would fire twice for the same minute.
 */
export function assertStartTimeFree(userId: number, startTime: string, exceptId?: number): void {
  const clash = getDb()
    .prepare('SELECT label FROM time_slots WHERE user_id = ? AND start_time = ? AND id != ?')
    .get(userId, startTime, exceptId ?? -1) as { label: string } | undefined
  if (clash) {
    throw new ValidationError(`"${clash.label}" already starts at ${startTime}`)
  }
}

/**
 * Add a slot. No reminder moves: a new slot never captures a reminder that
 * sits on another slot's boundary (starts are unique), and a reminder already
 * set INSIDE the new slot's range joining it is what adding a period means.
 */
export function createTimeSlot(
  userId: number,
  label: string,
  startTime: string,
  sortOrder = 0,
): TimeSlot {
  if (parseHHMM(startTime) === null) {
    throw new ValidationError(`Invalid start_time "${startTime}" — expected HH:MM`)
  }
  const trimmed = label.trim()
  if (!trimmed) throw new ValidationError('Label is required')
  assertStartTimeFree(userId, startTime)
  label = trimmed
  const db = getDb()
  const res = db
    .prepare('INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)')
    .run(userId, label, startTime, sortOrder)
  return db
    .prepare('SELECT * FROM time_slots WHERE id = ?')
    .get(res.lastInsertRowid as number) as TimeSlot
}
