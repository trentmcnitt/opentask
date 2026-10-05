/**
 * The "AI finished" notification's APNs payload (enrichment-notify.ts,
 * `buildEnrichedNotification` in apns.ts): a banner without sound, immediate, the
 * `TASK_ADDED` category (Done and Delete, not the overdue notification's
 * snooze buttons), collapse and thread id per task, and the `taskId` the apps
 * open on tap.
 *
 * apns2's client is faked, the real `Notification` class kept, so what is
 * asserted is what apns2 would put on the wire (same approach as
 * badge-push.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Notification } from 'apns2'

const sent: Notification[] = []

vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  readFileSync: vi.fn(() => 'fake-key'),
}))

vi.mock('apns2', async (orig) => {
  const real = await orig<typeof import('apns2')>()
  class FakeClient {
    async send(n: Notification) {
      sent.push(n)
    }
  }
  return { ...real, ApnsClient: FakeClient }
})

process.env.APNS_KEY_ID = 'K'
process.env.APNS_TEAM_ID = 'T'
process.env.APNS_KEY_PATH = '/fake.p8'
process.env.APNS_BUNDLE_ID = 'io.mcnitt.opentask'

const { getDb, resetDb } = await import('@/core/db')
const { PushType, Priority } = await import('apns2')
const {
  buildEnrichedNotification,
  sendApnsEnrichedNotification,
  buildEnrichmentFailedNotification,
  sendApnsEnrichmentFailedNotification,
} = await import('@/core/notifications/apns')

const USER = 1

function addDevice(token: string, bundleId: string) {
  getDb()
    .prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, 'production')`,
    )
    .run(USER, token, bundleId)
}

beforeEach(() => {
  resetDb()
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, timezone)
       VALUES (?, 'enriched@example.com', 'Enriched User', 'hash', 'America/Chicago')`,
    )
    .run(USER)
  sent.length = 0
})
afterEach(() => resetDb())

describe('the enriched-task APNs payload', () => {
  const payload = {
    title: 'Call the dentist',
    body: 'Added to Work · Tomorrow 9:00 AM · High',
    taskId: 42,
  }

  test('is a banner without sound, immediate, TASK_ADDED, with no badge', () => {
    const n = buildEnrichedNotification('tok', 'io.mcnitt.opentask', payload)

    expect(n.pushType).toBe(PushType.alert)
    expect(n.priority).toBe(Priority.immediate)
    // `active` with no `sound` and no `badge`: a banner that never chimes and
    // leaves the icon badge alone. `TASK_ADDED` carries Done and Delete (the apps
    // register it — NotificationConstants.swift), not the overdue buttons.
    expect(n.buildApnsOptions()).toEqual({
      aps: {
        alert: { title: 'Call the dentist', body: 'Added to Work · Tomorrow 9:00 AM · High' },
        category: 'TASK_ADDED',
        'thread-id': 'enriched-42',
        'interruption-level': 'active',
      },
      taskId: 42,
    })
    expect(n.options.collapseId).toBe('enriched-42')
    expect(n.options.topic).toBe('io.mcnitt.opentask')
  })

  test('goes to every registered device, the watch included (as overdue alerts do)', async () => {
    addDevice('phone', 'io.mcnitt.opentask')
    addDevice('mac', 'io.mcnitt.opentask.mac')
    addDevice('watch', 'io.mcnitt.opentask.watchapp')

    await sendApnsEnrichedNotification(USER, payload)

    expect(sent.map((n) => n.deviceToken).sort()).toEqual(['mac', 'phone', 'watch'])
    for (const n of sent) {
      expect(n.buildApnsOptions().aps['interruption-level']).toBe('active')
    }
  })
})

// The "AI couldn't process" push (enrichment-failed-notify.ts): the same
// delivery, its own ids — so it never replaces, or is replaced by, the "AI
// finished" push for the same task.
describe('the enrichment-failed APNs payload', () => {
  const payload = {
    title: "AI couldn't process a task",
    body: 'call the dentist tomorrow 9am',
    taskId: 42,
  }

  test('is a banner without sound, immediate, TASK_ADDED, with ai-failed-<id> ids', () => {
    const n = buildEnrichmentFailedNotification('tok', 'io.mcnitt.opentask', payload)

    expect(n.pushType).toBe(PushType.alert)
    expect(n.priority).toBe(Priority.immediate)
    expect(n.buildApnsOptions()).toEqual({
      aps: {
        alert: { title: "AI couldn't process a task", body: 'call the dentist tomorrow 9am' },
        category: 'TASK_ADDED',
        'thread-id': 'ai-failed-42',
        'interruption-level': 'active',
      },
      taskId: 42,
    })
    expect(n.options.collapseId).toBe('ai-failed-42')
    expect(n.options.topic).toBe('io.mcnitt.opentask')
  })

  test('goes to every registered device, the watch included', async () => {
    addDevice('phone', 'io.mcnitt.opentask')
    addDevice('mac', 'io.mcnitt.opentask.mac')
    addDevice('watch', 'io.mcnitt.opentask.watchapp')

    await sendApnsEnrichmentFailedNotification(USER, payload)

    expect(sent.map((n) => n.deviceToken).sort()).toEqual(['mac', 'phone', 'watch'])
    for (const n of sent) {
      expect(n.options.collapseId).toBe('ai-failed-42')
    }
  })
})
