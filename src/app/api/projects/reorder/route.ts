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

    // Filter to only owned projects (shared projects from other users are ignored)
    const placeholders = projectIds.map(() => '?').join(',')
    const ownedProjects = db
      .prepare(`SELECT id FROM projects WHERE id IN (${placeholders}) AND owner_id = ?`)
      .all(...projectIds, user.id) as { id: number }[]

    const ownedIds = new Set(ownedProjects.map((p) => p.id))

    // Build ordered list of only owned projects, preserving the user's intended order
    const ownedInOrder = projectIds.filter((id) => ownedIds.has(id))

    if (ownedInOrder.length === 0) {
      return badRequest('No valid owned projects to reorder')
    }

    withTransaction((txDb) => {
      const stmt = txDb.prepare('UPDATE projects SET sort_order = ? WHERE id = ? AND owner_id = ?')
      for (let i = 0; i < ownedInOrder.length; i++) {
        stmt.run(i, ownedInOrder[i], user.id)
      }
    })

    return success({ reordered: ownedInOrder.length })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'PATCH /api/projects/reorder error:', err)
    return handleError(err)
  }
}
