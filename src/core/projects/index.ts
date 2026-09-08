/**
 * Project operations module
 *
 * Provides direct database access for project queries,
 * used by API routes (and available to server components).
 */

import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { formatProjectResponse, type ProjectRow } from '@/lib/format-project'
import type { Project } from '@/types'

/**
 * Bulk project name lookup — returns a Map of id→name for the given project IDs.
 * Runs a single query regardless of how many IDs are passed.
 */
export function getProjectNameMap(projectIds: number[]): Map<number, string> {
  const map = new Map<number, string>()
  if (projectIds.length === 0) return map

  const db = getDb()
  const placeholders = projectIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT id, name FROM projects WHERE id IN (${placeholders})`)
    .all(...projectIds) as { id: number; name: string }[]
  for (const row of rows) {
    map.set(row.id, row.name)
  }
  return map
}

/**
 * Get all projects accessible to a user (owned + shared), with task counts.
 *
 * The counts are of what the project's list will actually show, so the two
 * populations that are not tasks are excluded: reminders (§6) from
 * `overdue_count`, as before, and quotas (§5) from both — a quota is never in
 * a project's list and is never late (Trent, 2026-09-08). Spelled as
 * `is_tracked = 0 AND progress_target <= 1` because that is the negation of
 * `isTracked` (src/lib/track.ts), which either column can satisfy on its own.
 */
export function getProjects(userId: number): Project[] {
  const db = getDb()
  const now = nowUtc()

  const rows = db
    .prepare(
      `
      SELECT p.id, p.name, p.owner_id, p.shared, p.sort_order, p.color, p.created_at,
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id = p.id AND t.user_id = ?
           AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
           AND t.is_tracked = 0 AND t.progress_target <= 1
        ) AS active_count,
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id = p.id AND t.user_id = ?
           AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
           AND t.is_reminder = 0
           AND t.is_tracked = 0 AND t.progress_target <= 1
           AND t.due_at IS NOT NULL AND datetime(t.due_at) < datetime(?)
        ) AS overdue_count
      FROM projects p
      WHERE p.owner_id = ? OR p.shared = 1
      ORDER BY p.sort_order ASC, p.name ASC
    `,
    )
    .all(userId, userId, now, userId) as ProjectRow[]

  return rows.map(formatProjectResponse)
}
