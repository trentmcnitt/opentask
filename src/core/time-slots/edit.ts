/**
 * Editing and removing time slots (Settings → Reminder periods, 2026-09-24)
 *
 * A reminder belongs to a slot only through its time of day (see the header
 * of `./index.ts`), so changing a slot's start or removing a slot silently
 * re-buckets reminders unless their times move too. These two functions do
 * the slot change AND the reminder moves in one transaction, logged as ONE
 * undo entry that also carries the slot row (`undo_log.slot_state`), so Undo
 * puts the slot and its reminders back together.
 *
 * WHICH REMINDERS MOVE — the judgment calls, in one place:
 *
 * Candidates are the user's own undone, non-deleted reminders (`is_reminder`),
 * every one of them, not just today's: a Tue/Thu reminder must move on a
 * Monday too. Ordinary tasks are never touched — their due time is a real
 * time, and they simply regroup on the dashboard.
 *
 * Changing a slot's START (old → new):
 *   1. A reminder ON the old boundary (its time == old start) moves to the new
 *      start. Boundary is how reminders are placed — the editor's slot chips
 *      and the AI guard both write the slot's exact start — so it follows.
 *   2. A reminder INSIDE the slot (e.g. "Afternoon, 7:00 PM") keeps its time
 *      if it is still in this slot under the new boundaries; if the new
 *      boundaries would put it elsewhere, it moves to the new start. Either
 *      way, every reminder that was in the slot is still in it.
 *   3. Other slots' reminders are left alone, even when the moved boundary
 *      now covers them. Only an off-boundary one can be covered (a boundary
 *      reminder sits on its own slot's start, and starts are unique), and its
 *      explicit time is honoured rather than rewritten.
 *   A rename alone moves nothing and is not an undo entry (it is trivially
 *   reversible, and not a task mutation).
 *
 * Removing a slot: each of its reminders moves to the START of the remaining
 * slot nearest to the reminder's own time (`nearestSlot`; a tie goes to the
 * earlier slot). For boundary reminders that is simply the slot nearest the
 * removed one. "Nearest", not "previous", because removing the first slot has
 * no previous one — its reminders would otherwise fall out of every slot. They
 * land ON the start, not at their old time, because otherwise `assignSlot`
 * would still put them in whatever slot precedes their old time. The last
 * remaining slot cannot be removed.
 *
 * QUOTA PROMPTS MOVE THE SAME WAY (Trent, 2026-09-25). A prompt stores the
 * slot id it sits in (`quota_prompt_config.slot_id`, and per number for a
 * daily quota; the user's default in `users.quota_prompt_slot_id`). Removing
 * a slot rewrites every stored id that names it to the remaining slot nearest
 * the removed slot's start — a prompt's "time" is its slot's start, so this
 * is exactly where a boundary reminder of that slot goes (`nearestSlot`, tie
 * to the earlier). Done here, in the same transaction and undo entry, rather
 * than at read time: `resolvePromptSlot` only sees ids, and once the row is
 * gone nothing knows where the removed slot was, so "nearest" cannot be
 * computed later. The quotas' configs ride in the entry's task snapshots and
 * the user's default in its `slotState.prompt_default`, so one Undo puts the
 * slot, its reminders and its prompts back together.
 *   Only STORED ids move. A daily quota's numbers that were never placed by
 *   hand are derived — spread one per period from the quota's base — so they
 *   re-spread over the remaining periods, as they would for a new quota.
 *   `resolvePromptSlot`'s read-time fallback stays as a safety net for ids
 *   left stale by deletes made before this rule.
 *   Retiming a slot keeps its id, so its prompts follow it with no rewrite.
 *
 * HOW A REMINDER MOVES: a repeating one gets its own rule rewritten with the
 * new BYHOUR/BYMINUTE (`buildSchedule`, so Tue/Thu stays Tue/Thu) — the same
 * write the Reminders editor makes when you pick a slot chip, which re-derives
 * `anchor_time` — and its current `due_at` keeps its DATE at the new time
 * (see `moveInput` for why not "first occurrence from now"). Rule parts the
 * cadence reader does not model may be normalised, exactly as the editor's
 * chip does; undo restores the exact old rule. A one-time reminder (no rule)
 * keeps its date and gets the new time on it, sent as a reschedule
 * (`reset_original_due_at`), never a snooze — reminders cannot be snoozed.
 */

