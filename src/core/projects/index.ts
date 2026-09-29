/**
 * Project operations module
 *
 * Project reads and CRUD, used by the /api/projects routes, createTask (the
 * Inbox lookup) and export. Project changes are not undoable and not in the
 * undo log (AGENTS.md § Critical Requirements): deleting a project hard-deletes
 * the row after moving its tasks to Inbox.
 */

import { getDb, withTransaction } from '@/core/db'
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors'
import { nowUtc } from '@/core/recurrence'
import { countCurrentlyDueByProject } from '@/core/tasks/currently-due'
import type { ProjectCreateInput, ProjectUpdateInput } from '@/core/validation'
import { formatProjectResponse, type ProjectRow } from '@/lib/format-project'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { emitSyncEvent } from '@/lib/sync-events'
import type { Project } from '@/types'

const INBOX_NAME = 'Inbox'

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
 * The columns every project read returns, plus `active_count`: the caller's
 * own tasks in the project that its list will actually show. Quotas (§5) are
 * excluded — a quota is never in a project's list (Trent, 2026-09-08). Spelled
 * as `is_tracked = 0 AND progress_target <= 1` because that is the negation of
 * `isTracked` (src/lib/track.ts), which either column can satisfy on its own.
 * Binds one parameter: the caller's user id.
 *
 * `overdue_count` is not SQL: it comes from `countCurrentlyDueByProject`, the
 * same "due right now" rule as the badge, the notifier and the sweep (§4.6).
 * That rule already excludes reminders (§6: no debt) and quotas (never late),
 * and asks the schedule about a recurring task with no due_at, which a plain
 * `due_at < now` could not (Trent, 2026-09-29).
 *
 * The list and the single-project read share this, so their counts agree.
 */
const PROJECT_SELECT = `
  SELECT p.id, p.name, p.owner_id, p.shared, p.sort_order, p.color, p.created_at,
    (SELECT COUNT(*) FROM tasks t
     WHERE t.project_id = p.id AND t.user_id = ?
       AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
       AND t.is_tracked = 0 AND t.progress_target <= 1
    ) AS active_count
  FROM projects p`

type ProjectRowWithoutOverdue = Omit<ProjectRow, 'overdue_count'>

function withOverdue(rows: ProjectRowWithoutOverdue[], userId: number): Project[] {
  const due = countCurrentlyDueByProject(userId)
  return rows.map((row) => formatProjectResponse({ ...row, overdue_count: due.get(row.id) ?? 0 }))
}

/**
 * Get all projects accessible to a user (owned + shared), with task counts.
 * The counts are of the caller's own tasks — see PROJECT_SELECT.
 */
export function getProjects(userId: number): Project[] {
  const rows = getDb()
    .prepare(
      `${PROJECT_SELECT}
      WHERE p.owner_id = ? OR p.shared = 1
      ORDER BY p.sort_order ASC, p.name ASC`,
    )
    .all(userId, userId) as ProjectRowWithoutOverdue[]
  return withOverdue(rows, userId)
}

/**
 * One project with the same counts as `getProjects`, or null when it doesn't
 * exist or the user can't see it (not the owner, and not shared).
 */
export function getProjectById(projectId: number, userId: number): Project | null {
  const row = getDb()
    .prepare(`${PROJECT_SELECT} WHERE p.id = ? AND (p.owner_id = ? OR p.shared = 1)`)
    .get(userId, projectId, userId) as ProjectRowWithoutOverdue | undefined
  return row ? withOverdue([row], userId)[0] : null
}

/** The id of the user's Inbox — their own project named "Inbox" — or null. */
export function getInboxId(userId: number): number | null {
  const row = getDb()
    .prepare('SELECT id FROM projects WHERE owner_id = ? AND name = ?')
    .get(userId, INBOX_NAME) as { id: number } | undefined
  return row?.id ?? null
}

