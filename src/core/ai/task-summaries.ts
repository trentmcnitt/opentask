/**
 * Shared task summary builder for AI API routes
 *
 * Fetches active tasks and builds TaskSummary[] with project names resolved
 * in a single query (avoids N+1 per-task lookups).
 */

import { getTasks } from '@/core/tasks'
import { getProjectNameMap } from '@/core/projects'
import { getTargetContext } from '@/core/tasks/target-context'
import { effectiveTargetAt, type TargetContext } from '@/lib/task-segments'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'
import type { TaskSummary } from './types'

/** How many tasks What's Next and Insights see at most. */
export const AI_SUMMARY_CAP = 200

/**
 * The part of the cap kept for tasks with no stored target — untargeted tasks
 * and deadline-only ones. See `pickSummaryTasks`.
 */
export const AI_SUMMARY_UNTARGETED_SHARE = 100

/**
 * Which tasks the AI summaries keep when a user has more than the cap.
 *
 * The task list's own order (target ascending, no target LAST) would fill the
 * cap with targeted tasks and drop every untargeted one first — and those are
 * exactly what Insights and What's Next exist to catch: the forgotten task with
 * no date, and the deadline-only task (whose target is implied, not stored).
 * So the cap is split in two:
 *
 * - each side (stored target / none) is guaranteed AI_SUMMARY_UNTARGETED_SHARE
 *   (half the cap) when it has that many;
 * - a side with fewer hands its unused share to the other.
 *
 * Within a side the order decides what goes: targeted by soonest target (the
 * overdue first, the far future dropped first); untargeted with deadline-only
 * tasks first, soonest deadline first (they nag from an implied target), then
 * the rest by priority, oldest first (`orderUntargeted`). Both inputs must
 * already exclude quotas.
 */
export function pickSummaryTasks<T>(targeted: T[], untargeted: T[]): T[] {
  const untargetedTake = Math.max(AI_SUMMARY_UNTARGETED_SHARE, AI_SUMMARY_CAP - targeted.length)
  const keptUntargeted = untargeted.slice(0, untargetedTake)
  const keptTargeted = targeted.slice(0, AI_SUMMARY_CAP - keptUntargeted.length)
  return [...keptTargeted, ...keptUntargeted]
}

/** Deadline-only tasks first (soonest deadline first); the rest keep their order. */
export function orderUntargeted<T extends { deadline_at: string | null }>(tasks: T[]): T[] {
  const withDeadline = tasks
    .filter((t) => t.deadline_at !== null)
    .sort((a, b) => Date.parse(a.deadline_at!) - Date.parse(b.deadline_at!))
  return [...withDeadline, ...tasks.filter((t) => t.deadline_at === null)]
}

/**
 * Untargeted tasks are read in full before the cap is applied: the list's SQL
 * order (priority, then id) knows nothing of deadlines, so a LIMIT there could
 * cut a deadline-only task before `orderUntargeted` sees it. Targeted tasks
 * need only the cap — their SQL order (soonest target) is the order we keep.
 */
const UNTARGETED_FETCH_LIMIT = 100_000

/**
 * Show the target the task actually nags from (2026-10-10): a deadline-only
 * task — or one whose own target falls after its deadline — nags from the
 * implied target (the user's morning DEADLINE_LEAD_DAYS before the deadline,
 * `effectiveTargetAt`). Without this the model reads such a task as "target:
 * none", i.e. forgotten and undated. `target_implied` marks the swap so the
 * line can say "(from deadline)".
 *
 * Pure (context and clock passed in); the quality harness applies it to its
 * scenario tasks too, so the prompts it judges match production.
 */
export function withEffectiveSummaryTarget(
  summary: TaskSummary,
  ctx: TargetContext,
  now: Date = new Date(),
  deadlineNagOff = false,
): TaskSummary {
  const effective = effectiveTargetAt(
    {
      due_at: summary.due_at,
      deadline_at: summary.deadline_at ?? null,
      rrule: summary.rrule,
      deadline_nag_off: deadlineNagOff,
    },
    ctx,
    now,
  )
  if (effective === summary.due_at) return summary
  return { ...summary, due_at: effective, target_implied: effective !== null }
}

/**
 * Build task summaries for AI features.
 *
 * Fetches the user's active (not done) tasks and enriches them with
 * project names using a single bulk query instead of per-task lookups.
 *
 * Quotas are not candidates (§5). What's-Next and Insights answer questions
 * about the task list, and a quota is not in it — recommending one would
 * return an id the dashboard cannot show, which inflates the AI chip's count
 * and points it at a row that isn't there. "Four times this week" also has
 * none of the inputs these features reason over: no due date, no deadline, no
 * debt.
 */
export function buildTaskSummaries(userId: number): TaskSummary[] {
  const fetch = (hasTarget: boolean, limit: number): Task[] =>
    getTasks({ userId, done: false, hasTarget, limit }).filter((t) => !isTracked(t))
  const tasks = pickSummaryTasks(
    fetch(true, AI_SUMMARY_CAP),
    orderUntargeted(fetch(false, UNTARGETED_FETCH_LIMIT)),
  )
  if (tasks.length === 0) return []

  // Pre-fetch all project names in one query to avoid N+1
  const projectIds = [...new Set(tasks.map((t) => t.project_id))]
  const projectMap = getProjectNameMap(projectIds)
  const ctx = getTargetContext(userId)
  const now = new Date()

  return tasks.map((t) =>
    withEffectiveSummaryTarget(
      {
        id: t.id,
        title: t.title,
        priority: t.priority,
        due_at: t.due_at,
        original_due_at: t.original_due_at,
        created_at: t.created_at,
        labels: t.labels,
        project_name: projectMap.get(t.project_id) ?? null,
        is_recurring: t.rrule !== null,
        rrule: t.rrule,
        notes: t.notes,
        recurrence_mode: t.recurrence_mode,
        deadline_at: t.deadline_at,
        horizon: t.horizon,
      },
      ctx,
      now,
      t.deadline_nag_off,
    ),
  )
}
