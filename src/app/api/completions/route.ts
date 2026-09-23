/**
 * Completions API route
 *
 * GET /api/completions - Query completion history
 *   ?date=YYYY-MM-DD - Filter by completion date (UTC calendar date)
 *   ?since=<ISO>&until=<ISO> - Filter by a completed_at range, [since, until).
 *     Additive alongside `date`: the dashboard's completion fill (§ITEM 2, the
 *     per-project/Today progress chips) needs a TIMEZONE-correct "today"
 *     boundary, which a UTC calendar date can misclassify near local midnight
 *     — the caller computes the boundary with `getTimezoneDayBoundaries()` and
 *     passes it here as an instant range instead. Both sides are wrapped in
 *     SQL `datetime()` so the comparison is safe whether `completed_at` was
 *     stored with or without a milliseconds component.
 *   ?task_id=N - Filter by task ID
 *
 * Each row also carries `project_id`, `is_reminder`, `is_tracked`, and
 * `progress_target` — read off the joined task, not the completion itself.
 * These are additive fields for the same completion fill: it must exclude
 * reminder "considerations" and quota +1 logs (both write ordinary
 * `completions` rows via the same `markDone` path) from a task's completion
 * count, and the caller needs enough here to make that call without a second
 * request. Existing consumers (the History page) ignore the extra fields.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

interface CompletionRow {
  id: number
  task_id: number
  user_id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
  task_title: string
  project_id: number
  is_reminder: number
  is_tracked: number
  progress_target: number
}

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const since = searchParams.get('since')
    const until = searchParams.get('until')
    const taskIdParam = searchParams.get('task_id')

    const conditions: string[] = ['c.user_id = ?']
    const params: unknown[] = [user.id]

    if (date) {
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return badRequest('Invalid date format. Use YYYY-MM-DD')
      }
      conditions.push('date(c.completed_at) = ?')
      params.push(date)
    }

    if (since || until) {
      if (!since || !until) {
        return badRequest('since and until must be provided together')
      }
      const sinceDate = new Date(since)
      const untilDate = new Date(until)
      if (isNaN(sinceDate.getTime()) || isNaN(untilDate.getTime())) {
        return badRequest('Invalid since/until. Use ISO 8601 date-time strings')
      }
      // datetime() normalizes both sides regardless of whether completed_at
      // (or the caller's ISO string) carries a milliseconds component.
      conditions.push(
        'datetime(c.completed_at) >= datetime(?) AND datetime(c.completed_at) < datetime(?)',
      )
      params.push(sinceDate.toISOString(), untilDate.toISOString())
    }

    if (taskIdParam) {
      const taskId = parseInt(taskIdParam)
      if (isNaN(taskId)) {
        return badRequest('Invalid task_id parameter')
      }
      conditions.push('c.task_id = ?')
      params.push(taskId)
    }

    const db = getDb()
    const completions = db
      .prepare(
        `
        SELECT c.id, c.task_id, c.user_id, c.completed_at, c.due_at_was, c.due_at_next,
               t.title AS task_title, t.project_id, t.is_reminder, t.is_tracked, t.progress_target
        FROM completions c
        INNER JOIN tasks t ON c.task_id = t.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.completed_at DESC
        LIMIT 1000
      `,
      )
      .all(...params) as CompletionRow[]

    return success({
      completions: completions.map((c) => ({
        id: c.id,
        task_id: c.task_id,
        user_id: c.user_id,
        completed_at: c.completed_at,
        due_at_was: c.due_at_was,
        due_at_next: c.due_at_next,
        task_title: c.task_title,
        project_id: c.project_id,
        is_reminder: !!c.is_reminder,
        is_tracked: !!c.is_tracked,
        progress_target: c.progress_target,
      })),
      count: completions.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/completions error:', err)
    return handleError(err)
  }
})
