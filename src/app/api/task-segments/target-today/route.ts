/**
 * Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
 *
 * POST /api/task-segments/target-today — "Target today": a DELIBERATE target
 * (the age clock starts at it) at the time the Snooze-all button would go to —
 * the next period, or the default snooze option — while that is still today,
 * else the top of the next hour (`targetTodayTime`). Also marks the task
 * considered, so the row finishes on the tap. Body: { ids: [taskId, ...] }.
 * One undo entry (bulk edit). Response: { until, affected }.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { validateSegmentIds } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids } = validateSegmentIds(await request.json())
    const { until, affected } = targetTasksToday(user.id, user.timezone, ids)
    return success({ until, affected })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError))
      log.error('api', 'POST /api/task-segments/target-today error:', err)
    return handleError(err)
  }
})
