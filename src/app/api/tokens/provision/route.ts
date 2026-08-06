/**
 * iOS Token Auto-Provisioning
 *
 * POST /api/tokens/provision — Auto-create a Bearer token for the iOS app
 *
 * Called by PreferencesProvider when running inside the iOS WKWebView.
 * Session cookie auth only — rejects Bearer token auth to prevent token-chaining.
 * Creates a token with source='ios' if none exists; returns existing status if valid.
 *
 * Body: { has_local_token: boolean, local_token_preview?: string }
 * - has_local_token=true + server has a matching ios token → { status: 'active' }
 * - has_local_token=false or no ios token on server → creates new, returns { token: 'raw' }
 * - has_local_token=true but the preview matches none of this user's ios tokens → the
 *   keychain holds a *different user's* token, so a new one is minted (see below)
 *
 * `local_token_preview` is the last 8 characters of the token native holds (same semantics
 * as api_tokens.token_preview). It exists because `has_local_token` alone cannot tell
 * "native has my token" from "native has someone else's token": if the webview user
 * switched accounts, the old code short-circuited with { status: 'active' } and native kept
 * the previous account's token — which is how widgets ended up showing another user's
 * tasks. Older app builds don't send the field; when it is absent the legacy
 * assume-they-match behavior is preserved.
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

/**
 * Decide what to do about the user's existing auto-provisioned iOS tokens.
 *
 * Returns 'active' when native already holds one of this user's tokens (nothing to do),
 * 'provision' when a new token must be minted. Deletes the stale server-side token when
 * native reports it has none, since nothing can be using it anymore.
 */
function reconcileExistingTokens(
  userId: number,
  hasLocalToken: boolean,
  localPreview: string | null,
): 'active' | 'provision' {
  const db = getDb()
  const existing = db
    .prepare("SELECT id, token_preview FROM api_tokens WHERE user_id = ? AND source = 'ios'")
    .all(userId) as Array<{ id: number; token_preview: string | null }>

  if (existing.length === 0) {
    return 'provision'
  }

  if (hasLocalToken) {
    // No preview sent (older app build) → legacy behavior: assume the tokens match
    const belongsToThisUser =
      localPreview === null || existing.some((row) => row.token_preview === localPreview)
    if (belongsToThisUser) {
      log.info('tokens', `iOS token active for user ${userId}`)
      return 'active'
    }

    // The keychain token isn't one of this user's — it belongs to whoever was signed in
    // before. Mint a replacement so native overwrites the keychain. This user's existing
    // iOS tokens are left alone: other devices may still be using them.
    log.warn('tokens', `iOS token preview mismatch for user ${userId} — provisioning a replacement`)
    return 'provision'
  }

  // Native lost its token — delete the stale server-side token before re-provisioning
  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(existing[0].id)
  log.info('tokens', `Rotated stale iOS token for user ${userId}`)
  return 'provision'
}

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
    const localPreview =
      typeof body.local_token_preview === 'string' && body.local_token_preview.length > 0
        ? body.local_token_preview
        : null

    if (reconcileExistingTokens(authUser.id, hasLocalToken, localPreview) === 'active') {
      return success({ status: 'active' })
    }

    const db = getDb()
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
