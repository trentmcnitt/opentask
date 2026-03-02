/**
 * In-memory login rate limiter
 *
 * Tracks failed login attempts per username. After 5 failures within 15 minutes,
 * further attempts are blocked with exponential backoff.
 */

const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

interface AttemptRecord {
  count: number
  firstAttempt: number
  lastAttempt: number
}

const attempts = new Map<string, AttemptRecord>()

/**
 * Check if a username is currently rate-limited.
 * Returns null if allowed, or the number of seconds until the lockout expires.
 */
export function checkRateLimit(username: string): number | null {
  const key = username.toLowerCase()
  const record = attempts.get(key)
  if (!record) return null

  const now = Date.now()

  // Window expired — clean up and allow
  if (now - record.firstAttempt > WINDOW_MS) {
    attempts.delete(key)
    return null
  }

  if (record.count < MAX_ATTEMPTS) return null

  // Exponential backoff: 30s, 60s, 120s, 240s, ... for each attempt beyond the limit
  const extraAttempts = record.count - MAX_ATTEMPTS
  const backoffMs = 30_000 * Math.pow(2, extraAttempts)
  const unlockTime = record.lastAttempt + backoffMs

  if (now >= unlockTime) return null

  return Math.ceil((unlockTime - now) / 1000)
}

/**
 * Record a failed login attempt for a username.
 */
export function recordFailedAttempt(username: string): void {
  const key = username.toLowerCase()
  const now = Date.now()
  const record = attempts.get(key)

  if (!record || now - record.firstAttempt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttempt: now, lastAttempt: now })
  } else {
    record.count++
    record.lastAttempt = now
  }
}

/**
 * Clear failed attempts for a username (on successful login).
 */
export function clearAttempts(username: string): void {
  attempts.delete(username.toLowerCase())
}

/**
 * Remove expired entries from the rate limit map.
 * Runs every 15 minutes to bound memory growth from credential stuffing.
 */
function cleanupExpired(): void {
  const now = Date.now()
  for (const [key, record] of attempts) {
    if (now - record.firstAttempt > WINDOW_MS) {
      attempts.delete(key)
    }
  }
}

// Run cleanup every 15 minutes. Uses unref() so the timer doesn't keep the process alive.
const cleanupInterval = setInterval(cleanupExpired, 15 * 60 * 1000)
cleanupInterval.unref()

/**
 * Reset all rate limit state. For testing only.
 */
export function resetRateLimits(): void {
  attempts.clear()
}
