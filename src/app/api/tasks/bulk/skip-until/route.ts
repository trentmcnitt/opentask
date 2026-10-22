/**
 * Skip until (task queue PR 4; spec rule 10)
 *
 * POST /api/tasks/bulk/skip-until — Body: { ids: [taskId, ...], until? }.
 * `until` (yyyy-MM-dd, the user's local day) skips every occurrence before
 * it: each repeating task lands on its first occurrence on or after that day
 * (a from_completion rule on the day itself, at the rule's time). Omitted, it
 * skips this occurrence, as `/api/tasks/:id/skip-occurrence` does.
 *
 * Only repeating tasks move. One-offs, reminders, quotas and done or trashed
 * tasks are left alone and counted, so a mixed list (an AI's) is never
 * refused; an unknown id is a 400, as on every bulk route. One undo entry.
 * See `skipUntil` (`src/core/tasks/skip-until.ts`).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { skipUntil } from '@/core/tasks/skip-until'
import { validateBulkSkipUntil } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids, until } = validateBulkSkipUntil(await request.json())
    const result = skipUntil({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds: ids,
      until: until ?? null,
    })
    return success({
      tasks_affected: result.tasksAffected,
      occurrences_skipped: result.occurrencesSkipped,
      targets_moved: result.targetsMoved,
      skipped_not_repeating: result.skippedNotRepeating,
      skipped_reminders: result.skippedReminders,
      skipped_quotas: result.skippedQuotas,
      skipped_inactive: result.skippedInactive,
      already_clear: result.alreadyClear,
      // Repeat ends (2026-10-22): tasks whose series the skip ended.
      series_ended: result.seriesEnded,
      task_ids: result.tasks.map((t) => t.id),
      summary: result.summary,
    })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/bulk/skip-until error:', err)
    return handleError(err)
  }
})
