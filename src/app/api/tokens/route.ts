/**
 * API Token Management
 *
 * GET /api/tokens  — List current user's tokens (id, name, created_at, last 8 chars preview)
 * POST /api/tokens — Create a new token, return the full token value once
 */

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const db = getDb()
    const tokens = db
      .prepare(
        `SELECT id, name, created_at, substr(token, -8) AS token_preview
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
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return badRequest('Token name is required')
    }
    if (name.length > 100) {
      return badRequest('Token name must be 100 characters or less')
    }

    const db = getDb()
    const token = crypto.randomBytes(32).toString('hex')
    const result = db
      .prepare('INSERT INTO api_tokens (user_id, token, name) VALUES (?, ?, ?)')
      .run(user.id, token, name)

    return success({ id: Number(result.lastInsertRowid), name, token }, 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/tokens error:', err)
    return handleError(err)
  }
}
