/**
 * Process (2026-10-10 task model, spec §5) — the read behind `GET /api/process`.
 *
 * Reads the user's segment-eligible tasks once (own, open, one-off, not a
 * reminder or quota — the same set the task segments draw from) and hands them
 * to the pure rules in `src/lib/process-rules.ts`. Read-only: every write
 * Process makes goes through the existing endpoints (PATCH, bulk edit, target
 * today, delete), so each is atomic and undo-logged by the path it already has.
 *
 * Possible duplicates and the AI's project recommendation are not here: they
 * are AI calls of their own (`/api/process/duplicates`,
 * `/api/process/recommend-projects`), so this read stays fast and works with
 * AI off.
 */

import { getInboxId } from '@/core/projects'
import { getDb } from '@/core/db'
import { planProcess, type GrowthAsk } from '@/lib/process-rules'
import type { Task } from '@/types'
import { eligibleTasks } from './task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { dayBoundaryForUser } from './rollover-time'

export interface ProcessData {
  inbox_project_id: number | null
  /**
   * Open tasks still in the Inbox, oldest first — the dashboard's own Inbox
   * group: own, open, neither a reminder nor a quota, recurring ones included.
   * It used to take only the one-off tasks the other steps work on, so Process
   * said "4 left in the Inbox" over a list whose Inbox header said 5 (visual
   * QA 2026-10-11; Trent: one count source). Filing a recurring task into a
   * project is as useful as filing a one-off one.
   */
  inbox: Task[]
  growth: ({ task: Task } & GrowthAsk)[]
  /** Tasks at 3× attempts or more (spec §7), offered for target removal. */
  stale_targets: { task: Task; attempts: number }[]
  /** The same on tasks with a deadline: listed apart, never pre-checked ("Back to auto"). */
  stale_targets_with_deadline: { task: Task; attempts: number }[]
}

export function getProcessData(userId: number, timezone: string, now = new Date()): ProcessData {
  const tasks = eligibleTasks(userId)
  const inboxId = getInboxId(userId)
  const inbox = inboxId === null ? [] : inboxTasks(userId, inboxId)
  const plan = planProcess(tasks, timezone, now, dayBoundaryForUser(userId))
  return {
    inbox_project_id: inboxId,
    inbox,
    growth: plan.growth.map(({ task, ask }) => ({ task, ...ask })),
    stale_targets: plan.staleTargets,
    stale_targets_with_deadline: plan.staleTargetsWithDeadline,
  }
}

/** The Inbox as the dashboard groups it — see `ProcessData.inbox`. */
function inboxTasks(userId: number, inboxId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
       WHERE user_id = ? AND project_id = ? AND done = 0 AND deleted_at IS NULL
         AND archived_at IS NULL AND is_reminder = 0 AND is_tracked = 0
         AND progress_target <= 1
       ORDER BY id`,
    )
    .all(userId, inboxId) as TaskRow[]
  return rows.map(rowToTask)
}
