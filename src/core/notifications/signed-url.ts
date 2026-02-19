/**
 * HMAC-signed URLs for notification action links
 *
 * These URLs are embedded in Pushover notification messages as clickable links.
 * They allow unauthenticated quick actions (done, snooze) with time-limited validity.
 *
 * Security model:
 * - Signed with HMAC-SHA256 using NEXTAUTH_SECRET as the key
 * - Each URL encodes: taskId, userId, action, expiry timestamp
 * - Expires after a configurable duration (default 2 hours)
 * - Verification checks signature + expiry + parameter integrity
 */

import { createHmac } from 'crypto'

const HMAC_KEY = process.env.NEXTAUTH_SECRET || ''
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

export type SignedAction = 'done' | 'snooze30' | 'snooze' | 'snooze2h'

function computeSignature(taskId: number, userId: number, action: string, exp: number): string {
  const message = `${taskId}:${userId}:${action}:${exp}`
  return createHmac('sha256', HMAC_KEY).update(message).digest('hex')
}

export function generateSignedActionUrl(
  taskId: number,
  userId: number,
  action: SignedAction,
  expiresInSeconds = 7200,
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds
  const sig = computeSignature(taskId, userId, action, exp)
  const params = new URLSearchParams({
    task: String(taskId),
    user: String(userId),
    action,
    exp: String(exp),
    sig,
  })
  return `${APP_URL}/api/notifications/quick-action?${params.toString()}`
}

export function verifySignedActionUrl(
  taskId: number,
  userId: number,
  action: string,
  exp: number,
  sig: string,
): boolean {
  if (!HMAC_KEY) return false
  // Check expiry
  const now = Math.floor(Date.now() / 1000)
  if (now > exp) return false
  // Check signature
  const expected = computeSignature(taskId, userId, action, exp)
  // Constant-time comparison
  if (expected.length !== sig.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  }
  return mismatch === 0
}
