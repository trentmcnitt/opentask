/**
 * Reminders surface queries (REDESIGN-V03 §6)
 *
 * Prompted thoughts — principles and considerations delivered by repetition
 * ("Depressed = Past, Anxious = Future, Present = Peace"). Not actions.
 * Completing one means "I considered it", and that IS its completion.
 *
 * These differ BEHAVIOURALLY from tasks, which is why they get a surface rather
 * than a tag: no debt, no badge, bucket-locked, container-notified. Behaviour
 * enforced by the surface beats behaviour promised by discipline.
 *
 * WHAT MAKES A REMINDER "CURRENT TODAY": exactly the §4.6 schedule derivation,
 * not `due_at` freshness. A missed reminder therefore resets naturally at its
 * next occurrence — there is no roll-forward job and no accumulated
 * "overdue by N days" state, ever. That absence of debt is the whole point.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { todaysOccurrence } from '@/core/recurrence/occurrence'
import { groupBySlot, listTimeSlots, type TimeSlot } from '@/core/time-slots'
import type { Task } from '@/types'
import { getTasks, getTaskById } from './create'

export interface ReminderGroup {
  slot: TimeSlot | null
  /** Still waiting to be considered today, highest priority first. */
  reminders: Task[]
  /**
   * Considered today in this slot. Feeds the per-slot and per-day progress —
   * the one score this surface keeps, because it only ever counts what the
   * user DID (L1: absence is never a signal; a bar that filled with misses
   * would be reading intent from what he didn't do).
   */
  considered: number
}

/**
 * Every reminder for a user that is scheduled for today and not yet done.
 *
 * "Only incomplete items" is deliberate (§6): a completed reminder drops out of
 * its bucket rather than sitting there greyed out, because leaving it would
 * bury the ones still worth considering.
 */
export function getTodaysReminders(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): Task[] {
  const all = getTasks({ userId, done: false, limit: 1000 }).filter((t) => t.is_reminder)
  const localToday = DateTime.fromJSDate(now).setZone(timezone)

  return all.filter((task) => {
    // Non-recurring reminders show whenever they're undone — they have no
    // schedule to fall outside of.
    if (!task.rrule) return true

    // Already considered today: completing a recurring reminder advances its
    // schedule but leaves it "scheduled today" by the rrule's lights, so
    // without this check a checked-off reminder would sit in its slot all day.
    // §6: completed ones drop out; the next occurrence resurrects it.
    if (task.last_completed_at) {
      const completed = DateTime.fromISO(task.last_completed_at, { zone: 'utc' }).setZone(timezone)
      if (completed.isValid && completed.hasSame(localToday, 'day')) return false
    }

    // from_completion reminders have no derivable occurrence until they are
    // completed (§4.6) — their due_at IS the schedule, so show them once it
    // arrives (still no debt: nothing here renders overdue styling).
    if (task.recurrence_mode === 'from_completion') {
      if (!task.due_at) return false
      const due = DateTime.fromISO(task.due_at, { zone: 'utc' }).setZone(timezone)
      return due.isValid && due.startOf('day') <= localToday.startOf('day')
    }

    return todaysOccurrence(task, timezone, now) !== null
  })
}

/**
 * Today's reminders grouped into their time slots.
 *
 * Within a slot, higher priority sorts first — §6's "priority is prominence,
 * not interruption". The canonical high-priority reminder (morning
 * supplements: "you don't have to, but consistency matters") is important
 * without being an interrupt, so importance is expressed by position and
 * weight rather than by nagging.
 */
export function getRemindersBySlot(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): ReminderGroup[] {
  const reminders = getTodaysReminders(userId, timezone, now)
  const slots = listTimeSlots(userId)
  // A reminder that is waiting again (an undone completion leaves
  // last_completed_at behind) is waiting, not considered — never both.
  const waitingIds = new Set(reminders.map((t) => t.id))
  const considered = getConsideredToday(userId, timezone, now).filter((t) => !waitingIds.has(t.id))
  const consideredBySlot = new Map(
    groupBySlot(considered, slots, timezone).map((g) => [g.slot?.id ?? null, g.items.length]),
  )

  return groupBySlot(reminders, slots, timezone).map((group) => ({
    slot: group.slot,
    reminders: [...group.items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    considered: consideredBySlot.get(group.slot?.id ?? null) ?? 0,
  }))
}

/**
 * Reminders the user considered today: a recurring one whose last completion
 * fell on today's local date, or a one-off completed today. Read straight
 * from the table rather than through `getTasks`, which excludes done rows.
 */
export function getConsideredToday(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): Task[] {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const start = local.startOf('day').toUTC().toISO()
  const end = local.endOf('day').toUTC().toISO()
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks
        WHERE user_id = ? AND is_reminder = 1 AND deleted_at IS NULL
          AND ((last_completed_at >= ? AND last_completed_at <= ?)
            OR (done = 1 AND done_at >= ? AND done_at <= ?))`,
    )
    .all(userId, start, end, start, end) as { id: number }[]
  // Load through the ordinary row loader so labels etc. are parsed the same
  // way as everywhere else; a day's considered set is a few dozen rows at most.
  return rows.flatMap((r) => {
    const task = getTaskById(r.id)
    return task ? [task] : []
  })
}

/** How many reminders are pending in each slot — used by the slot notifications (§4.2). */
export function countRemindersBySlot(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): { slot: TimeSlot | null; count: number }[] {
  return getRemindersBySlot(userId, timezone, now).map((g) => ({
    slot: g.slot,
    count: g.reminders.length,
  }))
}

/**
 * Does this user have any reminders at all (done or not, excluding trash)?
 *
 * Only the empty state depends on it: someone who has never made a reminder needs
 * the surface explained, while someone who has simply finished today's needs to be
 * told they are done, not taught what reminders are. Kept separate from
 * `getRemindersBySlot` because that query answers "today", and today being empty is
 * exactly when this distinction matters.
 */
export function hasAnyReminders(userId: number): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 AS found FROM tasks WHERE user_id = ? AND is_reminder = 1 AND deleted_at IS NULL LIMIT 1',
    )
    .get(userId) as { found: number } | undefined
  return row !== undefined
}

/** Is this task on the Reminders surface? Cheap check without loading the row. */
export function isReminderTask(taskId: number): boolean {
  const row = getDb().prepare('SELECT is_reminder FROM tasks WHERE id = ?').get(taskId) as
    | { is_reminder: number }
    | undefined
  return row?.is_reminder === 1
}
