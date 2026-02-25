import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import {
  isAIEnabled,
  getEnrichmentSlotStats,
  getAIActivity,
  getQueueStats,
  getActiveInsightsSession,
  getEnrichmentPipelineStatus,
} from '@/core/ai'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const url = new URL(request.url)
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0
    const action = url.searchParams.get('action') || undefined

    const enrichmentSlot = getEnrichmentSlotStats()
    const queue = getQueueStats()
    const recentActivity = getAIActivity(user.id, { limit, offset, action })
    const enrichmentPipeline = getEnrichmentPipelineStatus()
    const activeInsightsSession = getActiveInsightsSession(user.id)

    // Count tasks pending enrichment
    const db = getDb()
    const pendingRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')
           AND deleted_at IS NULL`,
      )
      .get() as { count: number }

    return success({
      enrichment_slot: enrichmentSlot,
      queue,
      in_progress: {
        enrichment: {
          slot: enrichmentSlot.currentOperation,
          pipeline_task_ids: enrichmentPipeline.processingTaskIds,
          circuit_breaker_open: enrichmentPipeline.circuitBreakerOpen,
          pending_count: pendingRow.count,
        },
        insights: activeInsightsSession
          ? {
              session_id: activeInsightsSession.id,
              status: activeInsightsSession.status,
              total_tasks: activeInsightsSession.total_tasks,
              completed: activeInsightsSession.completed,
              started_at: activeInsightsSession.started_at,
            }
          : null,
      },
      recent_activity: recentActivity,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/status error:', err)
    return handleError(err)
  }
})
