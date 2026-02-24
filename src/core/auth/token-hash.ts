/**
 * Token hashing utilities
 *
 * API tokens are stored as SHA-256 hashes in the database.
 * The raw token is shown once at creation time and never stored.
 */

import { createHash } from 'crypto'

/**
 * Hash a raw API token using SHA-256.
 * Used both at creation (to store the hash) and at validation (to look up by hash).
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Extract a short preview from the raw token (last 8 chars).
 * Stored alongside the hash so users can identify tokens in the UI.
 */
export function tokenPreview(raw: string): string {
  return raw.slice(-8)
}
