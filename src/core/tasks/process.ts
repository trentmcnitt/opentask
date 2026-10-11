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
import { planProcess, type GrowthAsk } from '@/lib/process-rules'
import type { Task } from '@/types'
import { eligibleTasks } from './task-segments'
import { getTargetContext } from './target-context'

export interface ProcessData {
  inbox_project_id: number | null
  /** Open one-off tasks still in the Inbox, oldest first. */
  inbox: Task[]
  growth: ({ task: Task } & GrowthAsk)[]
  stale_targets: { task: Task; age_days: number }[]
  /** Stale targets on tasks with a deadline: listed apart, never pre-checked. */
  stale_targets_with_deadline: { task: Task; age_days: number }[]
}

export function getProcessData(userId: number, timezone: string, now = new Date()): ProcessData {
  const tasks = eligibleTasks(userId)
  const inboxId = getInboxId(userId)
  const inbox =
    inboxId === null
      ? []
      : tasks.filter((t) => t.project_id === inboxId).sort((a, b) => a.id - b.id)
  const plan = planProcess(tasks, timezone, now, getTargetContext(userId))
  return {
    inbox_project_id: inboxId,
    inbox,
    growth: plan.growth.map(({ task, ask }) => ({ task, ...ask })),
    stale_targets: plan.staleTargets.map(({ task, age }) => ({ task, age_days: age })),
    stale_targets_with_deadline: plan.staleTargetsWithDeadline.map(({ task, age }) => ({
      task,
      age_days: age,
    })),
  }
}
