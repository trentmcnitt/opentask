/**
 * SHELVED (2026-10-22): Quick Take (this route answers 410 FEATURE_SHELVED) is shelved behind `OPENTASK_AI_UNSHELVE`
 * (src/core/ai/shelved.ts) until it is redesigned. The code stays in place,
 * dormant — do not "fix" or re-enable it without Trent.
 */
import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  badRequest,
  handleError,
  serviceUnavailable,
  featureShelved,
} from '@/lib/api-response'
import { isAIEnabled, generateQuickTake } from '@/core/ai'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { shelvedAiFeaturesOn } from '@/core/ai/shelved'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    // SHELVED (2026-10-22): src/core/ai/shelved.ts. After auth (a bad token
    // is still a 401), before the AI-enabled check.
    if (!shelvedAiFeaturesOn()) return featureShelved()

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const body = await request.json()
    const title = body?.title
    if (typeof title !== 'string' || title.trim().length === 0) {
      return badRequest('title is required')
    }

    const hasDueDate = body?.has_due_date === true

    const text = await generateQuickTake(user.id, user.timezone, title.trim(), hasDueDate)
    return success({ text })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/ai/quick-take error:', err)
    return handleError(err)
  }
})
