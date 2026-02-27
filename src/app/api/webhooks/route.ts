/**
 * Webhooks API routes
 *
 * GET  /api/webhooks — List webhooks (secrets excluded)
 * POST /api/webhooks — Create webhook (secret shown once)
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { getWebhooks, createWebhook } from '@/core/webhooks'
import { validateWebhookCreate } from '@/core/validation/webhook'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const webhooks = getWebhooks(user.id)
    return success({ webhooks })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/webhooks error:', err)
    return handleError(err)
  }
})

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const input = validateWebhookCreate(body)
    const webhook = createWebhook(user.id, input.url, input.events)
    return success(webhook, 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/webhooks error:', err)
    return handleError(err)
  }
})
