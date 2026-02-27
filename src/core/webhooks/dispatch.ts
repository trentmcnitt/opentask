/**
 * Webhook event dispatch — fire-and-forget HTTP callbacks
 *
 * When a task event occurs, this module finds matching active webhooks
 * and POSTs the event payload with HMAC-SHA256 signing. Delivery results
 * are logged to webhook_deliveries for debugging.
 *
 * IMPORTANT: This module never throws — all errors are caught and logged.
 * Webhook dispatch must never block or break the mutation that triggered it.
 */

import crypto from 'crypto'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

interface WebhookRow {
  id: number
  url: string
  secret: string
  events: string
}

/**
 * Dispatch a webhook event to all matching active webhooks for a user.
 * Fire-and-forget: callers should not await this.
 */
export function dispatchWebhookEvent(
  userId: number,
  event: string,
  data: Record<string, unknown>,
): void {
  try {
    const db = getDb()
    const webhooks = db
      .prepare('SELECT id, url, secret, events FROM webhooks WHERE user_id = ? AND active = 1')
      .all(userId) as WebhookRow[]

    for (const webhook of webhooks) {
      const events: string[] = JSON.parse(webhook.events)
      if (!events.includes(event)) continue

      // Fire async — don't block the caller
      deliverWithRetry(webhook, event, data).catch((err) => {
        log.error('webhooks', `Unexpected dispatch error for webhook ${webhook.id}:`, err)
      })
    }
  } catch (err) {
    log.error('webhooks', 'dispatchWebhookEvent failed:', err)
  }
}

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1000, 5000] // delays between attempts 1→2 and 2→3

async function deliverWithRetry(
  webhook: WebhookRow,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { statusCode, error, body } = await deliver(webhook, event, data)
    logDelivery(webhook.id, event, body, statusCode, error, attempt)

    // Success: 2xx status
    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      return
    }

    // Last attempt — don't retry
    if (attempt >= MAX_ATTEMPTS) {
      log.warn(
        'webhooks',
        `Webhook ${webhook.id} delivery failed after ${MAX_ATTEMPTS} attempts for ${event}`,
      )
      return
    }

    // Wait before retrying
    await sleep(RETRY_DELAYS_MS[attempt - 1])
  }
}

async function deliver(
  webhook: WebhookRow,
  event: string,
  data: Record<string, unknown>,
): Promise<{ statusCode: number | null; error: string | null; body: string }> {
  const payload = { event, timestamp: new Date().toISOString(), data }
  const body = JSON.stringify(payload)
  const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex')

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenTask-Event': event,
        'X-OpenTask-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    })
    return { statusCode: response.status, error: null, body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { statusCode: null, error: message, body }
  }
}

function logDelivery(
  webhookId: number,
  event: string,
  payload: string,
  statusCode: number | null,
  error: string | null,
  attempt: number,
): void {
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, error, attempt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(webhookId, event, payload, statusCode, error, attempt)
  } catch (err) {
    log.error('webhooks', 'Failed to log webhook delivery:', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
