/**
 * Notes API routes
 *
 * GET /api/tasks/:id/notes - List notes for a task
 * POST /api/tasks/:id/notes - Add a note to a task
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { getTaskById, canUserAccessTask } from '@/core/tasks'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { validateNoteCreate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import type { Note } from '@/types'
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

    // Check task exists and user has access
    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    const db = getDb()
    const notes = db
      .prepare(
        `
      SELECT id, task_id, content, created_at
      FROM notes
      WHERE task_id = ?
      ORDER BY created_at DESC
    `,
      )
      .all(taskId) as Note[]

    return success({
      notes,
      count: notes.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/tasks/:id/notes error:', err)
    return handleError(err)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
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

    // Check task exists and user has access
    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    const { content } = validateNoteCreate(await request.json())

    const db = getDb()
    const now = nowUtc()

    const result = db
      .prepare(
        `
      INSERT INTO notes (task_id, content, created_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(taskId, content.trim(), now)

    const noteId = Number(result.lastInsertRowid)

    const note = db
      .prepare('SELECT id, task_id, content, created_at FROM notes WHERE id = ?')
      .get(noteId) as Note

    return success(note, 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/tasks/:id/notes error:', err)
    return handleError(err)
  }
}