import { DateTime } from 'luxon'
import { getDb, withTransaction } from '@/core/db'
import { NotFoundError, ValidationError } from '@/core/errors'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch, type ActivityEntry } from '@/core/activity'
import { collectFieldChanges, type FieldChangesInput } from '@/core/tasks/helpers'
import { getTaskById } from '@/core/tasks/create'
import { nowUtc } from '@/core/recurrence'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { emitSyncEvent } from '@/lib/sync-events'
import { buildSchedule, formatMinutes, parseCadence } from '@/lib/reminder-rule'
import {
  assignSlot,
  itemTimeOfDayMinutes,
  nearestSlot,
  parseHHMM,
  type SlottableItem,
  type TimeSlot,
} from '@/lib/time-slot-assign'
import type { QuotaPromptConfig, SlotUndoState, Task, UndoSnapshot } from '@/types'
import { assertStartTimeFree, listTimeSlots } from './index'

/** What the planners need to know about a reminder. */
export interface PlannableReminder extends SlottableItem {
  id: number
}

/**
 * Where each of the edited slot's reminders must go when its start moves:
 * task id → new minutes of day. Pure — see the header for the rule.
 */
export function planSlotRetime(
  reminders: PlannableReminder[],
  oldSlots: TimeSlot[],
  newSlots: TimeSlot[],
  slotId: number,
  timezone: string,
): Map<number, number> {
  const oldSlot = oldSlots.find((s) => s.id === slotId)
  const newSlot = newSlots.find((s) => s.id === slotId)
  const oldStart = oldSlot ? parseHHMM(oldSlot.start_time) : null
  const newStart = newSlot ? parseHHMM(newSlot.start_time) : null
  const moves = new Map<number, number>()
  if (oldStart === null || newStart === null || oldStart === newStart) return moves

  for (const reminder of reminders) {
    if (assignSlot(reminder, oldSlots, timezone)?.id !== slotId) continue
    const minutes = itemTimeOfDayMinutes(reminder, timezone)
    const onBoundary = minutes === oldStart
    const staysInSlot = assignSlot(reminder, newSlots, timezone)?.id === slotId
    if (onBoundary || !staysInSlot) moves.set(reminder.id, newStart)
  }
  return moves
}

/**
 * Where a removed slot's reminders go: task id → the start (in minutes) of
 * the remaining slot nearest each reminder's own time. Pure.
 */
export function planSlotDelete(
  reminders: PlannableReminder[],
  oldSlots: TimeSlot[],
  slotId: number,
  timezone: string,
): Map<number, number> {
  const remaining = oldSlots
    .filter((s) => s.id !== slotId)
    .sort((a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0))
  const moves = new Map<number, number>()
  if (remaining.length === 0) return moves

  for (const reminder of reminders) {
    if (assignSlot(reminder, oldSlots, timezone)?.id !== slotId) continue
    const minutes = itemTimeOfDayMinutes(reminder, timezone)
    if (minutes === null) continue
    const target = nearestSlot(minutes, remaining)
    const start = target ? parseHHMM(target.start_time) : null
    if (start !== null) moves.set(reminder.id, start)
  }
  return moves
}

/** The field changes that put a reminder at `minutes`, or null if it has no time to move. */
function moveInput(task: Task, minutes: number, timezone: string): FieldChangesInput | null {
  const movedDue = sameDayAt(task.due_at, minutes, timezone)
  if (task.rrule) {
    const rrule = buildSchedule({ ...parseCadence(task.rrule), time: minutes })
    // The current occurrence's DATE rides along: a rule change alone
    // recomputes due_at as the first occurrence from NOW, which would skip
    // today's still-waiting 09:00 reminder when Morning moves to 09:30 at
    // 11:00, and resurrect an already-considered 20:30 one when Evening moves
    // to 21:00 at 20:45. Same day, new time keeps "today's" exactly today's.
    return movedDue ? { rrule, due_at: movedDue } : { rrule }
  }
  if (!movedDue) return null
  return { due_at: movedDue, reset_original_due_at: true }
}

