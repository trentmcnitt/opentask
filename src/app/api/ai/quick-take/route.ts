import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  badRequest,
  handleError,
  serviceUnavailable,
} from '@/lib/api-response'
import { isAIEnabled, generateQuickTake } from '@/core/ai'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)

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
