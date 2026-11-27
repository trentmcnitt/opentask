/**
 * THE ONE-DAY MOVE (2026-11-21): a reminder, or a quota prompt, moved to a
 * later period for today only.
 *
 * Trent: a Medium reminder nagged him all through a morning in which he
 * couldn't do it, and the only answer was "Considered" — though it still
 * needed doing that day. He asked for "the ability to be moved to another
 * time period, from the notification or in the app". Snoozing a reminder
 * stays refused (RULE TGT-REMINDER-NO-SNOOZE): a move between periods of the
 * same day is not a snooze, its target and schedule never change, and
 * tomorrow it is home again.
 *
 * The rules (registered in src/lib/rule-registry.ts):
 * - RM-MOVE-STORE (here): the move is stored for ONE OpenTask day.
 * - RM-MOVE-PLACE (src/lib/time-slot-assign.ts): every reader that groups
 *   reminders honours it, through `assignSlot`.
 * - RM-MOVE-TARGET (here): only to a later period that opens after now.
 * - RM-MOVE-COMMIT (here): one transaction, one undo entry, the moved items'
 *   named banners dismissed.
 */
import { withTransaction } from '@/core/db'
import { ValidationError } from '@/core/errors'
import { getTaskById } from '@/core/tasks/read'
import { getRemindersBySlot, reminderDay } from '@/core/tasks/reminders'
import { getQuotaPromptsBySlot } from '@/core/tasks/quota-prompts'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { listTimeSlots } from '@/core/time-slots'
import { createTaskSnapshot, logAction } from '@/core/undo'
import {
  dismissNotificationsForTasks,
  dismissPromptNotifications,
} from '@/core/notifications/dismiss'
import { periodOpensAt } from '@/lib/opentask-day'
import { dayStateFor, promptDate, promptWaiting } from '@/lib/quota-prompts'
import { emitSyncEvent } from '@/lib/sync-events'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import type { DayMove, Task } from '@/types'

export interface MoveForTodayInput {
  userId: number
  userTimezone: string
  /** Reminder task ids waiting today. */
  ids: number[]
  /** Quota prompt keys waiting today (`q:<task>:<k>:<date>`). */
  promptKeys: string[]
  /** The period to move them to. */
  slotId: number
  now?: Date
}

export interface MoveForTodayResult {
  /** Reminder ids moved. */
  moved: number[]
  /** Prompt keys moved. */
  movedPrompts: string[]
  slot: TimeSlot
  description: string
}

/**
 * RULE RM-MOVE-TARGET: A one-day move goes to any period of today other than the item's own
 *   (a moved item's own is the one it was moved to): earlier or later, open or not; never to
 *   Anytime. Every item must be waiting today in a period (not Anytime). Moved into a period
 *   that has opened, the item waits there now: it is in that period's list at once, and a
 *   Medium+ named push starts at once (its pacing floor is the move, RULE RM-MOVE-NAG).
 * Why: "Not now" and "I meant to do this earlier" are both a move; a move into an open period
 *   is a deliberate "now", so it nags now.
 * Ruling: Trent 2026-11-27 (via the design session): "this should allow moving reminders
 *   earlier as well", overruling the 2026-11-21 later-only rule.
 */
function opensAt(slot: TimeSlot, date: string, timezone: string, dayStart: string): Date | null {
  if (parseHHMM(slot.start_time) === null) return null
  return periodOpensAt(date, slot.start_time, timezone, dayStart)
}

/**
 * RULE RM-MOVE-STORE: A reminder's move is `day_move` {date, slot_id} on the task; a prompt's
 *   is `quota_day_state.moved[prompt_key]`. Both are for ONE OpenTask date: any other day
 *   reads as no move, so nothing clears them, and tomorrow the item is in its home period.
 *   The target, schedule and occurrence never change.
 * Why: The move answers "not now" for today only; a reminder carries no debt to move along.
 * Ruling: Trent 2026-11-21 ("the ability to be moved to another time period").
 */