/** `dueAt`'s local date at `minutes` past midnight, as UTC ISO; null without a usable date. */
function sameDayAt(dueAt: string | null, minutes: number, timezone: string): string | null {
  if (!dueAt) return null
  const local = DateTime.fromISO(dueAt, { zone: 'utc' }).setZone(timezone)
  if (!local.isValid) return null
  return local
    .set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()
}

function loadSlot(userId: number, slotId: number): TimeSlot {
  // Scoped by user: another user's slot id is indistinguishable from a
  // missing one (404), so ids can't be probed.
  const slot = getDb()
    .prepare('SELECT * FROM time_slots WHERE id = ? AND user_id = ?')
    .get(slotId, userId) as TimeSlot | undefined
  if (!slot) throw new NotFoundError('Time slot not found')
  return slot
}

function loadReminders(userId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks
        WHERE user_id = ? AND is_reminder = 1 AND done = 0
          AND deleted_at IS NULL AND archived_at IS NULL`,
    )
    .all(userId) as { id: number }[]
  return rows.flatMap((r) => {
    const task = getTaskById(r.id)
    return task ? [task] : []
  })
}

interface MoveOutcome {
  snapshots: UndoSnapshot[]
  fields: string[]
}

interface TaskChange {
  task: Task
  input: FieldChangesInput
}

/** Planned reminder moves, as the field changes that make them. */
function moveInputs(reminders: Task[], moves: Map<number, number>, timezone: string): TaskChange[] {
  return reminders.flatMap((task) => {
    const minutes = moves.get(task.id)
    const input = minutes === undefined ? null : moveInput(task, minutes, timezone)
    return input ? [{ task, input }] : []
  })
}

/** `config` with every id naming `fromId` rewritten to `toId`; null if none did. */
export function repointPromptConfig(
  config: QuotaPromptConfig | null | undefined,
  fromId: number,
  toId: number,
): QuotaPromptConfig | null {
  if (!config) return null
  let changed = false
  const next: QuotaPromptConfig = { ...config }
  if (config.slot_id === fromId) {
    next.slot_id = toId
    changed = true
  }
  if (config.numbers) {
    next.numbers = Object.fromEntries(
      Object.entries(config.numbers).map(([k, id]) => {
        if (id !== fromId) return [k, id]
        changed = true
        return [k, toId]
      }),
    )
  }
  return changed ? next : null
}

/**
 * The quotas whose stored prompt periods name a removed slot, with the config
 * that points them at `toId` instead. Every one of the user's non-trashed
 * rows with a config — done and archived included, so a quota brought back
 * later does not name a slot that is gone.
 */
function promptInputs(userId: number, fromId: number, toId: number): TaskChange[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks
        WHERE user_id = ? AND deleted_at IS NULL AND quota_prompt_config IS NOT NULL`,
    )
    .all(userId) as { id: number }[]
  return rows.flatMap((r) => {
    const task = getTaskById(r.id)
    const config = task ? repointPromptConfig(task.quota_prompt_config, fromId, toId) : null
    return task && config ? [{ task, input: { quota_prompt_config: config } }] : []
  })
}

/**
 * Apply planned changes inside the caller's transaction. Mirrors bulkEdit's
 * per-task loop (collectFieldChanges → UPDATE → snapshot + activity), minus
 * its snooze/quota filters, which cannot apply to a reminder schedule move or
 * a prompt's period.
 */
