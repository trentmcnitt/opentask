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

import { getDb } from '@/core/db'
import { todaysOccurrence } from '@/core/recurrence/occurrence'
import { groupBySlot, listTimeSlots, type TimeSlot } from '@/core/time-slots'
import type { Task } from '@/types'
import { getTasks } from './create'

export interface ReminderGroup {
  slot: TimeSlot | null
  reminders: Task[]
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

  return all.filter((task) => {
    // Non-recurring reminders show whenever they're undone — they have no
    // schedule to fall outside of.
    if (!task.rrule) return true
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

  return groupBySlot(reminders, slots, timezone).map((group) => ({
    slot: group.slot,
    reminders: [...group.items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
  }))
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

/** Is this task on the Reminders surface? Cheap check without loading the row. */
export function isReminderTask(taskId: number): boolean {
  const row = getDb().prepare('SELECT is_reminder FROM tasks WHERE id = ?').get(taskId) as
    | { is_reminder: number }
    | undefined
  return row?.is_reminder === 1
}
