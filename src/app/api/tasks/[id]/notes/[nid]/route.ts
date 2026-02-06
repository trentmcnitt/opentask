/**
 * Note Edit/Delete API routes
 *
 * PATCH /api/tasks/:id/notes/:nid - Update note content
 * DELETE /api/tasks/:id/notes/:nid - Delete a note
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { getTaskById, canUserAccessTask } from '@/core/tasks'
import { validateNoteCreate } from '@/core/validation'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import type { Note } from '@/types'
import type { NoteRouteContext } from '@/types/api'

export async function PATCH(request: NextRequest, context: NoteRouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id, nid } = await context.params
    const taskId = parseInt(id)
    const noteId = parseInt(nid)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }
    if (isNaN(noteId)) {
      return notFound('Note not found', { nid })
    }

    // Check task exists and user has access
    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    // Check note exists and belongs to this task
    const db = getDb()
    const note = db
      .prepare('SELECT id, task_id, content, created_at FROM notes WHERE id = ? AND task_id = ?')
      .get(noteId, taskId) as Note | undefined

    if (!note) {
      return notFound('Note not found', { note_id: noteId })
    }

    const { content } = validateNoteCreate(await request.json())

    db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content.trim(), noteId)

    const updated = db
      .prepare('SELECT id, task_id, content, created_at FROM notes WHERE id = ?')
      .get(noteId) as Note

    return success(updated)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'PATCH /api/tasks/:id/notes/:nid error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest, context: NoteRouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id, nid } = await context.params
    const taskId = parseInt(id)
    const noteId = parseInt(nid)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }
    if (isNaN(noteId)) {
      return notFound('Note not found', { nid })
    }

    // Check task exists and user has access
    const task = getTaskById(taskId)
    if (!task) {
      return notFound('Task not found', { task_id: taskId })
    }
    if (!canUserAccessTask(user.id, task)) {
      return notFound('Task not found', { task_id: taskId })
    }

    // Check note exists and belongs to this task
    const db = getDb()
    const note = db
      .prepare('SELECT id FROM notes WHERE id = ? AND task_id = ?')
      .get(noteId, taskId) as { id: number } | undefined

    if (!note) {
      return notFound('Note not found', { note_id: noteId })
    }

    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)

    return success({ deleted: true, note_id: noteId })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'DELETE /api/tasks/:id/notes/:nid error:', err)
    return handleError(err)
  }
}
