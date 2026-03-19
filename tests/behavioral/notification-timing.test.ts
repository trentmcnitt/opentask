/**
 * Notification timing behavioral tests
 *
 * Tests the mod-based boundary detection and consolidation logic in the
 * unified overdue checker. Uses mocked push senders and frozen time to
 * verify that notifications fire only at the correct interval boundaries
 * relative to each task's due_at, and that consolidation caps are enforced.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb, resetDb } from '@/core/db'

// Mock push modules before importing the modules under test
vi.mock('@/core/notifications/web-push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  isWebPushConfigured: vi.fn().mockReturnValue(true),
}))
vi.mock('@/core/notifications/apns', () => ({
  sendApnsNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsSummaryNotification: vi.fn().mockResolvedValue(undefined),
  isApnsConfigured: vi.fn().mockReturnValue(true),
}))

import { checkOverdueTasks, isNotificationBoundary } from '@/core/notifications/overdue-checker'
import { sendPushNotification } from '@/core/notifications/web-push'
import { sendApnsNotification, sendApnsSummaryNotification } from '@/core/notifications/apns'

const TEST_USER_ID = 1

function setupDb() {
  resetDb()
  const db = getDb()
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, timezone, notifications_enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(TEST_USER_ID, 'test@example.com', 'Test User', 'hash', 'America/Chicago')
  db.prepare(
    `INSERT INTO projects (id, name, owner_id, shared, sort_order)
     VALUES (1, 'Inbox', ?, 0, 0)`,
  ).run(TEST_USER_ID)
}

function insertTask(
  id: number,
  title: string,
  dueAt: string,
  priority: number = 0,
  autoSnoozeMinutes: number | null = null,
) {
  const db = getDb()
  db.prepare(
    `INSERT INTO tasks (id, title, due_at, priority, user_id, project_id, auto_snooze_minutes)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, title, dueAt, priority, TEST_USER_ID, autoSnoozeMinutes)
}

// ─── Unit tests for boundary function ─────────────────────────────────────────

describe('isNotificationBoundary', () => {
  test('task at exact boundary (0 minutes overdue) → true', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const now = new Date('2026-01-15T10:00:00.000Z')
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, now)).toBe(true)
  })

  test('task at 30-minute boundary → true (default P0 interval)', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const now = new Date('2026-01-15T10:30:00.000Z')
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, now)).toBe(true)
  })

  test('task between boundaries (15 min overdue, 30 min interval) → false', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const now = new Date('2026-01-15T10:15:00.000Z')
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, now)).toBe(false)
  })

  test('P4 task uses urgent interval (5 min)', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 4,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    // 5 min → boundary
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:05:00.000Z'))).toBe(true)
    // 3 min → not boundary
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:03:00.000Z'))).toBe(false)
    // 10 min → boundary
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:10:00.000Z'))).toBe(true)
  })

  test('P3 task uses high interval (15 min)', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 3,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:15:00.000Z'))).toBe(true)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:07:00.000Z'))).toBe(false)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:30:00.000Z'))).toBe(true)
  })

  test('per-task auto_snooze_minutes override takes precedence', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: 10,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    // 10 min → boundary (using override, not the 30 min default)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:10:00.000Z'))).toBe(true)
    // 30 min → also boundary (30 % 10 === 0)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:30:00.000Z'))).toBe(true)
    // 15 min → not boundary (15 % 10 !== 0)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:15:00.000Z'))).toBe(false)
  })

  test('interval = 0 → never notifies', () => {
    const dueAt = '2026-01-15T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: 0,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(false)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:30:00.000Z'))).toBe(false)
  })

  test('task 1 minute overdue (exact minute boundary) → fires immediately', () => {
    // This is the common case: UI sets due time to a round minute (e.g., 10:00:00).
    // SQL strict < means the task first appears at minutesSinceDue = 1.
    const dueAt = '2026-01-15T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    // 1 minute overdue → should fire (first notification)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:01:00.000Z'))).toBe(true)
    // 2 minutes overdue → should NOT fire (not a boundary)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:02:00.000Z'))).toBe(false)
  })

  test('task due 1 day ago → only notifies on correct boundaries', () => {
    const dueAt = '2026-01-14T10:00:00.000Z'
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    // 1440 minutes later (24h) — 1440 % 30 === 0 → boundary
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(true)
    // 1441 minutes later — minutesSinceDue === 1 is handled by the first-notification
    // special case, but for a task 1 day old this is still technically minute 1441.
    // 1441 % 30 !== 0 AND 1441 !== 1, so not a boundary.
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:01:00.000Z'))).toBe(false)
  })

  test('task not yet overdue → false', () => {
    const dueAt = '2026-01-15T11:00:00.000Z'
    const now = new Date('2026-01-15T10:00:00.000Z')
    const task = {
      id: 1,
      title: 'Test',
      due_at: dueAt,
      priority: 0,
      user_id: 1,
      auto_snooze_minutes: null,
      user_auto_snooze_minutes: 30,
      user_auto_snooze_urgent_minutes: 5,
      user_auto_snooze_high_minutes: 15,
      critical_alert_volume: 1.0,
    }
    expect(isNotificationBoundary(task, now)).toBe(false)
  })
})

// ─── Integration tests with DB + mocked push ────────────────────────────────
// These tests use nowOverride to control the clock for both the SQL query
// and the JS boundary check, ensuring the <= filter is properly tested.

describe('checkOverdueTasks', () => {
  beforeEach(() => {
    setupDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetDb()
  })

  test('sends notification for task at exact due time (<=)', async () => {
    // Task due at 10:00, check at exactly 10:00 → minutesSinceDue = 0, 0 % 30 = 0 → fires
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:00:00.000Z'))

    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
  })

  test('sends notification for task 1 minute overdue', async () => {
    // Task due at 10:00, check at 10:01 → minutesSinceDue = 1, fires via special case
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:01:00.000Z'))

    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
  })

  test('does NOT include task that is not yet due', async () => {
    // Task due at 10:05, check at 10:00 → task is in the future, should NOT notify
    insertTask(1, 'Future task', '2026-01-15T10:05:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:00:00.000Z'))

    expect(sendPushNotification).not.toHaveBeenCalled()
    expect(sendApnsNotification).not.toHaveBeenCalled()
  })

  test('sends notification for task at boundary', async () => {
    // Task due at 10:00, check at 10:30 → 30 min boundary (default P0 interval)
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    expect(sendPushNotification).toHaveBeenCalledTimes(1)
  })

  test('skips task between boundaries', async () => {
    // Task due at 10:00, check at 10:15 → not a 30-min boundary
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:15:00.000Z'))

    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  test('P4 task gets both web push and APNs critical alert', async () => {
    // Task due at 10:00, check at 10:05 → 5 min boundary (P4 urgent)
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkOverdueTasks(new Date('2026-01-15T10:05:00.000Z'))

    // P4 gets individual web push AND APNs with critical interruption level
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        title: 'URGENT: Urgent task',
        interruptionLevel: 'critical',
        criticalAlertVolume: 1.0,
      }),
    )
  })

  test('P3 task gets time-sensitive APNs', async () => {
    insertTask(1, 'High task', '2026-01-15T10:00:00.000Z', 3)

    await checkOverdueTasks(new Date('2026-01-15T10:15:00.000Z'))

    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        title: 'HIGH: High task',
        interruptionLevel: 'time-sensitive',
      }),
    )
    const payload = vi.mocked(sendApnsNotification).mock.calls[0][1]
    expect(payload.criticalAlertVolume).toBeUndefined()
  })

  test('P3 task uses high interval', async () => {
    // Task due at 10:00, check at 10:15 → 15 min boundary (P3 high)
    insertTask(1, 'High task', '2026-01-15T10:00:00.000Z', 3)

    await checkOverdueTasks(new Date('2026-01-15T10:15:00.000Z'))

    // Web push + APNs, both individual
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
  })

  test('multiple tasks with different priorities — all get individual notifications', async () => {
    // At 10:30: P0 at 30-min boundary, P3 at 30-min boundary, P4 at 30-min boundary
    insertTask(1, 'Low task', '2026-01-15T10:00:00.000Z', 0)
    insertTask(2, 'High task', '2026-01-15T10:00:00.000Z', 3)
    insertTask(3, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // Web push: 3 individual (1 per bucket, all under caps)
    expect(sendPushNotification).toHaveBeenCalledTimes(3)
    // APNs: 3 individual (all priorities now get APNs)
    expect(sendApnsNotification).toHaveBeenCalledTimes(3)
  })

  test('P0-P1 tasks under cap get individual notifications', async () => {
    insertTask(1, 'Task A', '2026-01-15T10:00:00.000Z', 0)
    insertTask(2, 'Task B', '2026-01-15T10:00:00.000Z', 1)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // Under the cap of 4, so both get individual web push + APNs
    expect(sendPushNotification).toHaveBeenCalledTimes(2)
    expect(sendApnsNotification).toHaveBeenCalledTimes(2)
    expect(sendApnsSummaryNotification).not.toHaveBeenCalled()
  })

  test('does not write last_notified_at to database', async () => {
    insertTask(1, 'Test task', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    const db = getDb()
    const task = db.prepare('SELECT last_notified_at FROM tasks WHERE id = 1').get() as {
      last_notified_at: string | null
    }
    expect(task.last_notified_at).toBeNull()
  })
})

// ─── Consolidation cap tests ─────────────────────────────────────────────────

describe('consolidation caps', () => {
  beforeEach(() => {
    setupDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetDb()
  })

  test('Regular bucket (P0-P2): 4 individual + 1 summary when > 4 tasks', async () => {
    // 6 P0 tasks, all at 30-min boundary
    for (let i = 1; i <= 6; i++) {
      insertTask(i, `Task ${i}`, '2026-01-15T10:00:00.000Z', 0)
    }

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // 4 individual web push + 1 summary web push = 5
    expect(sendPushNotification).toHaveBeenCalledTimes(5)
    // 4 individual APNs + 1 summary APNs = 5
    expect(sendApnsNotification).toHaveBeenCalledTimes(4)
    expect(sendApnsSummaryNotification).toHaveBeenCalledTimes(1)

    // Verify summary mentions the overflow count
    const summaryCall = vi.mocked(sendApnsSummaryNotification).mock.calls[0]
    expect(summaryCall[1]).toContain('2 more')
  })

  test('Regular bucket prioritizes P2 over P1 over P0 for individual slots', async () => {
    // 6 tasks: 2 P0, 2 P1, 2 P2. Only 4 get individual. P2 should get slots first.
    insertTask(1, 'P0-A', '2026-01-15T10:00:00.000Z', 0)
    insertTask(2, 'P0-B', '2026-01-15T10:00:00.000Z', 0)
    insertTask(3, 'P1-A', '2026-01-15T10:00:00.000Z', 1)
    insertTask(4, 'P1-B', '2026-01-15T10:00:00.000Z', 1)
    insertTask(5, 'P2-A', '2026-01-15T10:00:00.000Z', 2)
    insertTask(6, 'P2-B', '2026-01-15T10:00:00.000Z', 2)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // 4 individual + 1 summary = 5 web push
    expect(sendPushNotification).toHaveBeenCalledTimes(5)

    // First 4 individual calls should be the highest priority tasks
    const individualCalls = vi.mocked(sendPushNotification).mock.calls.slice(0, 4)
    const titles = individualCalls.map((c) => c[1].title)
    // P2 tasks come first (priority DESC), then P1
    expect(titles[0]).toBe('P2-A')
    expect(titles[1]).toBe('P2-B')
    expect(titles[2]).toBe('P1-A')
    expect(titles[3]).toBe('P1-B')
  })

  test('High bucket (P3): 5 individual + 1 summary when > 5 tasks', async () => {
    // 7 P3 tasks, all at 30-min boundary (30 % 15 === 0)
    for (let i = 1; i <= 7; i++) {
      insertTask(i, `High ${i}`, '2026-01-15T10:00:00.000Z', 3)
    }

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // 5 individual web push + 1 summary = 6
    expect(sendPushNotification).toHaveBeenCalledTimes(6)
    // 5 individual APNs + 1 summary
    expect(sendApnsNotification).toHaveBeenCalledTimes(5)
    expect(sendApnsSummaryNotification).toHaveBeenCalledTimes(1)
    const summaryCall = vi.mocked(sendApnsSummaryNotification).mock.calls[0]
    expect(summaryCall[1]).toContain('2 more')
  })

  test('Urgent bucket (P4): unlimited, no summary', async () => {
    // 10 P4 tasks, all at 5-min boundary
    for (let i = 1; i <= 10; i++) {
      insertTask(i, `Urgent ${i}`, '2026-01-15T10:00:00.000Z', 4)
    }

    await checkOverdueTasks(new Date('2026-01-15T10:05:00.000Z'))

    // All 10 get individual web push + APNs, no summary
    expect(sendPushNotification).toHaveBeenCalledTimes(10)
    expect(sendApnsNotification).toHaveBeenCalledTimes(10)
    expect(sendApnsSummaryNotification).not.toHaveBeenCalled()
  })

  test('mixed priorities: each bucket consolidates independently', async () => {
    // 6 P0 tasks (Regular: 4 individual + 1 summary)
    for (let i = 1; i <= 6; i++) {
      insertTask(i, `Low ${i}`, '2026-01-15T10:00:00.000Z', 0)
    }
    // 7 P3 tasks (High: 5 individual + 1 summary) — 30 % 15 === 0
    for (let i = 7; i <= 13; i++) {
      insertTask(i, `High ${i}`, '2026-01-15T10:00:00.000Z', 3)
    }
    // 2 P4 tasks (Urgent: 2 individual, no summary) — 30 % 5 === 0
    insertTask(14, 'Urgent A', '2026-01-15T10:00:00.000Z', 4)
    insertTask(15, 'Urgent B', '2026-01-15T10:00:00.000Z', 4)

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // Web push: (4+1) + (5+1) + 2 = 13
    expect(sendPushNotification).toHaveBeenCalledTimes(13)
    // APNs individual: 4 + 5 + 2 = 11
    expect(sendApnsNotification).toHaveBeenCalledTimes(11)
    // APNs summary: 1 (regular) + 1 (high) = 2
    expect(sendApnsSummaryNotification).toHaveBeenCalledTimes(2)
  })

  test('exactly at cap: no summary sent', async () => {
    // Exactly 4 P0 tasks — at cap, no overflow
    for (let i = 1; i <= 4; i++) {
      insertTask(i, `Task ${i}`, '2026-01-15T10:00:00.000Z', 0)
    }

    await checkOverdueTasks(new Date('2026-01-15T10:30:00.000Z'))

    // 4 individual, no summary
    expect(sendPushNotification).toHaveBeenCalledTimes(4)
    expect(sendApnsNotification).toHaveBeenCalledTimes(4)
    expect(sendApnsSummaryNotification).not.toHaveBeenCalled()
  })
})
