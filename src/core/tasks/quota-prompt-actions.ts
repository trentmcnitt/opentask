/**
 * Quota reminders — acting on a prompt (2026-09-24). See `./quota-prompts.ts`
 * for what a prompt is.
 *
 * Two verbs, because ticking a reminder means "considered", not "did it":
 *
 * - CONSIDER — the round circle. Handled for today; no progress. Writes the
 *   key into today's `quota_day_state.considered`. Consider-all (a slot's
 *   "Considered all", a checklist's "Complete all") only ever does this.
 * - DID IT — the square checkbox by the count. Progress, and considered too.
 *   IDEMPOTENT per prompt_key, so a double tap, a retried request or two
 *   clients acting on the same prompt log it once:
 *     daily #k      raises today's count to at least k (never adds past it);
 *     anything else +1, unless this key is already in today's `did` — and
 *                   ONLY then: a +1 logged elsewhere today (the widget, the
 *                   watch) does not block it, so a did-it from a screen loaded
 *                   before that +1 counts again (Trent, 2026-09-25; QPM-010).
 *
 * Every action is one transaction and one undo entry — one entry for a whole
 * batch, including a mixed one from POST /api/tasks/bulk/complete (reminders
 * completed + prompts acted on). Undo restores `progress_current` and
 * `quota_day_state` together, so an undone "did it" brings the prompt back
 * with its count. Each quota's expired period is closed inline first, as a
 * +1 does (`rolloverQuotaNow`), so an action at 00:02 counts for today.
 */

import type Database from 'better-sqlite3'
import { withTransaction } from '@/core/db'
import { createQuotaSnapshot, logAction } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { emitSyncEvent } from '@/lib/sync-events'
import { formatTaskResponse } from '@/lib/format-task'
import { dayStateFor, localDate, parsePromptKey, type ParsedPromptKey } from '@/lib/quota-prompts'
import { isTracked } from '@/lib/track'
import type { QuotaDayState, Task, UndoSnapshot } from '@/types'
import { getTaskById } from './create'
import { rolloverQuotaNow } from './period-rollover'
import { isDailyQuota } from './quota-prompts'

/** One action on one prompt. `did: false` is "consider". */
export interface PromptAction {
  key: string
  did: boolean
}

interface PlannedAction extends ParsedPromptKey {
  key: string
  did: boolean
}

/**
 * Check every key before anything is written — the batch is all or nothing.
 *
 * Refused: a malformed key; a key for another day (a stale payload from
 * before midnight must not act on today); a task that is not the user's own,
 * live quota (prompts are never shown for someone else's shared quota, so an
 * action on one is a forged or stale request); a daily number outside 1..N, or
 * a non-zero number on a quota that prompts once a day.
 */
export function planPromptActions(
  userId: number,
  timezone: string,
  actions: PromptAction[],
  now: Date = new Date(),
): PlannedAction[] {
  const today = localDate(timezone, now)
  const bad: string[] = []
  const planned: PlannedAction[] = []
  for (const action of actions) {
    const parsed = parsePromptKey(action.key)
    const task = parsed ? getTaskById(parsed.taskId) : null
    const ok =
      parsed !== null &&
      parsed.date === today &&
      task !== null &&
      task.user_id === userId &&
      !task.deleted_at &&
      !task.done &&
      isTracked(task) &&
      (isDailyQuota(task)
        ? parsed.number >= 1 && parsed.number <= Math.max(1, task.progress_target)
        : parsed.number === 0)
    if (!ok || !parsed) {
      bad.push(action.key)
      continue
    }
    planned.push({ ...parsed, key: action.key, did: action.did })
  }
  if (bad.length > 0) {
    throw new ValidationError(`Invalid or stale prompt keys: ${bad.join(', ')}`)
  }
  return planned
}

export interface ExecutedPromptActions {
  snapshots: UndoSnapshot[]
  /** The union of fields any snapshot carries — the undo entry's `fieldsChanged`. */
  fieldsChanged: string[]
  /** Quotas whose count moved, for the `task.progressed` webhook after commit. */
  progressed: Task[]
  considered: number
  did: number
}

function addOnce(list: string[], key: string): string[] {
  return list.includes(key) ? list : [...list, key]
}

/** Apply one quota's actions to its count and today's record. */
function applyToQuota(
  task: Task,
  actions: PlannedAction[],
  today: string,
): { current: number; day: QuotaDayState; applied: number } {
  const daily = isDailyQuota(task)
  let current = task.progress_current ?? 0
  let day = dayStateFor(task.quota_day_state, today)
  let applied = 0
  for (const action of actions) {
    if (action.did) {
      const delta = daily
        ? Math.max(0, action.number - current)
        : day.did.includes(action.key)
          ? 0
          : 1
      current += delta
      applied += delta
      day = {
        ...day,
        logged: day.logged + delta,
        did: addOnce(day.did, action.key),
        considered: addOnce(day.considered, action.key),
      }
    } else {
      day = { ...day, considered: addOnce(day.considered, action.key) }
    }
  }
  return { current, day, applied }
}

