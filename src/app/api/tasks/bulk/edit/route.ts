/**
 * Bulk Edit API route
 *
 * POST /api/tasks/bulk/edit - Edit multiple tasks
 *
 * Body: { ids: [1, 2, 3, ...], changes: { priority: 3, ... } }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkEdit } from '@/core/tasks'
import { validateBulkEdit } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateBulkEdit(body)

    const result = bulkEdit({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds: input.ids,
      changes: input.changes,
    })

    return success({
      tasks_affected: result.tasksAffected,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks/bulk/edit error:', err)
    return handleError(err)
  }
}
