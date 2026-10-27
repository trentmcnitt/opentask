/**
 * Tasks API routes
 *
 * GET /api/tasks - List tasks with filters (`kind=task|reminder|quota`, `overdue=true` = the badge set, ...)
 * POST /api/tasks - Create a task
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse, formatTasksResponse } from '@/lib/format-task'
import { getTasks, getTaskById, createTask, type TaskKind } from '@/core/tasks'
import { validateTaskCreate } from '@/core/validation'
import { isAIEnabled, enrichSingleTask, describeEnrichment } from '@/core/ai'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'
import { requestUndoId } from '@/core/request-context'

/** `?name=true` → true, any other value → false, absent → undefined. */
function boolParam(params: URLSearchParams, name: string): boolean | undefined {
  return params.has(name) ? params.get(name) === 'true' : undefined
}

/**
 * `kind` narrows the list to one population (§5/§6). Absent = all three, as
 * before, so existing callers — the dashboard fetches everything and splits it
 * client-side — are unchanged.
 */
function parseKind(raw: string | null): TaskKind | undefined | 'invalid' {
  if (raw === null) return undefined
  return raw === 'task' || raw === 'reminder' || raw === 'quota' ? raw : 'invalid'
}

/**
 * WAIT (2026-10-24, quota enrichment): how long `POST /api/tasks` with
 * `wait: true` holds the response for the enrichment it started. A product
 * cap, not a tolerance — a Siri Shortcut gives up on a request that takes much
 * longer, and an enrichment that runs past it still finishes (the per-minute
 * queue is the safety net); the answer then says `pending`.
 */
const WAIT_CAP_MS = 20_000

/**
 * What `wait` reports: `done` (with the toast's description of what the AI
 * set — `describeEnrichment`), `pending` (still running or to be retried: the
 * row keeps `ai-to-process`), `failed` (`ai-failed`), or `skipped` (no
 * enrichment ran for this create: AI off, the user's mode off, or not
 * title-only).
 */
async function waitForEnrichment(
  taskId: number,
  userId: number,
  enrichment: Promise<string[] | null> | null,
): Promise<{ status: 'done' | 'pending' | 'failed' | 'skipped'; description: string | null }> {
  let fields: string[] | null = null
  if (enrichment) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), WAIT_CAP_MS)
    })
    fields = await Promise.race([enrichment, capped])
    clearTimeout(timer)
  }

  const labels = getTaskById(taskId)?.labels ?? []
  if (labels.includes('ai-failed')) return { status: 'failed', description: null }
  if (labels.includes('ai-to-process')) return { status: 'pending', description: null }
  if (fields === null) return { status: 'skipped', description: null }
  return {
    status: 'done',
    description: describeEnrichment(taskId, userId, fields)?.description ?? null,
  }
}

export const GET = withLogging(async function GET(request: NextRequest) {
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
        return badRequest('Invalid project ID')
      }
    }

    let limit = 200
    if (searchParams.has('limit')) {
      limit = parseInt(searchParams.get('limit')!)
      if (isNaN(limit) || limit < 1) {
        return badRequest('Invalid limit parameter')
      }
      limit = Math.min(limit, 1000)
    }

    let offset = 0
    if (searchParams.has('offset')) {
      offset = parseInt(searchParams.get('offset')!)
      if (isNaN(offset) || offset < 0) {
        return badRequest('Invalid offset parameter')
      }
    }

    const kind = parseKind(searchParams.get('kind'))
    if (kind === 'invalid') {
      return badRequest('Invalid kind parameter (expected task, reminder or quota)')
    }

    const tasks = getTasks({
      userId: user.id,
      projectId,
      kind,
      done: boolParam(searchParams, 'done'),
      overdue: boolParam(searchParams, 'overdue'),
      recurring: boolParam(searchParams, 'recurring'),
      oneOff: boolParam(searchParams, 'one_off'),
      search: searchParams.get('search') || undefined,
      label: searchParams.get('label') || undefined,
      trashed: boolParam(searchParams, 'trashed'),
      archived: boolParam(searchParams, 'archived'),
      limit,
      offset,
    })

    const formattedTasks = formatTasksResponse(tasks, user.timezone)

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
})

export const POST = withLogging(async function POST(request: NextRequest) {
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

    // Fire-and-forget: trigger immediate enrichment if task has the ai-to-process label
    let enrichment: Promise<string[] | null> | null = null
    if (isAIEnabled() && task.labels.includes('ai-to-process')) {
      enrichment = enrichSingleTask(task.id, user.id).catch((err) => {
        log.error('api', `Fire-and-forget enrichment failed for task ${task.id}:`, err)
        return null
      })
    }

    notifyDemoEngagement(user.name, 'create')
    // The create's own entry: captured now, before enrichment (which runs
    // as the system and records nothing here anyway) can log one of its own.
    const undoId = requestUndoId()
    if (input.wait !== true) {
      return success({ ...formatTaskResponse(task, user.timezone), undo_id: undoId }, 201)
    }

    const ai = await waitForEnrichment(task.id, user.id, enrichment)
    const current = getTaskById(task.id) ?? task
    return success({ ...formatTaskResponse(current, user.timezone), ai, undo_id: undoId }, 201)
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
})
