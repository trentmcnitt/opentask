import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, internalError } from '@/lib/api-response'
import { isAIEnabled, getBriefing } from '@/core/ai'
import { getTasks } from '@/core/tasks'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import type { TaskSummary } from '@/core/ai'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return internalError('AI features are not enabled')
    }

    const url = new URL(request.url)
    const refresh = url.searchParams.get('refresh') === 'true'

    // Fetch active tasks
    const tasks = getTasks({ userId: user.id, done: false })
    const db = getDb()

    // Build task summaries with project names
    const taskSummaries: TaskSummary[] = tasks.map((t) => {
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(t.project_id) as
        | { name: string }
        | undefined
      return {
        id: t.id,
        title: t.title,
        priority: t.priority,
        due_at: t.due_at,
        labels: t.labels,
        project_name: project?.name ?? null,
        is_recurring: t.rrule !== null,
        snooze_count: t.snooze_count,
      }
    })

    const result = await getBriefing(user.id, user.timezone, taskSummaries, refresh)

    if (!result) {
      return internalError('Failed to generate briefing')
    }

    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/briefing error:', err)
    return handleError(err)
  }
}
