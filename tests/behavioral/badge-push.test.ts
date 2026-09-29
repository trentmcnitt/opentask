/**
 * App-icon badge pushes (2026-09-29, "the badge still says 2 when nothing is
 * overdue").
 *
 * Two things are pinned here:
 *
 * 1. The payload. The badge goes out as an alert-type push carrying only
 *    `aps.badge` (iOS and macOS apply it themselves, no app wake-up, no
 *    background-push budget), never as a silent push, and never to the watch.
 * 2. The overdue checker's change gate. It sends a badge-only push only when a
 *    user's overdue count differs from the badge last sent to them — it used
 *    to send one every minute, which used up iOS's silent-push allowance.
 *
 * apns2's client is faked (the real `Notification` class is kept, so the
 * payload under test is the one apns2 would put on the wire).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Notification } from 'apns2'

/** Every notification the fake client was asked to send, in order. */
const sent: Notification[] = []
/** Device tokens whose sends fail with a retryable error. */
const failing = new Set<string>()

vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  readFileSync: vi.fn(() => 'fake-key'),
}))

vi.mock('apns2', async (orig) => {
  const real = await orig<typeof import('apns2')>()
  class FakeClient {
    async send(n: Notification) {
      if (failing.has(n.deviceToken)) throw { reason: real.Errors.internalServerError }
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
const { buildBadgeNotification, sendApnsBadgeUpdate, deviceShowsBadge } =
  await import('@/core/notifications/apns')
const { checkOverdueTasks } = await import('@/core/notifications/overdue-checker')
const { syncBadgeCount } = await import('@/core/notifications/dismiss')
const { lastBadgeSent, resetBadgeState } = await import('@/core/notifications/badge-state')

const USER = 1

function setupDb() {
  resetDb()
  const db = getDb()
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, timezone, notifications_enabled)
     VALUES (?, 'badge@example.com', 'Badge User', 'hash', 'America/Chicago', 1)`,
  ).run(USER)
  db.prepare(
    `INSERT INTO projects (id, name, owner_id, shared, sort_order) VALUES (1, 'Inbox', ?, 0, 0)`,
  ).run(USER)
}

function addDevice(token: string, bundleId: string) {
  getDb()
    .prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, 'production')`,
    )
    .run(USER, token, bundleId)
}

let nextTaskId = 1
/**
 * A P0 task that went overdue `minutesAgo` (+30s) minutes ago. With P0's
 * 30-minute cadence, anything but a multiple of 30 is not a notification
 * boundary, so the checker sends it no visible notification — only the badge
 * path runs. Times are relative to the real clock because `getOverdueCount`
 * asks SQLite for `datetime('now')`.
 */
function addOverdueTask(minutesAgo: number): number {
  const id = nextTaskId++
  const dueAt = new Date(Date.now() - (minutesAgo * 60 + 30) * 1000).toISOString()
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, due_at, priority, user_id, project_id)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(id, `Task ${id}`, dueAt, USER)
  return id
}

function complete(id: number) {
  getDb().prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(id)
}

/** The badge-only pushes sent so far (the ones with no alert), as badge values. */
function badgePushes(): number[] {
  return sent
    .map((n) => n.buildApnsOptions().aps)
    .filter((aps) => aps.alert === undefined)
    .map((aps) => aps.badge as number)
}

beforeEach(() => {
  setupDb()
  nextTaskId = 1
  sent.length = 0
  failing.clear()
  resetBadgeState()
})
afterEach(() => resetDb())

describe('the badge-only payload', () => {
  test('is an alert-type push carrying nothing but aps.badge', () => {
    const n = buildBadgeNotification('tok', 'io.mcnitt.opentask', 3)

    // Alert type, not background: iOS applies the badge itself, outside the
    // silent-push budget.
    expect(n.pushType).toBe(PushType.alert)
    expect(n.priority).toBe(Priority.immediate)
    // No alert, no sound, no content-available, no custom data — so no
    // banner, no chime, and no app wake-up.
    expect(n.buildApnsOptions()).toEqual({ aps: { badge: 3 } })
    expect(n.options.topic).toBe('io.mcnitt.opentask')
    expect(n.options.collapseId).toBe('badge-update')
  })

  test('zero is sent as badge 0 (clears the icon), not left out', () => {
    expect(buildBadgeNotification('tok', 'io.mcnitt.opentask', 0).buildApnsOptions()).toEqual({
      aps: { badge: 0 },
    })
  })

  test('goes to the iPhone and the Mac, never to the watch', async () => {
    addDevice('phone', 'io.mcnitt.opentask')
    addDevice('mac', 'io.mcnitt.opentask.mac')
    addDevice('watch', 'io.mcnitt.opentask.watchapp')

    await sendApnsBadgeUpdate(USER, 2)

    expect(sent.map((n) => n.deviceToken).sort()).toEqual(['mac', 'phone'])
    expect(sent.map((n) => n.options.topic).sort()).toEqual([
      'io.mcnitt.opentask',
      'io.mcnitt.opentask.mac',
    ])
    expect(deviceShowsBadge({ bundle_id: 'com.example.app.watchkitapp' })).toBe(false)
  })

  test('a delivered badge is recorded; a failed one is forgotten', async () => {
    addDevice('phone', 'io.mcnitt.opentask')
    await sendApnsBadgeUpdate(USER, 2)
    expect(lastBadgeSent(USER)).toBe(2)

    failing.add('phone')
    await sendApnsBadgeUpdate(USER, 1)
    expect(lastBadgeSent(USER)).toBeUndefined()
  })
})

describe('the overdue checker sends a badge only when the count changes', () => {
  beforeEach(() => addDevice('phone', 'io.mcnitt.opentask'))

  test('an unchanged count is sent once, not every minute', async () => {
    addOverdueTask(10)
    addOverdueTask(20)

    await checkOverdueTasks()
    await checkOverdueTasks()
    await checkOverdueTasks()

    expect(badgePushes()).toEqual([2])
  })

  test('a task going overdue sends the new count', async () => {
    addOverdueTask(10)
    await checkOverdueTasks()
    addOverdueTask(5)
    await checkOverdueTasks()
    await checkOverdueTasks()

    expect(badgePushes()).toEqual([1, 2])
  })

  test('a count that drops to zero with no user action still sends the 0', async () => {
    const id = addOverdueTask(10)
    await checkOverdueTasks()
    complete(id) // straight to the DB: no syncBadgeCount ran
    await checkOverdueTasks()
    await checkOverdueTasks()

    expect(badgePushes()).toEqual([1, 0])
  })

  test('a user action’s badge is not repeated by the checker', async () => {
    addOverdueTask(10)
    addOverdueTask(20)
    syncBadgeCount(USER)
    await vi.waitFor(() => expect(lastBadgeSent(USER)).toBe(2))

    await checkOverdueTasks()

    expect(badgePushes()).toEqual([2])
  })

  test('a visible notification carries the badge, and the checker does not repeat it', async () => {
    // Due exactly 30 minutes ago (plus a few seconds): a P0 boundary, so this
    // tick sends the task's visible notification with aps.badge.
    const dueAt = new Date(Date.now() - (30 * 60 + 5) * 1000)
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, due_at, priority, user_id, project_id)
         VALUES (99, 'On the boundary', ?, 0, ?, 1)`,
      )
      .run(dueAt.toISOString(), USER)

    const now = new Date(dueAt.getTime() + 30 * 60 * 1000 + 5000)
    await checkOverdueTasks(now)
    const alerts = sent.filter((n) => n.buildApnsOptions().aps.alert !== undefined)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].buildApnsOptions().aps.badge).toBe(1)
    expect(lastBadgeSent(USER)).toBe(1)

    // A minute later: not a boundary, count unchanged → nothing.
    await checkOverdueTasks(new Date(now.getTime() + 60 * 1000))
    expect(badgePushes()).toEqual([])
  })

  test('a failed badge push is retried on the next tick', async () => {
    addOverdueTask(10)
    failing.add('phone')
    await checkOverdueTasks()
    expect(badgePushes()).toEqual([])

    failing.clear()
    await checkOverdueTasks()
    expect(badgePushes()).toEqual([1])
  })
})
