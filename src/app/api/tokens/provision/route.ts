/**
 * iOS Token Auto-Provisioning
 *
 * POST /api/tokens/provision — Auto-create a Bearer token for the iOS app
 *
 * Called by PreferencesProvider when running inside the iOS WKWebView.
 * Session cookie auth only — rejects Bearer token auth to prevent token-chaining.
 * Creates a token with source='ios' if none exists; returns existing status if valid.
 *
 * Body: { has_local_token: boolean }
 * - has_local_token=true + server has ios token → { status: 'active' }
 * - has_local_token=false or no ios token on server → creates new, returns { token: 'raw' }
 */

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { AuthError, extractBearerToken } from '@/core/auth'
import { auth } from '@/app/api/auth/[...nextauth]/auth'
import { toAuthUser } from '@/core/auth/helpers'
import { hashToken, tokenPreview } from '@/core/auth/token-hash'
import { success, unauthorized, forbidden, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { AuthUser } from '@/types'

const TOKEN_NAME = 'iOS App'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    // Reject Bearer token auth — provision only from session cookie.
    // This prevents an attacker with a stolen token from minting new tokens.
    const authHeader = request.headers.get('Authorization')
    if (extractBearerToken(authHeader)) {
      return forbidden('Token provisioning requires session authentication')
    }

    // Authenticate via session cookie
    const session = await auth()
    if (!session?.user) {
      return unauthorized('Session required')
    }

    const user = session.user as unknown as AuthUser & { id?: string | number }
    if (!user.id) {
      return unauthorized('Invalid session')
    }

    const authUser = toAuthUser({
      id: typeof user.id === 'string' ? parseInt(user.id, 10) : user.id,
      email: user.email || '',
      name: user.name || '',
      timezone: user.timezone || 'America/Chicago',
      default_grouping: user.default_grouping || 'project',
      is_demo: user.is_demo ? 1 : 0,
    })

    if (authUser.is_demo) {
      return forbidden('Token provisioning not available in demo mode')
    }

    const body = await request.json()
    const hasLocalToken = body.has_local_token === true

    const db = getDb()

    // Check if an auto-provisioned iOS token already exists for this user
    const existing = db
      .prepare("SELECT id FROM api_tokens WHERE user_id = ? AND source = 'ios'")
      .get(authUser.id) as { id: number } | undefined

    if (existing && hasLocalToken) {
      // Token exists on server and native has one — assume they match
      log.info('tokens', `iOS token active for user ${authUser.id}`)
      return success({ status: 'active' })
    }

    // Either no token on server, or native lost its token — (re)provision
    if (existing) {
      // Delete stale server-side token (native doesn't have it)
      db.prepare('DELETE FROM api_tokens WHERE id = ?').run(existing.id)
      log.info('tokens', `Rotated stale iOS token for user ${authUser.id}`)
    }

    const raw = crypto.randomBytes(32).toString('hex')
    const hashed = hashToken(raw)
    const preview = tokenPreview(raw)

    db.prepare(
      'INSERT INTO api_tokens (user_id, token, token_preview, name, source) VALUES (?, ?, ?, ?, ?)',
    ).run(authUser.id, hashed, preview, TOKEN_NAME, 'ios')

    log.info('tokens', `Provisioned iOS token for user ${authUser.id}`)
    return success({ status: 'provisioned', token: raw }, 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/tokens/provision error:', err)
    return handleError(err)
  }
})
