/**
 * Bulk Delete API route
 *
 * POST /api/tasks/bulk/delete - Soft delete multiple tasks
 *
 * Body: { ids: [1, 2, 3, ...] }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkDelete } from '@/core/tasks'
import { validateBulkDelete } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateBulkDelete(body)

    const result = bulkDelete({
      userId: user.id,
      taskIds: input.ids,
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
    log.error('api', 'POST /api/tasks/bulk/delete error:', err)
    return handleError(err)
  }
}
