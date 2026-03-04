/**
 * Shared task summary builder for AI API routes
 *
 * Fetches active tasks and builds TaskSummary[] with project names resolved
 * in a single query (avoids N+1 per-task lookups).
 */

import { getTasks } from '@/core/tasks'
import { getProjectNameMap } from '@/core/projects'
import type { TaskSummary } from './types'

/**
 * Build task summaries for AI features.
 *
 * Fetches the user's active (not done) tasks and enriches them with
 * project names using a single bulk query instead of per-task lookups.
 */
export function buildTaskSummaries(userId: number): TaskSummary[] {
  const tasks = getTasks({ userId, done: false })
  if (tasks.length === 0) return []

  // Pre-fetch all project names in one query to avoid N+1
  const projectIds = [...new Set(tasks.map((t) => t.project_id))]
  const projectMap = getProjectNameMap(projectIds)

  return tasks.map((t) => ({
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
  }))
}