/** A color none of the user's other projects uses yet, else any color. */
function pickProjectColor(userId: number): string {
  const rows = getDb()
    .prepare('SELECT color FROM projects WHERE owner_id = ? AND color IS NOT NULL')
    .all(userId) as { color: string }[]
  const used = new Set(rows.map((r) => r.color))
  const available = LABEL_COLOR_NAMES.filter((c) => !used.has(c))
  const pool = available.length > 0 ? available : LABEL_COLOR_NAMES
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * Create a project owned by the user. A new project goes at the END of the
 * user's order unless placed explicitly: defaulting to 0 left every new
 * project tied at the top, which Settings and the dashboard then had to break
 * by name. With no color given, one is picked at random, preferring colors
 * the user's other projects don't use.
 */
export function createProject(userId: number, input: ProjectCreateInput): Project {
  const db = getDb()
  const sortOrder =
    input.sort_order ??
    (
      db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects WHERE owner_id = ?',
        )
        .get(userId) as { next: number }
    ).next
  const color = input.color ?? pickProjectColor(userId)

  const result = db
    .prepare(
      `INSERT INTO projects (name, owner_id, shared, sort_order, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.name.trim(), userId, input.shared ? 1 : 0, sortOrder, color, nowUtc())

  // A new project has no tasks, so there are no counts to compute.
  const row = db
    .prepare(
      'SELECT id, name, owner_id, shared, sort_order, color, created_at FROM projects WHERE id = ?',
    )
    .get(Number(result.lastInsertRowid)) as Omit<ProjectRowWithoutOverdue, 'active_count'>
  return formatProjectResponse({ ...row, active_count: 0, overdue_count: 0 })
}

/**
 * The project, for its owner only. A missing project is a 404; anyone else's —
 * shared or not — is a 403 with the given message.
 */
function requireOwnedProject(
  projectId: number,
  userId: number,
  forbiddenMessage: string,
): { name: string } {
  const project = getDb()
    .prepare('SELECT owner_id, name FROM projects WHERE id = ?')
    .get(projectId) as { owner_id: number; name: string } | undefined
  if (!project) throw new NotFoundError('Project not found')
  if (project.owner_id !== userId) throw new ForbiddenError(forbiddenMessage)
  return project
}

/**
 * Update a project's name, order, sharing or color. Owner only.
 *
 * The Inbox can't be renamed: getInboxId — and so createTask and
 * deleteProject — finds the Inbox by its name, so a renamed Inbox would leave
 * the user without one. "Renaming" it to "Inbox" is a no-op and allowed.
 */
export function updateProject(
  userId: number,
  projectId: number,
  input: ProjectUpdateInput,
): Project {
  const project = requireOwnedProject(
    projectId,
    userId,
    'Only the project owner can edit this project',
  )

  const name = input.name?.trim()
  if (name !== undefined && project.name === INBOX_NAME && name !== INBOX_NAME) {
    throw new ValidationError('Cannot rename Inbox project')
  }

  const updates: string[] = []
  const values: unknown[] = []
  if (name !== undefined) {
    updates.push('name = ?')
    values.push(name)
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?')
    values.push(input.sort_order)
  }
  if (input.shared !== undefined) {
    updates.push('shared = ?')
    values.push(input.shared ? 1 : 0)
  }
  if (input.color !== undefined) {
    updates.push('color = ?')
    values.push(input.color)
  }
  if (updates.length > 0) {
    getDb()
      .prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values, projectId)
  }

  return getProjectById(projectId, userId)!
}

/**
 * Delete a project. Owner only, and never the Inbox.
 *
 * Its tasks are moved out first — the tasks.project_id foreign key would
 * refuse the delete otherwise — and each task goes to ITS OWNER's Inbox. In a
 * shared project other members' tasks sit beside the owner's; moving them into
 * the owner's Inbox would put them in a project the member can't see (Trent,
 * 2026-09-29). Every task in the project moves, whatever its state (done,
 * trashed, archived). If any affected user has no Inbox the delete is refused
 * before anything changes. Afterwards every affected user's open tabs and
 * widgets are refreshed.
 */
export function deleteProject(userId: number, projectId: number): void {
  const project = requireOwnedProject(
    projectId,
    userId,
    'Only the project owner can delete this project',
  )
  if (project.name === INBOX_NAME) throw new ValidationError('Cannot delete Inbox project')

  const db = getDb()
  const members = (
    db.prepare('SELECT DISTINCT user_id FROM tasks WHERE project_id = ?').all(projectId) as {
      user_id: number
    }[]
  ).map((r) => r.user_id)

  const inboxes = new Map<number, number>()
  for (const memberId of new Set([userId, ...members])) {
    const inboxId = getInboxId(memberId)
    if (inboxId === null) throw new ValidationError('Cannot delete project: Inbox not found')
    inboxes.set(memberId, inboxId)
  }

  const now = nowUtc()
  withTransaction((txDb) => {
    const move = txDb.prepare(
      'UPDATE tasks SET project_id = ?, updated_at = ? WHERE project_id = ? AND user_id = ?',
    )
    for (const memberId of members) move.run(inboxes.get(memberId), now, projectId, memberId)
    txDb.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })

  for (const memberId of inboxes.keys()) emitSyncEvent(memberId)
}

/**
 * Set sort_order from array position, for the user's own projects only:
 * other users' shared projects in the list are skipped, and the owned ones
 * keep the order they were given in. Returns how many were reordered.
 */
export function reorderProjects(userId: number, projectIds: number[]): number {
  const placeholders = projectIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT id FROM projects WHERE id IN (${placeholders}) AND owner_id = ?`)
    .all(...projectIds, userId) as { id: number }[]
  const owned = new Set(rows.map((p) => p.id))
  const ownedInOrder = projectIds.filter((id) => owned.has(id))
  if (ownedInOrder.length === 0) throw new ValidationError('No valid owned projects to reorder')

  withTransaction((txDb) => {
    const stmt = txDb.prepare('UPDATE projects SET sort_order = ? WHERE id = ? AND owner_id = ?')
    ownedInOrder.forEach((id, i) => stmt.run(i, id, userId))
  })
  return ownedInOrder.length
}
