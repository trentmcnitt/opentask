/**
 * Tasks API routes
 *
 * GET /api/tasks - List tasks with filters
 * POST /api/tasks - Create a task
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse, formatTasksResponse } from '@/lib/format-task'
import { getTasks, createTask } from '@/core/tasks'
import { validateTaskCreate } from '@/core/validation'
import { isAIEnabled, enrichSingleTask } from '@/core/ai'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url)

    // Parse and validate numeric parameters
    let projectId: number | undefined
    if (searchParams.has('project')) {
      projectId = parseInt(searchParams.get('project')!)
      if (isNaN(projectId)) {
        return handleError(new Error('Invalid project ID'))
      }
    }

    let limit = 200
    if (searchParams.has('limit')) {
      limit = parseInt(searchParams.get('limit')!)
      if (isNaN(limit) || limit < 1) {
        return handleError(new Error('Invalid limit parameter'))
      }
    }

    let offset = 0
    if (searchParams.has('offset')) {
      offset = parseInt(searchParams.get('offset')!)
      if (isNaN(offset) || offset < 0) {
        return handleError(new Error('Invalid offset parameter'))
      }
    }

    const tasks = getTasks({
      userId: user.id,
      projectId,
      done: searchParams.has('done') ? searchParams.get('done') === 'true' : undefined,
      overdue: searchParams.has('overdue') ? searchParams.get('overdue') === 'true' : undefined,
      recurring: searchParams.has('recurring')
        ? searchParams.get('recurring') === 'true'
        : undefined,
      oneOff: searchParams.has('one_off') ? searchParams.get('one_off') === 'true' : undefined,
      search: searchParams.get('search') || undefined,
      label: searchParams.get('label') || undefined,
      trashed: searchParams.has('trashed') ? searchParams.get('trashed') === 'true' : undefined,
      archived: searchParams.has('archived') ? searchParams.get('archived') === 'true' : undefined,
      limit,
      offset,
    })

    const formattedTasks = formatTasksResponse(tasks)

    return success({
      tasks: formattedTasks,
      count: formattedTasks.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/tasks error:', err)
    return handleError(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateTaskCreate(body)

    const task = createTask({
      userId: user.id,
      userTimezone: user.timezone,
      input,
    })

    // Fire-and-forget: trigger immediate enrichment if AI is enabled and task is pending
    if (isAIEnabled() && task.ai_status === 'pending') {
      enrichSingleTask(task.id, user.id).catch((err) => {
        log.error('api', `Fire-and-forget enrichment failed for task ${task.id}:`, err)
      })
    }

    return success(formatTaskResponse(task), 201)
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks error:', err)
    return handleError(err)
  }
}
