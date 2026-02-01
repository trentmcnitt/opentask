/**
 * Trash API routes
 *
 * GET /api/trash - List trashed tasks
 * DELETE /api/trash - Empty trash (permanently delete all trashed tasks)
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { formatTasksResponse } from '@/lib/format-task'
import { getTasks, emptyTrash } from '@/core/tasks'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    // Pass done explicitly to override the default "undone only" filter
    const { searchParams } = new URL(request.url)
    const limitParam = searchParams.get('limit')
    const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 200)) : 200

    const tasks = getTasks({
      userId: user.id,
      trashed: true,
      limit,
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
    console.error('GET /api/trash error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const deletedCount = emptyTrash(user.id)

    return success({
      deleted_count: deletedCount,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('DELETE /api/trash error:', err)
    return handleError(err)
  }
}
