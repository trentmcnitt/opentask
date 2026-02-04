/**
 * Review API route
 *
 * GET /api/review - Create a review session with grouped, numbered tasks
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { createReviewSession } from '@/core/review/session'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { sessionId, groups } = createReviewSession(user.id)

    return success({
      session_id: sessionId,
      groups: groups.map((g) => ({
        label: g.label,
        tasks: g.items.map((item) => ({
          seq: item.seq,
          id: item.task.id,
          title: item.task.title,
          due_at: item.task.due_at,
          priority: item.task.priority,
          rrule: item.task.rrule,
          labels: item.task.labels,
        })),
      })),
      total_tasks: groups.reduce((sum, g) => sum + g.items.length, 0),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/review error:', err)
    return handleError(err)
  }
}
