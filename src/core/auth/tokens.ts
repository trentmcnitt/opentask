/**
 * API token creation
 *
 * The one place a token is minted: `POST /api/tokens` (Settings), the iOS
 * auto-provisioning route (`source = 'ios'`) and `scripts/create-token.ts`.
 * The raw token is 32 random bytes as hex; only its SHA-256 hash and its last
 * 8 characters (the preview the UI shows) are stored — see `token-hash.ts`.
 * The caller hands `raw` back to the user once; it can't be recovered later.
 *
 * Kept out of `./index.ts` on purpose: that module imports the NextAuth
 * config, which a plain `tsx` script can't load.
 */

import crypto from 'crypto'
import { getDb } from '@/core/db'
import { hashToken, tokenPreview } from './token-hash'

/** `api_tokens.source`: 'manual' (the column default) for user-made tokens, 'ios' for provisioned ones. */
export type ApiTokenSource = 'manual' | 'ios'

export interface CreatedApiToken {
  id: number
  /** The full token — shown once, never stored. */
  raw: string
  /** Last 8 characters, as stored in `api_tokens.token_preview`. */
  preview: string
}

export function createApiToken(
  userId: number,
  name: string,
  source: ApiTokenSource = 'manual',
): CreatedApiToken {
  const raw = crypto.randomBytes(32).toString('hex')
  const preview = tokenPreview(raw)
  const result = getDb()
    .prepare(
      'INSERT INTO api_tokens (user_id, token, token_preview, name, source) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, hashToken(raw), preview, name, source)
  return { id: Number(result.lastInsertRowid), raw, preview }
}
