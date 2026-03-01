/**
 * Webhook deliveries API route
 *
 * GET /api/webhooks/:id/deliveries — Recent deliveries for a webhook
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, badRequest, handleError } from '@/lib/api-response'
import { getWebhookDeliveries } from '@/core/webhooks'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const webhookId = parseInt(id)
    if (isNaN(webhookId)) return badRequest('Invalid webhook ID')

    const deliveries = getWebhookDeliveries(webhookId, user.id)
    if (!deliveries) return notFound('Webhook not found')

    return success({ deliveries })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/webhooks/:id/deliveries error:', err)
    return handleError(err)
  }
})