export function moveForToday(input: MoveForTodayInput): MoveForTodayResult {
  const { userId, userTimezone: timezone, slotId, now = new Date() } = input
  const ids = [...new Set(input.ids)]
  const keys = [...new Set(input.promptKeys)]
  if (ids.length === 0 && keys.length === 0) throw new ValidationError('Nothing to move')

  const dayStart = dayBoundaryForUser(userId)
  const date = reminderDay(userId, timezone, now).date
  const slots = listTimeSlots(userId)
  const target = slots.find((s) => s.id === slotId)
  if (!target) throw new ValidationError('No such period')
  if (!opensAt(target, date, timezone, dayStart)) throw new ValidationError('No such period')

  const { promptSlot } = assertMovable({ userId, timezone, now, slots, target, ids, keys })

  // `at`: the move's own time, the named push's pacing floor (RULE RM-MOVE-NAG).
  const move: DayMove = { date, slot_id: target.id, at: now.toISOString() }
  const pDate = promptDate(timezone, dayStart, now)
  const quotaIds = [...new Set(keys.map((k) => promptSlot.get(k)!.taskId))]

  const titles = withTransaction((tx) => {
    const snapshots = []
    const fields = new Set<string>()
    const names: string[] = []
    const stamp = now.toISOString()
    for (const id of ids) {
      const before = getTaskById(id) as Task
      tx.prepare('UPDATE tasks SET day_move = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(move),
        stamp,
        id,
      )
      snapshots.push(createTaskSnapshot(before, { ...before, day_move: move }, ['day_move']))
      fields.add('day_move')
      names.push(before.title)
    }
    for (const quotaId of quotaIds) {
      const before = getTaskById(quotaId) as Task
      const day = dayStateFor(before.quota_day_state, pDate)
      const moved = { ...day.moved }
      const movedAt = { ...day.moved_at }
      for (const key of keys) {
        if (promptSlot.get(key)!.taskId !== quotaId) continue
        moved[key] = target.id
        movedAt[key] = stamp
      }
      const after = { ...day, moved, moved_at: movedAt }
      tx.prepare('UPDATE tasks SET quota_day_state = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(after),
        stamp,
        quotaId,
      )
      snapshots.push(
        createTaskSnapshot(before, { ...before, quota_day_state: after }, ['quota_day_state']),
      )
      fields.add('quota_day_state')
      names.push(before.title)
    }
    logAction(userId, 'reminder_move', describeMove(names, target.label), [...fields], snapshots)
    return names
  })

  /**
   * RULE RM-MOVE-COMMIT: A move is one transaction and one undo entry (`reminder_move`); after
   *   it the moved items' named banners are dismissed on every device (the push that clears
   *   them also makes the device reconcile its period banners), and open tabs and widgets sync.
   * Why: The moved item's banner nags for a period it has left; one Undo takes the move back.
   * Ruling: designer-approved rules RM-MOVE-1..5, 2026-11-21.
   */
  emitSyncEvent(userId)
  if (ids.length > 0) dismissNotificationsForTasks(userId, ids)
  if (keys.length > 0) dismissPromptNotifications(userId, keys)

  return {
    moved: ids,
    movedPrompts: keys,
    slot: target,
    description: describeMove(titles, target.label),
  }
}

/**
 * Where each item is today (moves included) and that the move is allowed
 * (RM-MOVE-TARGET): every reminder and prompt is waiting today, in a period
 * that opens before the target. Throws `ValidationError` otherwise.
 */
function assertMovable(args: {
  userId: number
  timezone: string
  now: Date
  slots: TimeSlot[]
  target: TimeSlot
  ids: number[]
  keys: string[]
}): { promptSlot: Map<string, { slot: TimeSlot | null; taskId: number }> } {
  const { userId, timezone, now, slots, target, ids, keys } = args
  const reminderSlot = new Map<number, TimeSlot | null>()
  for (const group of getRemindersBySlot(userId, timezone, now)) {
    for (const t of group.reminders) reminderSlot.set(t.id, group.slot)
  }
  const promptSlot = new Map<string, { slot: TimeSlot | null; taskId: number }>()
  for (const [id, prompts] of getQuotaPromptsBySlot(userId, timezone, now)) {
    for (const p of prompts) {
      if (!promptWaiting(p)) continue
      promptSlot.set(p.prompt_key, {
        slot: slots.find((s) => s.id === id) ?? null,
        taskId: p.task_id,
      })
    }
  }
  // From a period (never Anytime) to another one.
  const movable = (own: TimeSlot | null | undefined): 'anytime' | 'same' | null =>
    !own ? 'anytime' : own.id === target.id ? 'same' : null
  for (const id of ids) {
    if (!reminderSlot.has(id)) throw new ValidationError(`Reminder ${id} is not waiting today`)
    const why = movable(reminderSlot.get(id))
    if (why === 'anytime')
      throw new ValidationError(`Reminder ${id} is in Anytime; it has no period to move from`)
    if (why === 'same') throw new ValidationError(`Reminder ${id} is already in ${target.label}`)
  }
  for (const key of keys) {
    const at = promptSlot.get(key)
    if (!at) throw new ValidationError(`Prompt ${key} is not waiting today`)
    const why = movable(at.slot)
    if (why === 'anytime')
      throw new ValidationError(`That prompt is in Anytime; it has no period to move from`)
    if (why === 'same') throw new ValidationError(`That prompt is already in ${target.label}`)
  }
  return { promptSlot }
}

/** "Moved “Iron the shirts” to Afternoon for today" / "Moved 3 to Afternoon for today". */
export function describeMove(titles: string[], label: string): string {
  const what = titles.length === 1 ? `“${titles[0]}”` : `${titles.length}`
  return `Moved ${what} to ${label} for today`
}