function applyChanges(userId: number, timezone: string, changes: TaskChange[]): MoveOutcome {
  const db = getDb()
  const now = new Date()
  const nowStr = nowUtc()
  const batchId = crypto.randomUUID()
  const snapshots: UndoSnapshot[] = []
  const activity: ActivityEntry[] = []
  const fields = new Set<string>()

  for (const { task, input } of changes) {
    const data = collectFieldChanges({
      task,
      input,
      userId,
      userTimezone: timezone,
      now,
      skipProjectValidation: true,
    })
    if (data.fieldsChanged.length === 0) continue

    data.setClauses.push('updated_at = ?')
    data.values.push(nowStr, task.id)
    db.prepare(`UPDATE tasks SET ${data.setClauses.join(', ')} WHERE id = ?`).run(...data.values)

    snapshots.push(
      createTaskSnapshot(
        data.beforeState as Partial<Task> & { id: number },
        data.afterState as Partial<Task> & { id: number },
        data.fieldsChanged,
      ),
    )
    activity.push({
      userId,
      taskId: task.id,
      action: 'edit',
      source: 'bulk',
      batchId,
      fields: data.fieldsChanged,
      before: data.beforeState,
      after: data.afterState,
    })
    data.fieldsChanged.forEach((f) => fields.add(f))
  }

  logActivityBatch(activity)
  return { snapshots, fields: [...fields] }
}

function notifyMoved(userId: number, outcome: MoveOutcome): void {
  emitSyncEvent(userId)
  for (const snapshot of outcome.snapshots) {
    const fresh = getTaskById(snapshot.task_id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse(fresh),
        // This task's own fields — its snapshot holds exactly those (plus
        // title, which createSnapshot always includes for display).
        fields_changed: Object.keys(snapshot.after_state).filter(
          (f) => f !== 'id' && (f !== 'title' || outcome.fields.includes('title')),
        ),
      })
    }
  }
}

function formatStart(startTime: string): string {
  const minutes = parseHHMM(startTime)
  return minutes === null ? startTime : formatMinutes(minutes)
}

function reminderCount(n: number): string {
  return `${n} reminder${n === 1 ? '' : 's'}`
}

export interface TimeSlotChangeResult {
  /** The slot after the change (for a delete, the slot as it was). */
  slot: TimeSlot
  /** How many reminders were rewritten to stay in (or find) a slot. */
  reminders_moved: number
  /**
   * How many quotas had a stored prompt period repointed — a delete only: a
   * retime keeps the slot's id, so its prompts follow it untouched.
   */
  quotas_moved: number
  /** The undo_log entry for this change, or null when nothing undoable happened (a rename). */
  undo_id: number | null
}

export interface UpdateTimeSlotOptions {
  userId: number
  userTimezone: string
  slotId: number
  input: { label?: string; start_time?: string }
}

/** Rename a slot and/or move its start, carrying its reminders along. */
export function updateTimeSlot(options: UpdateTimeSlotOptions): TimeSlotChangeResult {
  const { userId, userTimezone, slotId, input } = options
  const before = loadSlot(userId, slotId)
  const label = input.label !== undefined ? input.label.trim() : before.label
  if (!label) throw new ValidationError('Label is required')
  const startTime = input.start_time ?? before.start_time
  if (parseHHMM(startTime) === null) {
    throw new ValidationError(`Invalid start_time "${startTime}" — expected HH:MM`)
  }
  const retimed = startTime !== before.start_time

  const after: TimeSlot = { ...before, label, start_time: startTime }
  if (!retimed && label === before.label) {
    return { slot: before, reminders_moved: 0, quotas_moved: 0, undo_id: null }
  }

  let outcome: MoveOutcome = { snapshots: [], fields: [] }
  const undoId = withTransaction((tx) => {
    if (retimed) assertStartTimeFree(userId, startTime, slotId)
    const oldSlots = listTimeSlots(userId)
    tx.prepare('UPDATE time_slots SET label = ?, start_time = ? WHERE id = ? AND user_id = ?').run(
      label,
      startTime,
      slotId,
      userId,
    )
    if (!retimed) return null

    const newSlots = oldSlots.map((s) => (s.id === slotId ? after : s))
    const reminders = loadReminders(userId)
    const moves = planSlotRetime(reminders, oldSlots, newSlots, slotId, userTimezone)
    outcome = applyChanges(userId, userTimezone, moveInputs(reminders, moves, userTimezone))

    const moved = outcome.snapshots.length
    const description =
      `Moved "${label}" to ${formatStart(startTime)}` +
      (moved > 0 ? ` (${reminderCount(moved)})` : '')
    return logAction(userId, 'time_slot_edit', description, outcome.fields, outcome.snapshots, {
      before,
      after,
    })
  })

  notifyMoved(userId, outcome)
  return {
    slot: after,
    reminders_moved: outcome.snapshots.length,
    quotas_moved: 0,
    undo_id: undoId,
  }
}

