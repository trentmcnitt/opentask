/**
 * Webhook detail API routes
 *
 * PATCH  /api/webhooks/:id — Update url/events/active
 * DELETE /api/webhooks/:id — Hard delete
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  notFound,
  badRequest,
  handleError,
  handleZodError,
} from '@/lib/api-response'
import { updateWebhook, deleteWebhook } from '@/core/webhooks'
import { validateWebhookUpdate } from '@/core/validation/webhook'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const webhookId = parseInt(id)
    if (isNaN(webhookId)) return badRequest('Invalid webhook ID')
    const body = await request.json()
    const input = validateWebhookUpdate(body)

    const updated = updateWebhook(webhookId, user.id, input)
    if (!updated) return notFound('Webhook not found')

    return success(updated)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'PATCH /api/webhooks/:id error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const webhookId = parseInt(id)
    if (isNaN(webhookId)) return badRequest('Invalid webhook ID')

    const deleted = deleteWebhook(webhookId, user.id)
    if (!deleted) return notFound('Webhook not found')

    return success({ deleted: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/webhooks/:id error:', err)
    return handleError(err)
  }
})