/**
 * Apply planned actions inside the caller's transaction. Does NOT log to
 * undo — the caller owns the entry (its own, or `bulkDone`'s batch entry).
 */
export function executePromptActions(
  tx: Database.Database,
  userId: number,
  timezone: string,
  planned: PlannedAction[],
  now: Date = new Date(),
): ExecutedPromptActions {
  const today = localDate(timezone, now)
  const nowStr = now.toISOString()
  const byTask = new Map<number, PlannedAction[]>()
  for (const action of planned) {
    byTask.set(action.taskId, [...(byTask.get(action.taskId) ?? []), action])
  }

  const out: ExecutedPromptActions = {
    snapshots: [],
    fieldsChanged: [],
    progressed: [],
    considered: 0,
    did: 0,
  }
  const fields = new Set<string>()

  for (const [taskId, actions] of byTask) {
    rolloverQuotaNow(taskId, now)
    const task = getTaskById(taskId)
    if (!task) continue
    const { current, day, applied } = applyToQuota(task, actions, today)

    tx.prepare(
      'UPDATE tasks SET progress_current = ?, quota_day_state = ?, updated_at = ? WHERE id = ?',
    ).run(current, JSON.stringify(day), nowStr, taskId)
    if (applied > 0) {
      tx.prepare(
        'INSERT INTO progress_events (task_id, user_id, delta, logged_at) VALUES (?, ?, ?, ?)',
      ).run(taskId, userId, applied, nowStr)
    }

    // Per-task fields, so a consider-only snapshot never carries a count for
    // undo to write back over a +1 logged in between.
    const taskFields = applied > 0 ? ['progress_current', 'quota_day_state'] : ['quota_day_state']
    for (const f of taskFields) fields.add(f)
    const after = { ...task, progress_current: current, quota_day_state: day }
    out.snapshots.push(createQuotaSnapshot(task, after, taskFields))
    if (applied > 0) out.progressed.push(after)
    out.did += actions.filter((a) => a.did).length
    out.considered += actions.filter((a) => !a.did).length
  }
  out.fieldsChanged = [...fields]
  return out
}

export interface PromptActionsResult {
  considered: number
  did: number
  tasks: Task[]
}

/** What the undo entry and the toast say. */
export function describePromptActions(considered: number, did: number, title?: string): string {
  if (title && considered + did === 1) {
    return did === 1 ? `Did "${title}"` : `Considered "${title}"`
  }
  const parts: string[] = []
  if (did > 0) parts.push(`did ${did}`)
  if (considered > 0) parts.push(`considered ${considered}`)
  const text = parts.join(', ')
  return `Quota reminders: ${text}`
}

/** Dispatch after commit, the same event a +1 fires. */
export function dispatchProgressed(userId: number, tasks: Task[]): void {
  for (const task of tasks) {
    dispatchWebhookEvent(userId, 'task.progressed', {
      task: formatTaskResponse(task),
      progress_current: task.progress_current,
      progress_target: task.progress_target,
      met: task.progress_current >= task.progress_target,
    })
  }
}

/**
 * Consider and/or "did it" a set of prompts: one transaction, one undo entry.
 * The standalone path (POST /api/quota-prompts/consider and /did); a mixed
 * batch with reminders goes through `bulkDone({ prompts })` instead.
 */
export function actOnPrompts(options: {
  userId: number
  userTimezone: string
  actions: PromptAction[]
  now?: Date
}): PromptActionsResult {
  const { userId, userTimezone, actions, now = new Date() } = options
  if (actions.length === 0) return { considered: 0, did: 0, tasks: [] }
  const planned = planPromptActions(userId, userTimezone, actions, now)

  const result = withTransaction((tx) => {
    const executed = executePromptActions(tx, userId, userTimezone, planned, now)
    const single = planned.length === 1 ? getTaskById(planned[0].taskId) : null
    logAction(
      userId,
      'quota_prompt',
      describePromptActions(executed.considered, executed.did, single?.title),
      executed.fieldsChanged,
      executed.snapshots,
    )
    return executed
  })

  emitSyncEvent(userId)
  dispatchProgressed(userId, result.progressed)
  const ids = [...new Set(planned.map((p) => p.taskId))]
  return {
    considered: result.considered,
    did: result.did,
    tasks: ids.map((id) => getTaskById(id)).filter((t): t is Task => t !== null),
  }
}
