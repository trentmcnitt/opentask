/**
 * PATCH /api/projects/reorder
 *
 * Bulk-update project sort_order based on array position. Only the caller's
 * own projects are reordered (see reorderProjects in src/core/projects).
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { reorderProjects } from '@/core/projects'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const PATCH = withLogging(async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const body = await request.json()

    if (!Array.isArray(body.project_ids) || body.project_ids.length === 0) {
      return badRequest('project_ids must be a non-empty array of project IDs')
    }

    const projectIds: number[] = body.project_ids
    if (projectIds.some((id) => typeof id !== 'number' || !Number.isInteger(id))) {
      return badRequest('All project_ids must be integers')
    }

    return success({ reordered: reorderProjects(user.id, projectIds) })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'PATCH /api/projects/reorder error:', err)
    return handleError(err)
  }
})
