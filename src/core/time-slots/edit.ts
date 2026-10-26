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
 * time, and they simply regroup on the dashboard — EXCEPT a relative target
 * linked to the period (2026-10-24, `target_slot_id`; see RELATIVE TARGETS
 * below and docs/TASK-MODEL.md § Relative targets).
 *
 * RELATIVE TARGETS (2026-10-24): a task whose relative target's time follows
 * the period (`target_slot_id`) keeps `target_time` equal to the period's
 * start. A RETIME moves every open linked row in the same transaction and
 * undo entry (a one-off re-derives its target; a deadline-anchored repeat its
 * unmoved one) without restamping `target_set_at`; a row the new time would
 * be refused for is unlinked and keeps its old time instead. CLOSED rows
 * (done, archived, trashed) take the new time in ONE compare-and-set
 * statement recorded in `slot_state.target_times`. A DELETE unlinks every
 * linked row, keeping its time (closed rows' ids in `slot_state.target_unlinked`).
 * Undo and redo of both: `applyTargetRows` in src/core/undo/slot-row.ts.
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
import type { Database } from 'better-sqlite3'
import { getDb, withTransaction } from '@/core/db'
import { NotFoundError, ValidationError } from '@/core/errors'
import { logAction } from '@/core/undo'
import { logActivityBatch, type ActivityEntry } from '@/core/activity'
import {
  applyFieldChanges,
  collectFieldChanges,
  type FieldChangesInput,
} from '@/core/tasks/helpers'
import { getTaskById } from '@/core/tasks/create'
import { rowToTask, taskColumns, type TaskRow } from '@/core/tasks/read'
import { getTargetContext } from '@/core/tasks/target-context'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { retimeRefused } from '@/core/tasks/relative-target'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { dismissEndedPromptPushes, promptPushEndCheck } from '@/core/notifications/prompt-nags'
import { nowUtc } from '@/core/recurrence'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { emitSyncEvent } from '@/lib/sync-events'
import { buildSchedule, parseCadence } from '@/lib/reminder-rule'
import { formatClockTime } from '@/lib/time-utils'
import { settingName, unlinkSlot } from '@/lib/anchor-times'
import { applySettingChanges, readAnchorRow } from '@/core/users/anchor-times'
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
 * RELATIVE TARGETS (2026-10-24; docs/TASK-MODEL.md § Relative targets): the
 * OPEN rows whose target follows this period (`target_slot_id`) — the
 * owner's own (a link names the owner's period), one query, ordinary tasks
 * only (a reminder or a quota never has a relative target).
 */
