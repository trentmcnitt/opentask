/**
 * Track / quotas (REDESIGN-V03 §5)
 *
 * Every task is already a quota with target 1. Track generalises completion:
 * `progress_target` is how many times something should happen in a period, and
 * `progress_current` is how many have been logged.
 *
 * AT-TARGET BEHAVIOR IS PERIOD-ANCHORED (decided by Trent, 2026-07-26).
 * Reaching the target marks the row "met" — a visual state change, no completion
 * event. The row stays OPEN until the rrule's natural period boundary, and it is
 * that boundary's advance which fires the completion path and resets
 * `progress_current` to 0. Overflow is therefore observable: a third egg meal in
 * a 2x/week target displays as 3/2 rather than vanishing.
 *
 * The rejected alternative was auto-completing at target, which made overflow
 * unobservable — the row disappeared at 2/2 and the third never got recorded.
 *
 * An explicit complete-tap before the boundary still completes early; the user
 * is never prevented from closing something out.
 *
 * WHAT MUST NOT HAPPEN HERE:
 * - A sub-target increment must NOT dispatch `task.completed`. Anything
 *   downstream counting completions would over-count by the target.
 * - Tracked items are EXEMPT from the §4.1 notification cadence (see the
 *   `progress_target > 1` exclusion in overdue-checker). Without that exemption
 *   a tracked task with a due date gets the standard nag PLUS the pace nudge.
 * - Pace is deterministic view logic, never AI, and never a failure state.
 *   Per §1.2 the app is an instrument: it keeps the score it was asked to keep
 *   and shuts up otherwise.
 */

import { getDb, withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { nowUtc } from '@/core/recurrence'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import type { Task } from '@/types'
import { emitSyncEvent } from '@/lib/sync-events'

export interface IncrementProgressOptions {
  userId: number
  taskId: number
  /** Defaults to +1. Negative values correct a mis-log. */
  delta?: number
}

export interface IncrementProgressResult {
  task: Task
  /** True when this increment brought the task to or past its target. */
  met: boolean
  description: string
}

/** Is this task tracked (a quota) rather than an ordinary one-shot task? */
export function isTracked(task: Pick<Task, 'progress_target' | 'is_tracked'>): boolean {
  return task.is_tracked === true || (task.progress_target ?? 1) > 1
}

/**
 * Record progress on a tracked task.
 *
 * Deliberately does NOT complete the task at target — see the period-anchored
 * decision above. It dispatches `task.progressed`, never `task.completed`.
 */
export function incrementProgress(options: IncrementProgressOptions): IncrementProgressResult {
  const { userId, taskId, delta = 1 } = options

  const task = getTaskById(taskId)
  if (!task) throw new NotFoundError('Task not found')
  if (!canUserAccessTask(userId, task)) throw new ForbiddenError('Access denied')
  if (task.deleted_at) throw new ValidationError('Cannot log progress on a trashed task')
  if (!isTracked(task)) {
    throw new ValidationError(
      'Task is not tracked. Set a progress_target greater than 1 to track it.',
    )
  }

  // Progress never goes below zero — a correction can undo a mis-log but can't
  // manufacture negative history.
  const next = Math.max(0, (task.progress_current ?? 0) + delta)
  const nowStr = nowUtc()
  const met = next >= task.progress_target

  const updated = withTransaction((tx) => {
    tx.prepare('UPDATE tasks SET progress_current = ?, updated_at = ? WHERE id = ?').run(
      next,
      nowStr,
      taskId,
    )
    tx.prepare(
      'INSERT INTO progress_events (task_id, user_id, delta, logged_at) VALUES (?, ?, ?, ?)',
    ).run(taskId, userId, delta, nowStr)

    const after = { ...task, progress_current: next }
    logAction(
      userId,
      'progress',
      `Logged ${delta > 0 ? '+' : ''}${delta} on "${task.title}" (${next}/${task.progress_target})`,
      ['progress_current'],
      [createTaskSnapshot(task, after, ['progress_current'])],
    )
    return after
  })

  // Other tabs and the widgets learn about the new count the same way they
  // learn about every other mutation.
  emitSyncEvent(userId)

  // §5: progress is NOT completion. Firing task.completed here would make every
  // downstream counter over-count by the target.
  dispatchWebhookEvent(userId, 'task.progressed', {
    task: formatTaskResponse(updated),
    progress_current: next,
    progress_target: task.progress_target,
    met,
  })

  return {
    task: updated,
    met,
    description: `${next}/${task.progress_target}`,
  }
}

export type PaceState = 'on-pace' | 'behind' | 'met'

export interface Pace {
  state: PaceState
  current: number
  target: number
  /** 0..1 through the current period, or null when there is no period to measure. */
  periodElapsed: number | null
}

/**
 * Deterministic pace calculation — view logic, not AI (§5).
 *
 * Compares how far through the period we are against how much of the target is
 * logged. Returns 'behind' only when the shortfall is real, and callers must
 * treat that as information, not as failure: per L1 a 0/1 late in the week may
 * mean UNLOGGED, not undone. The user routinely stops recording mid-period out
 * of expertise, and an instrument that reads non-recording as failure is broken.
 */
export function computePace(
  task: Pick<Task, 'progress_current' | 'progress_target'>,
  periodElapsed: number | null,
): Pace {
  const current = task.progress_current ?? 0
  const target = task.progress_target ?? 1

  if (current >= target) {
    return { state: 'met', current, target, periodElapsed }
  }
  if (periodElapsed === null) {
    return { state: 'on-pace', current, target, periodElapsed }
  }

  const expected = target * periodElapsed
  return {
    state: current + 1 <= expected ? 'behind' : 'on-pace',
    current,
    target,
    periodElapsed,
  }
}

/**
 * Reset progress at a period boundary.
 *
 * Called by the completion path when a recurring tracked task advances to its
 * next occurrence — that advance IS the period rolling over.
 */
export function resetProgressForNewPeriod(tx: ReturnType<typeof getDb>, taskId: number): void {
  tx.prepare('UPDATE tasks SET progress_current = 0 WHERE id = ?').run(taskId)
}
