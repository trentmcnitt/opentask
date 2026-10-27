/**
 * Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
 *
 * POST /api/task-segments/target-today — "Target today": a DELIBERATE target
 * (the age clock starts at it) at the time the Snooze-all button would go to —
 * the next period, or the default snooze option — while that is still today,
 * else the top of the next hour (`targetTodayTime`). Also marks the task
 * considered, so the row finishes on the tap, and stamps `segment_targeted_at`
 * (the dashboard's Just now card). Body: { ids: [taskId, ...], at? } — `at`
 * (2026-10-12) is the moment the Today button's long-press picker chose, today
 * or later; omitted, the time above. One undo entry (bulk edit). Response:
 * { until, affected, skipped_recurring }. Repeating tasks are SKIPPED and listed
 * in `skipped_recurring` (2026-10-12): re-targeting one resets its occurrence
 * (the double fire and the deadline drift) — done early is the safe gesture.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { validateSegmentTarget } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids, at } = validateSegmentTarget(await request.json())
    const result = targetTasksToday(user.id, user.timezone, ids, at)
    return success({ ...result, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError))
      log.error('api', 'POST /api/task-segments/target-today error:', err)
    return handleError(err)
  }
})
