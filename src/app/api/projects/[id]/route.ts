/**
 * Single Project API routes
 *
 * GET /api/projects/:id - Get a project
 * PATCH /api/projects/:id - Update a project (owner only; the Inbox can't be renamed)
 * DELETE /api/projects/:id - Delete a project (moves each member's tasks to their own Inbox first)
 *
 * The rules live in src/core/projects; these handlers authenticate, parse the
 * id and map errors. A 404 keeps its `details: { project_id }`.
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError, NotFoundError } from '@/core/errors'
import {
  success,
  unauthorized,
  badRequest,
  notFound,
  handleError,
  handleZodError,
  parseRouteId,
} from '@/lib/api-response'
import { deleteProject, getProjectById, updateProject } from '@/core/projects'
import { validateProjectUpdate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'

function projectNotFound(projectId: number) {
  return notFound('Project not found', { project_id: projectId })
}

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const projectId = parseRouteId(id)
    if (projectId === null) return badRequest('Invalid project ID')

    const project = getProjectById(projectId, user.id)
    if (!project) return projectNotFound(projectId)

    return success(project)
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/projects/:id error:', err)
    return handleError(err)
  }
})

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  let projectId: number | null = null
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    projectId = parseRouteId(id)
    if (projectId === null) return badRequest('Invalid project ID')

    const input = validateProjectUpdate(await request.json())
    return success(updateProject(user.id, projectId, input))
  } catch (err) {
    if (err instanceof NotFoundError && projectId !== null) return projectNotFound(projectId)
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'PATCH /api/projects/:id error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  let projectId: number | null = null
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    projectId = parseRouteId(id)
    if (projectId === null) return badRequest('Invalid project ID')

    deleteProject(user.id, projectId)

    return success({
      message: 'Project deleted',
      tasks_moved_to_inbox: true,
    })
  } catch (err) {
    if (err instanceof NotFoundError && projectId !== null) return projectNotFound(projectId)
    if (!(err instanceof AppError)) log.error('api', 'DELETE /api/projects/:id error:', err)
    return handleError(err)
  }
})
