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
} from '@/lib/api-response'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import type { RouteContext } from '@/types/api'

interface ProjectRow {
  id: number
  name: string
  owner_id: number
  shared: number
  sort_order: number
  created_at: string
}

function getProjectById(projectId: number): ProjectRow | null {
  const db = getDb()
  return (
    (db
      .prepare(
        'SELECT id, name, owner_id, shared, sort_order, created_at FROM projects WHERE id = ?',
      )
      .get(projectId) as ProjectRow | undefined) ?? null
  )
}

function canAccessProject(userId: number, project: ProjectRow): boolean {
  return project.owner_id === userId || project.shared === 1
}

export async function GET(request: NextRequest, context: RouteContext) {
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

    const project = getProjectById(projectId)
    if (!project) {
      return notFound('Project not found', { project_id: projectId })
    }

    if (!canAccessProject(user.id, project)) {
      return notFound('Project not found', { project_id: projectId })
    }

    return success({
      id: project.id,
      name: project.name,
      owner_id: project.owner_id,
      shared: project.shared === 1,
      sort_order: project.sort_order,
      created_at: project.created_at,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('GET /api/projects/:id error:', err)
    return handleError(err)
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
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

    const project = getProjectById(projectId)
    if (!project) {
      return notFound('Project not found', { project_id: projectId })
    }

    // Only owner can edit (shared projects can be viewed but not edited by non-owners)
    if (project.owner_id !== user.id) {
      return forbidden('Only the project owner can edit this project')
    }

    const body = await request.json()
    const db = getDb()

    const updates: string[] = []
    const values: unknown[] = []

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return badRequest('Project name must be a non-empty string')
      }
      updates.push('name = ?')
      values.push(body.name.trim())
    }

    if (body.sort_order !== undefined) {
      if (typeof body.sort_order !== 'number') {
        return badRequest('sort_order must be a number')
      }
      updates.push('sort_order = ?')
      values.push(body.sort_order)
    }

    if (body.shared !== undefined) {
      updates.push('shared = ?')
      values.push(body.shared ? 1 : 0)
    }

    if (updates.length === 0) {
      return success({
        id: project.id,
        name: project.name,
        owner_id: project.owner_id,
        shared: project.shared === 1,
        sort_order: project.sort_order,
        created_at: project.created_at,
      })
    }

    values.push(projectId)

    const sql = `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...values)

    const updated = getProjectById(projectId)!

    return success({
      id: updated.id,
      name: updated.name,
      owner_id: updated.owner_id,
      shared: updated.shared === 1,
      sort_order: updated.sort_order,
      created_at: updated.created_at,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('PATCH /api/projects/:id error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
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

    const project = getProjectById(projectId)
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

    // Move all tasks in this project to Inbox
    db.prepare(
      `
      UPDATE tasks
      SET project_id = ?, updated_at = ?
      WHERE project_id = ?
    `,
    ).run(inbox.id, now, projectId)

    // Delete the project
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)

    return success({
      message: 'Project deleted',
      tasks_moved_to_inbox: true,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('DELETE /api/projects/:id error:', err)
    return handleError(err)
  }
}
