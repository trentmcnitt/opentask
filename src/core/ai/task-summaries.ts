/**
 * Shared task summary builder for AI API routes
 *
 * Fetches active tasks and builds TaskSummary[] with project names resolved
 * in a single query (avoids N+1 per-task lookups).
 */

import { getDb } from '@/core/db'
import { getTasks } from '@/core/tasks'
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
  const db = getDb()
  const projectIds = [...new Set(tasks.map((t) => t.project_id))]
  const projectMap = new Map<number, string>()

  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, name FROM projects WHERE id IN (${placeholders})`)
      .all(...projectIds) as { id: number; name: string }[]
    for (const row of rows) {
      projectMap.set(row.id, row.name)
    }
  }

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
  }))
}
