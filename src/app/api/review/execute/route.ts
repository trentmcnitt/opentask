/**
 * Review Execute API route
 *
 * POST /api/review/execute - Execute batch actions from a review session
 *
 * Body:
 * {
 *   session_id: string,
 *   actions: [
 *     { type: "done", targets: ["1", "3-5"] },
 *     { type: "snooze", targets: ["2"], until: "2024-01-01T09:00:00Z" },
 *     { type: "skip", targets: ["6"] }
 *   ]
 * }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  badRequest,
  handleError,
  handleZodError,
  conflict,
} from '@/lib/api-response'
import { getReviewSession, resolveSeqNumbers, deleteReviewSession } from '@/core/review/session'
import { bulkDone, bulkSnooze } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { log } from '@/lib/logger'
import { z, ZodError } from 'zod'

const reviewActionSchema = z.object({
  type: z.enum(['done', 'snooze', 'skip']),
  targets: z.array(z.string()).min(1),
  until: z.string().optional(),
})

const reviewExecuteSchema = z.object({
  session_id: z.string().min(1),
  actions: z.array(reviewActionSchema).min(1),
})

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const { session_id, actions } = reviewExecuteSchema.parse(body)

    // Validate session
    const session = getReviewSession(session_id, user.id)
    if (!session) {
      return conflict('Review session not found or expired', { session_id })
    }

    // Process actions
    const results: { type: string; taskIds: number[]; count: number }[] = []

    for (const action of actions) {
      const taskIds = resolveSeqNumbers(session, action.targets)

      switch (action.type) {
        case 'done': {
          const result = bulkDone({ userId: user.id, taskIds, userTimezone: user.timezone })
          results.push({ type: 'done', taskIds, count: result.tasksAffected })
          dismissNotificationsForTasks(user.id, taskIds)
          break
        }
        case 'snooze': {
          if (!action.until) {
            return badRequest('snooze action requires "until" field')
          }
          const result = bulkSnooze({
            userId: user.id,
            userTimezone: user.timezone,
            taskIds,
            until: action.until,
          })
          results.push({ type: 'snooze', taskIds, count: result.tasksAffected })
          dismissNotificationsForTasks(user.id, taskIds)
          break
        }
        case 'skip': {
          // Skip = no action, just acknowledge
          results.push({ type: 'skip', taskIds, count: taskIds.length })
          break
        }
      }
    }

    // Clean up session after execution
    deleteReviewSession(session_id)

    return success({
      executed: true,
      results,
      total_affected: results.reduce((sum, r) => sum + r.count, 0),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/review/execute error:', err)
    return handleError(err)
  }
}
