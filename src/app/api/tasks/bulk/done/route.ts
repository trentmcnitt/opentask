/**
 * Bulk Done API route
 *
 * POST /api/tasks/bulk/done - Mark multiple tasks as done
 *
 * Body: { ids: [1, 2, 3, ...] }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkDone } from '@/core/tasks'
import { validateBulkDone } from '@/core/validation'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateBulkDone(body)

    const result = bulkDone({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds: input.ids,
    })

    return success({
      tasks_affected: result.tasksAffected,
      recurring_count: result.recurringCount,
      one_off_count: result.oneOffCount,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    console.error('POST /api/tasks/bulk/done error:', err)
    return handleError(err)
  }
}
