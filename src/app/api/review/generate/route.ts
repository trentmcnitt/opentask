/**
 * POST /api/review/generate — Kick off AI review generation
 *
 * Starts batch processing of all active tasks in the background.
 * Returns immediately with a session_id for progress polling.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import {
  isAIEnabled,
  getUserAiContext,
  buildTaskSummaries,
  startReviewGeneration,
  getActiveReviewSession,
} from '@/core/ai'
import { success, unauthorized, badRequest, conflict, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return badRequest('AI features are not enabled')
    }

    // Check for already-running session
    const active = getActiveReviewSession(user.id)
    if (active) {
      return conflict('A review is already in progress', {
        session_id: active.id,
        completed: active.completed,
        total_tasks: active.total_tasks,
      })
    }

    const tasks = buildTaskSummaries(user.id)
    if (tasks.length === 0) {
      return success({ session_id: null, total_tasks: 0, message: 'No active tasks to review' })
    }

    const aiContext = getUserAiContext(user.id)
    const { sessionId, totalTasks, singleCall } = startReviewGeneration(
      user.id,
      user.timezone,
      tasks,
      aiContext,
      'on-demand',
    )

    return success({ session_id: sessionId, total_tasks: totalTasks, single_call: singleCall })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/review/generate error:', err)
    return handleError(err)
  }
}
