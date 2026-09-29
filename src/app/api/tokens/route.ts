/**
 * API Token Management
 *
 * GET /api/tokens  — List current user's tokens (id, name, created_at, last 8 chars preview)
 * POST /api/tokens — Create a new token, return the full token value once
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError, createApiToken } from '@/core/auth'
import { success, unauthorized, forbidden, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const db = getDb()
    const tokens = db
      .prepare(
        `SELECT id, name, created_at, token_preview
         FROM api_tokens WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(user.id)
    return success({ tokens })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/tokens error:', err)
    return handleError(err)
  }
})

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    if (user.is_demo) {
      return forbidden('API tokens cannot be created in demo mode')
    }
    const body = await request.json()

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return badRequest('Token name is required')
    }
    if (name.length > 100) {
      return badRequest('Token name must be 100 characters or less')
    }

    const { id, raw } = createApiToken(user.id, name)

    // Return the raw token once — it cannot be retrieved after this
    return success({ id, name, token: raw }, 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/tokens error:', err)
    return handleError(err)
  }
})
