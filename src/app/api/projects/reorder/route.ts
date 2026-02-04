/**
 * PATCH /api/projects/reorder
 *
 * Bulk-update project sort_order based on array position.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb, withTransaction } from '@/core/db'
import { log } from '@/lib/logger'

export async function PATCH(request: NextRequest) {
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

    const db = getDb()

    // Verify all projects belong to the user
    const placeholders = projectIds.map(() => '?').join(',')
    const ownedProjects = db
      .prepare(`SELECT id FROM projects WHERE id IN (${placeholders}) AND owner_id = ?`)
      .all(...projectIds, user.id) as { id: number }[]

    if (ownedProjects.length !== projectIds.length) {
      return badRequest('Some project IDs are invalid or not owned by you')
    }

    withTransaction((txDb) => {
      const stmt = txDb.prepare('UPDATE projects SET sort_order = ? WHERE id = ? AND owner_id = ?')
      for (let i = 0; i < projectIds.length; i++) {
        stmt.run(i, projectIds[i], user.id)
      }
    })

    return success({ reordered: projectIds.length })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'PATCH /api/projects/reorder error:', err)
    return handleError(err)
  }
}
