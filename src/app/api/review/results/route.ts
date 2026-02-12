/**
 * GET /api/review/results — Get cached AI review results
 *
 * Returns all review results for the authenticated user, sorted by score desc.
 * Includes signal_counts for filter chip rendering.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { getReviewResults, REVIEW_SIGNALS } from '@/core/ai'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    const { results, generatedAt, signalCounts } = getReviewResults(user.id)

    return success({
      results,
      generated_at: generatedAt,
      signal_counts: signalCounts,
      signals: REVIEW_SIGNALS.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.color,
        icon: s.icon,
        description: s.description,
      })),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/review/results error:', err)
    return handleError(err)
  }
}
