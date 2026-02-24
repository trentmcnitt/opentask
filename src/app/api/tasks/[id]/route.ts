/**
 * Single Task API routes
 *
 * GET /api/tasks/:id - Get a single task
 * PATCH /api/tasks/:id - Update a task (partial)
 * DELETE /api/tasks/:id - Soft delete a task
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { getTaskById, updateTask, deleteTask, canUserAccessTask } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { validateTaskUpdate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseInt(id)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }

    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }

    // Check access
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    return success(formatTaskResponse(task))
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/tasks/:id error:', err)
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
    const taskId = parseInt(id)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }

    const body = await request.json()
    const input = validateTaskUpdate(body)

    const { task, fieldsChanged, description } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      input,
    })

    // Dismiss notifications when due_at or done changes (snooze/completion via PATCH)
    if (fieldsChanged.includes('due_at') || fieldsChanged.includes('done')) {
      dismissNotificationsForTasks(user.id, [taskId])
    }

    notifyDemoEngagement(user.name, 'update')
    return success({
      ...formatTaskResponse(task),
      fields_changed: fieldsChanged,
      description,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'PATCH /api/tasks/:id error:', err)
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
    const taskId = parseInt(id)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }

    const task = deleteTask({
      userId: user.id,
      taskId,
    })

    dismissNotificationsForTasks(user.id, [taskId])

    notifyDemoEngagement(user.name, 'delete')
    return success({
      ...formatTaskResponse(task),
      message: 'Task moved to trash',
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'DELETE /api/tasks/:id error:', err)
    return handleError(err)
  }
})
