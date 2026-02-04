/**
 * Completions API route
 *
 * GET /api/completions - Query completion history
 *   ?date=YYYY-MM-DD - Filter by completion date
 *   ?task_id=N - Filter by task ID
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

interface CompletionRow {
  id: number
  task_id: number
  user_id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
  task_title: string
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
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
               t.title AS task_title
        FROM completions c
        INNER JOIN tasks t ON c.task_id = t.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.completed_at DESC
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
}
