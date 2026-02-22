/**
 * Single Project API routes
 *
 * GET /api/projects/:id - Get a project
 * PATCH /api/projects/:id - Update a project
 * DELETE /api/projects/:id - Delete a project (moves tasks to Inbox first)
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  notFound,
  forbidden,
  badRequest,
  handleError,
  handleZodError,
} from '@/lib/api-response'
import { getDb, withTransaction } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { validateProjectUpdate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { formatProjectResponse, type ProjectRow } from '@/lib/format-project'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'

function getProjectById(projectId: number, userId: number): ProjectRow | null {
  const db = getDb()
  const now = nowUtc()
  return (
    (db
      .prepare(
        `SELECT p.id, p.name, p.owner_id, p.shared, p.sort_order, p.color, p.created_at,
          (SELECT COUNT(*) FROM tasks t
           WHERE t.project_id = p.id AND t.user_id = ?
             AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
          ) AS active_count,
          (SELECT COUNT(*) FROM tasks t
           WHERE t.project_id = p.id AND t.user_id = ?
             AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
             AND t.due_at IS NOT NULL AND datetime(t.due_at) < datetime(?)
          ) AS overdue_count
        FROM projects p WHERE p.id = ?`,
      )
      .get(userId, userId, now, projectId) as ProjectRow | undefined) ?? null
  )
}

function canAccessProject(userId: number, project: ProjectRow): boolean {
  return project.owner_id === userId || project.shared === 1
}

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const projectId = parseInt(id)

    if (isNaN(projectId)) {
      return notFound('Project not found', { id })
    }

    const project = getProjectById(projectId, user.id)
    if (!project) {
      return notFound('Project not found', { project_id: projectId })
    }

    if (!canAccessProject(user.id, project)) {
      return notFound('Project not found', { project_id: projectId })
    }

    return success(formatProjectResponse(project))
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/projects/:id error:', err)
    return handleError(err)
  }
})

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const projectId = parseInt(id)

    if (isNaN(projectId)) {
      return notFound('Project not found', { id })
    }

    const project = getProjectById(projectId, user.id)
    if (!project) {
      return notFound('Project not found', { project_id: projectId })
    }

    // Only owner can edit (shared projects can be viewed but not edited by non-owners)
    if (project.owner_id !== user.id) {
      return forbidden('Only the project owner can edit this project')
    }

    const input = validateProjectUpdate(await request.json())
    const db = getDb()

    const updates: string[] = []
    const values: unknown[] = []

    if (input.name !== undefined) {
      updates.push('name = ?')
      values.push(input.name.trim())
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

    if (updates.length === 0) {
      return success(formatProjectResponse(project))
    }

    values.push(projectId)

    const sql = `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...values)

    const updated = getProjectById(projectId, user.id)!

    return success(formatProjectResponse(updated))
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'PATCH /api/projects/:id error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const projectId = parseInt(id)

    if (isNaN(projectId)) {
      return notFound('Project not found', { id })
    }

    const project = getProjectById(projectId, user.id)
    if (!project) {
      return notFound('Project not found', { project_id: projectId })
    }

    // Only owner can delete
    if (project.owner_id !== user.id) {
      return forbidden('Only the project owner can delete this project')
    }

    // Cannot delete Inbox
    if (project.name === 'Inbox') {
      return badRequest('Cannot delete Inbox project')
    }

    const db = getDb()

    // Get user's inbox to move tasks there
    const inbox = db
      .prepare('SELECT id FROM projects WHERE owner_id = ? AND name = ?')
      .get(user.id, 'Inbox') as { id: number } | undefined

    if (!inbox) {
      return badRequest('Cannot delete project: Inbox not found')
    }

    const now = nowUtc()

    withTransaction((txDb) => {
      // Move all tasks in this project to Inbox
      txDb
        .prepare(
          `
        UPDATE tasks
        SET project_id = ?, updated_at = ?
        WHERE project_id = ?
      `,
        )
        .run(inbox.id, now, projectId)

      // Delete the project
      txDb.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    })

    return success({
      message: 'Project deleted',
      tasks_moved_to_inbox: true,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'DELETE /api/projects/:id error:', err)
    return handleError(err)
  }
})
