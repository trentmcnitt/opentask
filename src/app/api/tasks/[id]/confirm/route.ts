/**
 * Task provenance confirmation (REDESIGN-V03 §7.2)
 *
 * POST /api/tasks/:id/confirm - Bless a task the assistant created on its own
 * initiative: removes `ai-proposed`, adds `ai-added`.
 *
 * Deliberately task-scoped and narrow. Confirming is a statement about where a
 * task came from, not an invitation to re-edit it, so this touches no other
 * field. It routes through updateTask() rather than writing labels directly, so
 * the change is transactional and lands in the undo log like any other edit.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { getTaskById, updateTask, canUserAccessTask } from '@/core/tasks'
import { confirmProvenance, PROVENANCE_LABELS } from '@/core/labels'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const taskId = parseInt(id)

    const task = getTaskById(taskId)
    if (!task || !canUserAccessTask(user.id, task)) return notFound('Task not found')

    // Idempotent: confirming an already-confirmed task is a no-op rather than
    // an error, so a retried call can't fail spuriously.
    if (!task.labels.includes(PROVENANCE_LABELS.proposed)) {
      return success({
        ...formatTaskResponse(task),
        confirmed: task.labels.includes(PROVENANCE_LABELS.added),
      })
    }

    const { task: updated } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      // `ai-added` is registered by the backfill and by the provenance flags, so
      // create_label is not needed here.
      input: { labels: confirmProvenance(task.labels) },
    })

    return success({ ...formatTaskResponse(updated), confirmed: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/tasks/:id/confirm error:', err)
    return handleError(err)
  }
})
