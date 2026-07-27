/**
 * Batch complete API (REDESIGN-V03 §6.1)
 *
 * POST /api/tasks/bulk/complete - Complete N tasks in ONE request
 *
 * Built for the notification batch-checklist: the content extension stages
 * check-marks in SwiftUI and commits them with a single action button. No such
 * endpoint existed — the extension would otherwise have to fire N requests from
 * a context that can be suspended mid-flight, which is exactly how you get a
 * half-applied checklist and a user who stops trusting the notification.
 *
 * Delegates to bulkDone(), so this is one transaction and ONE undo entry: an
 * accidental commit is a single undo away, not N.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkDone } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { validateBulkDone } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const input = validateBulkDone(await request.json())

    const result = bulkDone({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds: input.ids,
    })

    // The items are handled, so their banners should go too.
    dismissNotificationsForTasks(user.id, input.ids)

    return success({
      tasks_affected: result.tasksAffected,
      recurring_count: result.recurringCount,
      one_off_count: result.oneOffCount,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/tasks/bulk/complete error:', err)
    return handleError(err)
  }
})
