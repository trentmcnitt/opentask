import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import { isAIEnabled, getEnrichmentSlotStats, getAIActivity, getQueueStats } from '@/core/ai'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const enrichmentSlot = getEnrichmentSlotStats()
    const queue = getQueueStats()
    const recentActivity = getAIActivity(user.id, { limit: 20 })

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
}