function loadLinkedTargets(userId: number, slotId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE user_id = ? AND target_slot_id = ? AND done = 0
          AND deleted_at IS NULL AND archived_at IS NULL
          AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1`,
    )
    .all(userId, slotId) as TaskRow[]
  return rows.map(rowToTask)
}

/** A row is CLOSED for the period hooks: done, archived or trashed. */
const CLOSED_SQL = '(done = 1 OR archived_at IS NOT NULL OR deleted_at IS NOT NULL)'

/**
 * THE RETIME'S LINKED TARGETS: each follows the period to its new start —
 * sent as the period again (`target_slot_id`, which sets `target_time`), so
 * a one-off re-derives its target and a deadline-anchored repeat its unmoved
 * one (a moved one is kept) — unless the new time would be REFUSED for it
 * (`retimeRefused`: after its deadline on the deadline day, or overlapping
 * the previous occurrence on a daily rule): that row is UNLINKED and keeps
 * its old time as a custom one (decision 13), so the retime never fails
 * because of a task. Both as `retime` writes: no `target_set_at` restamp
 * (decision 11), attempts checkpointed.
 */
function retimeTargetInputs(
  linked: Task[],
  slotId: number,
  startTime: string,
  timezone: string,
): { changes: TaskChange[]; kept: Set<number> } {
  const kept = new Set<number>()
  const changes = linked.map((task) => {
    if (retimeRefused(task, startTime, timezone)) {
      kept.add(task.id)
      return { task, input: { target_slot_id: null, retime: true } }
    }
    return { task, input: { target_slot_id: slotId, retime: true } }
  })
  return { changes, kept }
}

/**
 * The CLOSED linked rows (done, archived, trashed) follow the period too —
 * their `target_time` only, ONE compare-and-set statement (decision 14),
 * recorded in the entry's `slot_state.target_times` so undo and redo apply
 * the mirror (`applyTargetRows`). `due_at` stays: a reopen re-derives it.
 */
function retimeClosedTargets(
  tx: Database,
  userId: number,
  slotId: number,
  before: string,
  after: string,
): number {
  return tx
    .prepare(
      `UPDATE tasks SET target_time = ?
        WHERE user_id = ? AND target_slot_id = ? AND target_time = ? AND ${CLOSED_SQL}`,
    )
    .run(after, userId, slotId, before).changes
}

/**
 * A removed period's CLOSED linked rows lose the link and keep their time
 * (one statement); their ids go in `slot_state.target_unlinked`, for undo's
 * compare-and-set re-link (`applyTargetRows`).
 */
function unlinkClosedTargets(tx: Database, userId: number, slotId: number): number[] {
  const ids = (
    tx
      .prepare(`SELECT id FROM tasks WHERE user_id = ? AND target_slot_id = ? AND ${CLOSED_SQL}`)
      .all(userId, slotId) as { id: number }[]
  ).map((r) => r.id)
  if (ids.length > 0) {
    tx.prepare(
      `UPDATE tasks SET target_slot_id = NULL WHERE user_id = ? AND target_slot_id = ? AND ${CLOSED_SQL}`,
    ).run(userId, slotId)
  }
  return ids
}

/** What `applyChanges` may share across rows (one owner's context, read once). */
interface ApplyContext {
  targetCtx?: ReturnType<typeof getTargetContext>
  rolloverTime?: string
  slotsFor?: (ownerId: number) => readonly TimeSlot[]
}

/** Two outcomes, as one entry's snapshots and fields. */
function mergeOutcomes(a: MoveOutcome, b: MoveOutcome): MoveOutcome {
  return {
    snapshots: [...a.snapshots, ...b.snapshots],
    fields: [...new Set([...a.fields, ...b.fields])],
  }
}

/** Whether a snapshot moved its task's target (its notification is stale). */
function movedTarget(snapshot: UndoSnapshot): boolean {
  return 'due_at' in snapshot.after_state
}

/**
 * Apply planned changes inside the caller's transaction. The same per-task
 * step as bulkEdit (collectFieldChanges → `applyFieldChanges`: UPDATE →
 * snapshot + activity), minus its snooze/quota filters, which cannot apply to
 * a reminder schedule move or a prompt's period. The activity action is always
 * 'edit' here: `collectFieldChanges` refuses a snooze of a reminder outright,
 * and a prompt-period change carries no date.
 */
function applyChanges(
  tx: Database,
  userId: number,
  timezone: string,
  changes: TaskChange[],
  shared: ApplyContext = {},
): MoveOutcome {
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
      ...shared,
    })
    if (data.fieldsChanged.length === 0) continue

    const applied = applyFieldChanges(tx, task, data, nowStr)
    snapshots.push(applied.snapshot)
    activity.push({ userId, ...applied.activity, source: 'bulk', batchId })
    data.fieldsChanged.forEach((f) => fields.add(f))
  }

  logActivityBatch(activity)
  return { snapshots, fields: [...fields] }
}

function notifyMoved(userId: number, timezone: string, outcome: MoveOutcome): void {
  emitSyncEvent(userId)
  // A linked target the period moved: its delivered notification is stale.
  const moved = outcome.snapshots.filter(movedTarget).map((s) => s.task_id)
  if (moved.length > 0) dismissNotificationsForTasks(userId, moved)
  for (const snapshot of outcome.snapshots) {
    const fresh = getTaskById(snapshot.task_id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse(fresh, timezone),
        // This task's own fields — its snapshot holds exactly those (plus
        // title, which createSnapshot always includes for display).
        fields_changed: Object.keys(snapshot.after_state).filter(
          (f) => f !== 'id' && (f !== 'title' || outcome.fields.includes('title')),
        ),
      })
    }
  }
}

function reminderCount(n: number): string {
  return `${n} reminder${n === 1 ? '' : 's'}`
}

function targetCount(n: number): string {
  return `${n} target${n === 1 ? '' : 's'}`
}

/**
 * `Moved "Evening" to 9:00 PM (2 reminders, 5 targets; 1 kept its time)` —
 * the retime's undo entry and toast (relative targets, 2026-10-24).
 */
export function retimeDescription(
  label: string,
  startTime: string,
  counts: { reminders: number; targets: number; kept: number },
): string {
  const moved = [
    counts.reminders > 0 ? reminderCount(counts.reminders) : null,
    counts.targets > 0 ? targetCount(counts.targets) : null,
  ].filter((p): p is string => p !== null)
  const keptWords =
    counts.kept === 0
      ? null
      : `${moved.length > 0 ? counts.kept : targetCount(counts.kept)} kept ${counts.kept === 1 ? 'its' : 'their'} time`
  const parts = [moved.join(', '), keptWords].filter((p): p is string => !!p)
  return (
    `Moved "${label}" to ${formatClockTime(startTime)}` +
    (parts.length ? ` (${parts.join('; ')})` : '')
  )
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
  /**
   * The user's settings that linked to a deleted period and now keep its
   * start as a custom time ("Default task time", "Number pad button 2") — a delete only;
   * a retime keeps the period, and linked settings follow it on their own.
   */
  settings_converted: string[]
  /**
   * Relative targets (2026-10-24) — a retime: the open tasks whose target
   * followed the period to its new start (`targets_moved`), and the ones the
   * new time would put after their deadline (or over the previous occurrence),
   * unlinked and kept at their old time (`targets_kept`). A delete: the open
   * tasks unlinked, keeping the removed period's start (`targets_converted`).
   */
  targets_moved: number
  targets_kept: number
  targets_converted: number
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
    return {
      slot: before,
      reminders_moved: 0,
      quotas_moved: 0,
      settings_converted: [],
      targets_moved: 0,
      targets_kept: 0,
      targets_converted: 0,
      undo_id: null,
    }
  }

  // A retime can end a named quota-prompt push (its period not open any
  // more): those banners go after the commit (review of #377).
  const endedPromptPushes = retimed ? promptPushEndCheck(userId, 'all') : () => []
  let outcome: MoveOutcome = { snapshots: [], fields: [] }
  let remindersMoved = 0
  let targetsMoved = 0
  let targetsKept = 0
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
    // One owner, read once (after the UPDATE: a Morning linked to this
    // period already reads its new start).
    const shared: ApplyContext = {
      targetCtx: getTargetContext(userId),
      rolloverTime: rolloverTimeForUser(userId),
      slotsFor: () => newSlots,
    }
    const reminders = loadReminders(userId)
    const moves = planSlotRetime(reminders, oldSlots, newSlots, slotId, userTimezone)
    const reminderOutcome = applyChanges(
      tx,
      userId,
      userTimezone,
      moveInputs(reminders, moves, userTimezone),
      shared,
    )
    remindersMoved = reminderOutcome.snapshots.length

    // Relative targets (2026-10-24): the targets that follow this period.
    const plan = retimeTargetInputs(
      loadLinkedTargets(userId, slotId),
      slotId,
      startTime,
      shared.targetCtx!.timezone,
    )
    const targetOutcome = applyChanges(tx, userId, userTimezone, plan.changes, shared)
    targetsKept = targetOutcome.snapshots.filter((s) => plan.kept.has(s.task_id)).length
    targetsMoved = targetOutcome.snapshots.length - targetsKept
    outcome = mergeOutcomes(reminderOutcome, targetOutcome)
    const slotState: SlotUndoState = { before, after }
    if (retimeClosedTargets(tx, userId, slotId, before.start_time, startTime) > 0) {
      slotState.target_times = { slot_id: slotId, before: before.start_time, after: startTime }
    }

    const description = retimeDescription(label, startTime, {
      reminders: remindersMoved,
      targets: targetsMoved,
      kept: targetsKept,
    })
    return logAction(
      userId,
      'time_slot_edit',
      description,
      outcome.fields,
      outcome.snapshots,
      slotState,
    )
  })

  notifyMoved(userId, userTimezone, outcome)
  dismissEndedPromptPushes(userId, endedPromptPushes)
  return {
    slot: after,
    reminders_moved: remindersMoved,
    quotas_moved: 0,
    settings_converted: [],
    targets_moved: targetsMoved,
    targets_kept: targetsKept,
    targets_converted: 0,
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

/**
 * `Removed "Morning" (moved 2 reminders); kept Default task time, Number pad button 1 at
 * 9:00 AM` — the undo entry's description; the settings part names what was
 * linked to the period and now keeps its start as a custom time.
 */
export function deleteDescription(
  slot: Pick<TimeSlot, 'label' | 'start_time'>,
  reminders: number,
  quotas: number,
  settings: readonly string[] = [],
  /** Relative targets (2026-10-24): tasks whose target kept the period's start. */
  targets = 0,
): string {
  const kept = targets > 0 ? [...settings, targetCount(targets)] : settings
  const parts = [
    reminders > 0 ? reminderCount(reminders) : null,
    quotas > 0 ? `${quotas} quota${quotas === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null)
  return (
    `Removed "${slot.label}"` +
    (parts.length > 0 ? ` (moved ${parts.join(', ')})` : '') +
    (kept.length > 0 ? `; kept ${kept.join(', ')} at ${formatClockTime(slot.start_time)}` : '')
  )
}

