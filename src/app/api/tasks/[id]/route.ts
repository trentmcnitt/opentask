/**
 * Single Task API routes
 *
 * GET /api/tasks/:id - Get a single task
 * PATCH /api/tasks/:id - Update a task (partial)
 * DELETE /api/tasks/:id - Soft delete a task
 */

import { sendDeadlineCapFeedback } from '@/core/notifications/deadline-cap-feedback'
import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError } from '@/core/errors'
import {
  success,
  unauthorized,
  badRequest,
  notFound,
  handleError,
  handleZodError,
  parseRouteId,
} from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { getTaskById, updateTask, deleteTask, canUserAccessTask } from '@/core/tasks'
import { validateTaskUpdate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'
import { requestUndoId } from '@/core/request-context'

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }

    // Check access
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    return success(formatTaskResponse(task, user.timezone))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/tasks/:id error:', err)
    return handleError(err)
  }
})

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const body = await request.json()
    const input = validateTaskUpdate(body)

    const { task, fieldsChanged, description, cappedAtDeadline } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      input,
    })

    // A3 (2026-10-11): a native quick snooze that stopped AT the deadline
    // says so in a quiet push — that surface (the notification content
    // extension's custom time) shows nothing itself. Every move is capped
    // since 2026-10-12 (§8.2); `cap_at_deadline` now only marks the caller as
    // one of those surfaces, so the web, whose toast says it, gets no push.
    if (cappedAtDeadline && input.cap_at_deadline) {
      void sendDeadlineCapFeedback(user.id, task.due_at!, user.timezone)
    }

    notifyDemoEngagement(user.name, 'update')
    return success({
      ...formatTaskResponse(task, user.timezone),
      fields_changed: fieldsChanged,
      description,
      capped_at_deadline: cappedAtDeadline === true,
      undo_id: requestUndoId(),
    })
  } catch (err) {
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    if (!(err instanceof AppError)) log.error('api', 'PATCH /api/tasks/:id error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const task = deleteTask({
      userId: user.id,
      taskId,
    })

    notifyDemoEngagement(user.name, 'delete')
    return success({
      ...formatTaskResponse(task, user.timezone),
      message: 'Task moved to trash',
    })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'DELETE /api/tasks/:id error:', err)
    return handleError(err)
  }
})
