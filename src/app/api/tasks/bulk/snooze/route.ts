/**
 * Bulk Snooze API route
 *
 * POST /api/tasks/bulk/snooze - Snooze multiple tasks
 *
 * Body (absolute mode): { ids: [1, 2, 3, ...], until: "ISO8601 datetime" }
 * Body (relative mode): { ids: [1, 2, 3, ...], delta_minutes: 60 }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { validateBulkSnooze } from '@/core/validation'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateBulkSnooze(body)

    const result = bulkSnooze({
      userId: user.id,
      taskIds: input.ids,
      until: input.until,
      deltaMinutes: input.delta_minutes,
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
    console.error('POST /api/tasks/bulk/snooze error:', err)
    return handleError(err)
  }
}
