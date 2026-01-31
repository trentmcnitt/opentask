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
import { getTaskById, updateTask, deleteTask, canUserAccessTask } from '@/core/tasks'
import { validateTaskUpdate } from '@/core/validation'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

export async function GET(request: NextRequest, context: RouteContext) {
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

    return success({
      ...task,
      is_recurring: task.rrule !== null,
      is_snoozed: task.snoozed_from !== null,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('GET /api/tasks/:id error:', err)
    return handleError(err)
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
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

    const { task, fieldsChanged } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      input,
    })

    return success({
      ...task,
      is_recurring: task.rrule !== null,
      is_snoozed: task.snoozed_from !== null,
      fields_changed: fieldsChanged,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    console.error('PATCH /api/tasks/:id error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
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

    return success({
      ...task,
      message: 'Task moved to trash',
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('DELETE /api/tasks/:id error:', err)
    return handleError(err)
  }
}
