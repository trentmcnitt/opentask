/**
 * Webhook deliveries API route
 *
 * GET /api/webhooks/:id/deliveries — Recent deliveries for a webhook
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, notFound, handleError, parseRouteId } from '@/lib/api-response'
import { getWebhookDeliveries } from '@/core/webhooks'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const webhookId = parseRouteId(id)
    if (webhookId === null) return badRequest('Invalid webhook ID')

    const deliveries = getWebhookDeliveries(webhookId, user.id)
    if (!deliveries) return notFound('Webhook not found')

    return success({ deliveries })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/webhooks/:id/deliveries error:', err)
    return handleError(err)
  }
})
