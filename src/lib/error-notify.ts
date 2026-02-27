/**
 * Error alerting via ntfy
 *
 * Sends a fire-and-forget ntfy notification when failures occur:
 * server-side (5xx, AI failures, circuit breaker, cron errors) and
 * client-side (JS errors, React crashes, service worker errors).
 *
 * Rate limited per category to prevent alert flooding during cascading failures.
 *
 * Enabled when OPENTASK_NTFY_TOPIC is set.
 */

const NTFY_URL = process.env.OPENTASK_NTFY_URL || 'https://ntfy.sh'
const NTFY_TOPIC = process.env.OPENTASK_NTFY_TOPIC || ''

export type AlertCategory =
  | 'server-error'
  | 'client-error'
  | 'circuit-breaker'
  | 'ai-failure'
  | 'cron-failure'
  | 'slot-failure'

const PRIORITY: Record<AlertCategory, number> = {
  'circuit-breaker': 5,
  'server-error': 4,
  'client-error': 4,
  'cron-failure': 4,
  'ai-failure': 3,
  'slot-failure': 3,
}

const TAGS: Record<AlertCategory, string> = {
  'server-error': 'rotating_light',
  'client-error': 'iphone',
  'circuit-breaker': 'zap',
  'ai-failure': 'robot',
  'cron-failure': 'clock3',
  'slot-failure': 'warning',
}

const RATE_LIMIT_MS: Record<AlertCategory, number> = {
  'server-error': 300_000,
  'client-error': 300_000,
  'circuit-breaker': 1_800_000,
  'ai-failure': 300_000,
  'cron-failure': 300_000,
  'slot-failure': 600_000,
}

const lastNotified = new Map<AlertCategory, number>()

function isConfigured(): boolean {
  return Boolean(NTFY_TOPIC)
}

/**
 * Send an error alert via ntfy. Fire-and-forget — never throws, never blocks.
 * Rate-limited per category to prevent alert flooding.
 */
export function notifyError(category: AlertCategory, message: string, details?: string): void {
  if (!isConfigured()) return

  const now = Date.now()
  const last = lastNotified.get(category) ?? 0
  if (now - last < RATE_LIMIT_MS[category]) return
  lastNotified.set(category, now)

  const headers: Record<string, string> = {
    Title: `OpenTask: ${message}`,
    Priority: String(PRIORITY[category]),
    Tags: TAGS[category],
  }

  const body = details ? `[${category}] ${details}` : `[${category}] ${message}`

  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers,
    body,
  }).catch(() => {})
}

/** Reset rate limits — test helper only */
export function _resetRateLimits(): void {
  lastNotified.clear()
}