export interface DeleteTimeSlotOptions {
  userId: number
  userTimezone: string
  slotId: number
}

/**
 * Where a removed slot's quota prompts go: the remaining slot nearest the
 * removed slot's start — where its boundary reminders go (see the header).
 */
export function promptSlotAfterDelete(oldSlots: TimeSlot[], slotId: number): TimeSlot | null {
  const removed = oldSlots.find((s) => s.id === slotId)
  const start = removed ? parseHHMM(removed.start_time) : null
  if (start === null) return null
  const remaining = oldSlots
    .filter((s) => s.id !== slotId)
    .sort((a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0))
  return nearestSlot(start, remaining)
}

function readPromptDefault(userId: number): number | null {
  const row = getDb().prepare('SELECT quota_prompt_slot_id FROM users WHERE id = ?').get(userId) as
    | { quota_prompt_slot_id: number | null }
    | undefined
  return row?.quota_prompt_slot_id ?? null
}

function deleteDescription(label: string, reminders: number, quotas: number): string {
  const parts = [
    reminders > 0 ? reminderCount(reminders) : null,
    quotas > 0 ? `${quotas} quota${quotas === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null)
  return `Removed "${label}"` + (parts.length > 0 ? ` (moved ${parts.join(', ')})` : '')
}

/** Remove a slot, moving its reminders and quota prompts to the nearest remaining slot. */
export function deleteTimeSlot(options: DeleteTimeSlotOptions): TimeSlotChangeResult {
  const { userId, userTimezone, slotId } = options
  const before = loadSlot(userId, slotId)

  let outcome: MoveOutcome = { snapshots: [], fields: [] }
  let remindersMoved = 0
  const undoId = withTransaction((tx) => {
    const oldSlots = listTimeSlots(userId)
    if (oldSlots.length <= 1) {
      throw new ValidationError('Keep at least one reminder period')
    }
    const reminders = loadReminders(userId)
    const moves = planSlotDelete(reminders, oldSlots, slotId, userTimezone)
    const promptTarget = promptSlotAfterDelete(oldSlots, slotId)
    tx.prepare('DELETE FROM time_slots WHERE id = ? AND user_id = ?').run(slotId, userId)

    // After the DELETE, so `assertPromptSlotsOwned` sees the target as one of
    // the user's slots and the removed one as gone.
    const reminderChanges = moveInputs(reminders, moves, userTimezone)
    const quotaChanges = promptTarget ? promptInputs(userId, slotId, promptTarget.id) : []
    outcome = applyChanges(userId, userTimezone, [...reminderChanges, ...quotaChanges])
    const quotaIds = new Set(quotaChanges.map((c) => c.task.id))
    remindersMoved = outcome.snapshots.filter((s) => !quotaIds.has(s.task_id)).length

    // The user's default prompt period follows too. It is not a task field,
    // so the entry carries it beside the slot row (`applyPromptDefault`).
    const slotState: SlotUndoState = { before, after: null }
    if (promptTarget && readPromptDefault(userId) === slotId) {
      tx.prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(
        promptTarget.id,
        userId,
      )
      slotState.prompt_default = { before: slotId, after: promptTarget.id }
    }

    const description = deleteDescription(
      before.label,
      remindersMoved,
      outcome.snapshots.length - remindersMoved,
    )
    return logAction(
      userId,
      'time_slot_delete',
      description,
      outcome.fields,
      outcome.snapshots,
      slotState,
    )
  })

  notifyMoved(userId, outcome)
  return {
    slot: before,
    reminders_moved: remindersMoved,
    quotas_moved: outcome.snapshots.length - remindersMoved,
    undo_id: undoId,
  }
}
