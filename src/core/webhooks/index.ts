/**
 * Webhook CRUD operations
 *
 * Manages webhook registrations for HTTP callbacks on task events.
 * Secrets are stored in plaintext (not hashed) because they are needed
 * for HMAC signing on every dispatch.
 */

import crypto from 'crypto'
import { getDb } from '@/core/db'

export interface Webhook {
  id: number
  user_id: number
  url: string
  secret: string
  events: string[]
  active: boolean
  created_at: string
  updated_at: string
}

/** Webhook without the secret field — used in list/update responses */
export type WebhookPublic = Omit<Webhook, 'secret'>

interface WebhookRow {
  id: number
  user_id: number
  url: string
  secret: string
  events: string
  active: number
  created_at: string
  updated_at: string
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    user_id: row.user_id,
    url: row.url,
    secret: row.secret,
    events: JSON.parse(row.events),
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toPublic(webhook: Webhook): WebhookPublic {
  const { secret: _, ...rest } = webhook
  return rest
}

/**
 * Get all webhooks for a user (secrets excluded)
 */
export function getWebhooks(userId: number): WebhookPublic[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM webhooks WHERE user_id = ?').all(userId) as WebhookRow[]
  return rows.map(rowToWebhook).map(toPublic)
}

/**
 * Get a single webhook by ID (includes secret for internal use)
 */
export function getWebhookById(webhookId: number): Webhook | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as
    | WebhookRow
    | undefined
  if (!row) return null
  return rowToWebhook(row)
}

/**
 * Create a webhook — auto-generates HMAC secret.
 * Returns the full webhook WITH secret (shown once to the user).
 */
export function createWebhook(userId: number, url: string, events: string[]): Webhook {
  const db = getDb()
  const secret = crypto.randomBytes(32).toString('hex')
  const eventsJson = JSON.stringify(events)

  const result = db
    .prepare('INSERT INTO webhooks (user_id, url, secret, events) VALUES (?, ?, ?, ?)')
    .run(userId, url, secret, eventsJson)

  const webhook = getWebhookById(Number(result.lastInsertRowid))
  if (!webhook) throw new Error('Failed to retrieve created webhook')
  return webhook
}

/**
 * Update a webhook (partial update). Returns updated webhook (secret excluded).
 * Verifies user_id matches for authorization.
 */
export function updateWebhook(
  webhookId: number,
  userId: number,
  updates: { url?: string; events?: string[]; active?: boolean },
): WebhookPublic | null {
  const db = getDb()

  const existing = getWebhookById(webhookId)
  if (!existing) return null
  if (existing.user_id !== userId) return null

  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.url !== undefined) {
    setClauses.push('url = ?')
    values.push(updates.url)
  }
  if (updates.events !== undefined) {
    setClauses.push('events = ?')
    values.push(JSON.stringify(updates.events))
  }
  if (updates.active !== undefined) {
    setClauses.push('active = ?')
    values.push(updates.active ? 1 : 0)
  }

  if (setClauses.length === 0) {
    return toPublic(existing)
  }

  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
  values.push(webhookId)

  db.prepare(`UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

  const updated = getWebhookById(webhookId)
  if (!updated) return null
  return toPublic(updated)
}

/**
 * Hard delete a webhook. Deliveries cascade via ON DELETE CASCADE.
 * Verifies user_id matches for authorization.
 * Returns true if deleted, false if not found or not owned.
 */
export function deleteWebhook(webhookId: number, userId: number): boolean {
  const db = getDb()

  const existing = getWebhookById(webhookId)
  if (!existing) return false
  if (existing.user_id !== userId) return false

  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId)
  return true
}

/**
 * Get recent deliveries for a webhook (last 50).
 * Verifies user owns the webhook.
 */
export function getWebhookDeliveries(webhookId: number, userId: number): WebhookDelivery[] | null {
  const db = getDb()

  const webhook = getWebhookById(webhookId)
  if (!webhook) return null
  if (webhook.user_id !== userId) return null

  const rows = db
    .prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50',
    )
    .all(webhookId) as WebhookDeliveryRow[]

  return rows.map(rowToDelivery)
}

export interface WebhookDelivery {
  id: number
  webhook_id: number
  event: string
  payload: string
  status_code: number | null
  error: string | null
  attempt: number
  created_at: string
}

interface WebhookDeliveryRow {
  id: number
  webhook_id: number
  event: string
  payload: string
  status_code: number | null
  error: string | null
  attempt: number
  created_at: string
}

function rowToDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return { ...row }
}
