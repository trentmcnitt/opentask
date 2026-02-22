import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import { isAIEnabled, getEnrichmentSlotStats, getAIActivity, getQueueStats } from '@/core/ai'
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

    return success({
      enrichment_slot: enrichmentSlot,
      queue,
      recent_activity: recentActivity,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/status error:', err)
    return handleError(err)
  }
})