/** Remove a slot, moving its reminders and quota prompts to the nearest remaining slot. */
export function deleteTimeSlot(options: DeleteTimeSlotOptions): TimeSlotChangeResult {
  const { userId, userTimezone, slotId } = options
  const before = loadSlot(userId, slotId)

  // Deleting a period moves its prompts to the nearest one, which may not
  // have opened: a named quota-prompt push that ends goes (review of #377).
  const endedPromptPushes = promptPushEndCheck(userId, 'all')
  let outcome: MoveOutcome = { snapshots: [], fields: [] }
  let remindersMoved = 0
  let quotasMoved = 0
  let targetsConverted = 0
  let converted: string[] = []
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
    const shared: ApplyContext = {
      targetCtx: getTargetContext(userId),
      rolloverTime: rolloverTimeForUser(userId),
    }
    outcome = applyChanges(tx, userId, userTimezone, [...reminderChanges, ...quotaChanges], shared)
    const quotaIds = new Set(quotaChanges.map((c) => c.task.id))
    remindersMoved = outcome.snapshots.filter((s) => !quotaIds.has(s.task_id)).length
    quotasMoved = outcome.snapshots.length - remindersMoved

    // Relative targets (2026-10-24): a target following the period keeps its
    // start as a custom time — like the settings below, not the nearest
    // period. Open rows through the snapshots; closed ones in one statement.
    const targetChanges = loadLinkedTargets(userId, slotId).map((task) => ({
      task,
      input: { target_slot_id: null },
    }))
    const targetOutcome = applyChanges(tx, userId, userTimezone, targetChanges, shared)
    targetsConverted = targetOutcome.snapshots.length
    outcome = mergeOutcomes(outcome, targetOutcome)

    // The user's default prompt period follows too. It is not a task field,
    // so the entry carries it beside the slot row (`applyPromptDefault`).
    const slotState: SlotUndoState = { before, after: null }
    const unlinked = unlinkClosedTargets(tx, userId, slotId)
    if (unlinked.length > 0) slotState.target_unlinked = unlinked
    if (promptTarget && readPromptDefault(userId) === slotId) {
      tx.prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(
        promptTarget.id,
        userId,
      )
      slotState.prompt_default = { before: slotId, after: promptTarget.id }
    }

    // Settings linked to the period (Morning, Wake, Sleep, Day starts at, pad buttons) keep
    // its start as a custom time — not the nearest period, unlike the
    // reminders. The entry carries them so undo puts the links back with the
    // period (`applyUserSettings`).
    const settingChanges = unlinkSlot(readAnchorRow(userId, tx), before)
    if (settingChanges.length > 0) {
      applySettingChanges(tx, userId, settingChanges, 'after')
      slotState.user_settings = settingChanges
      converted = settingChanges.map((c) => settingName(c.setting))
    }

    const description = deleteDescription(
      before,
      remindersMoved,
      quotasMoved,
      converted,
      targetsConverted,
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

  notifyMoved(userId, userTimezone, outcome)
  dismissEndedPromptPushes(userId, endedPromptPushes)
  return {
    slot: before,
    reminders_moved: remindersMoved,
    quotas_moved: quotasMoved,
    settings_converted: converted,
    targets_moved: 0,
    targets_kept: 0,
    targets_converted: targetsConverted,
    undo_id: undoId,
  }
}
