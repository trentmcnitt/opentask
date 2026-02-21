/**
 * Notification timing behavioral tests
 *
 * Tests the mod-based boundary detection used by overdue-checker and critical-alerts.
 * Uses mocked push senders and frozen time to verify that notifications fire only
 * at the correct interval boundaries relative to each task's due_at.
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
  isApnsConfigured: vi.fn().mockReturnValue(true),
}))

import { checkOverdueTasks, isNotificationBoundary } from '@/core/notifications/overdue-checker'
import { checkCriticalTasks, isCriticalAlertBoundary } from '@/core/notifications/critical-alerts'
import { sendPushNotification } from '@/core/notifications/web-push'
import { sendApnsNotification } from '@/core/notifications/apns'

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

// ─── Unit tests for boundary functions ───────────────────────────────────────

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
    }
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(false)
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:30:00.000Z'))).toBe(false)
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
    }
    // 1440 minutes later (24h) — 1440 % 30 === 0 → boundary
    expect(isNotificationBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(true)
    // 1441 minutes later — 1441 % 30 !== 0 → not boundary
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
    }
    expect(isNotificationBoundary(task, now)).toBe(false)
  })
})

describe('isCriticalAlertBoundary', () => {
  test('P4 task at 60-minute boundary → true', () => {
    const task = {
      id: 1,
      title: 'Test',
      due_at: '2026-01-15T10:00:00.000Z',
      priority: 4,
      user_id: 1,
    }
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(true)
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T11:00:00.000Z'))).toBe(true)
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T12:00:00.000Z'))).toBe(true)
  })

  test('P4 task between 60-minute boundaries → false', () => {
    const task = {
      id: 1,
      title: 'Test',
      due_at: '2026-01-15T10:00:00.000Z',
      priority: 4,
      user_id: 1,
    }
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T10:30:00.000Z'))).toBe(false)
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T10:59:00.000Z'))).toBe(false)
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T11:01:00.000Z'))).toBe(false)
  })

  test('task not yet overdue → false', () => {
    const task = {
      id: 1,
      title: 'Test',
      due_at: '2026-01-15T11:00:00.000Z',
      priority: 4,
      user_id: 1,
    }
    expect(isCriticalAlertBoundary(task, new Date('2026-01-15T10:00:00.000Z'))).toBe(false)
  })
})

// ─── Integration tests with DB + mocked push ────────────────────────────────

describe('checkOverdueTasks', () => {
  beforeEach(() => {
    setupDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetDb()
  })

  test('sends notification for task at boundary', async () => {
    // Task due at 10:00, check at 10:30 → 30 min boundary (default P0 interval)
    vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'))
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks()

    expect(sendPushNotification).toHaveBeenCalledTimes(1)
  })

  test('skips task between boundaries', async () => {
    // Task due at 10:00, check at 10:15 → not a 30-min boundary
    vi.setSystemTime(new Date('2026-01-15T10:15:00.000Z'))
    insertTask(1, 'Buy groceries', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks()

    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  test('P4 task uses urgent interval for Web Push', async () => {
    // Task due at 10:00, check at 10:05 → 5 min boundary (P4 urgent)
    vi.setSystemTime(new Date('2026-01-15T10:05:00.000Z'))
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkOverdueTasks()

    // P4 gets web push from overdue checker (individual, since P2+)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    // P4 APNs is NOT sent by overdue checker — that's critical-alerts' job
    expect(sendApnsNotification).not.toHaveBeenCalled()
  })

  test('P3 task uses high interval', async () => {
    // Task due at 10:00, check at 10:15 → 15 min boundary (P3 high)
    vi.setSystemTime(new Date('2026-01-15T10:15:00.000Z'))
    insertTask(1, 'High task', '2026-01-15T10:00:00.000Z', 3)

    await checkOverdueTasks()

    // Web push (individual, since P2+) + APNs (P3 gets APNs from overdue checker)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
  })

  test('multiple tasks with different priorities split correctly', async () => {
    // At 10:30: P0 at 30-min boundary, P3 at 30-min boundary (15 divides 30), P4 at 30-min boundary
    vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'))
    insertTask(1, 'Low task', '2026-01-15T10:00:00.000Z', 0)
    insertTask(2, 'High task', '2026-01-15T10:00:00.000Z', 3)
    insertTask(3, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkOverdueTasks()

    // Web push: P3 individual + P4 individual + P0 individual (single low-priority task)
    expect(sendPushNotification).toHaveBeenCalledTimes(3)
    // APNs: P3 gets APNs + P0 gets APNs (P4 skipped — handled by critical-alerts)
    expect(sendApnsNotification).toHaveBeenCalledTimes(2)
  })

  test('multiple P0-P1 tasks get bulk Web Push', async () => {
    vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'))
    insertTask(1, 'Task A', '2026-01-15T10:00:00.000Z', 0)
    insertTask(2, 'Task B', '2026-01-15T10:00:00.000Z', 1)

    await checkOverdueTasks()

    // Web push: 1 bulk notification (not 2 individual)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)
    const call = vi.mocked(sendPushNotification).mock.calls[0]
    expect(call[1]).toMatchObject({ title: '2 overdue tasks' })
    // APNs: 2 individual (APNs never bulk)
    expect(sendApnsNotification).toHaveBeenCalledTimes(2)
  })

  test('does not write last_notified_at to database', async () => {
    vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'))
    insertTask(1, 'Test task', '2026-01-15T10:00:00.000Z', 0)

    await checkOverdueTasks()

    const db = getDb()
    const task = db.prepare('SELECT last_notified_at FROM tasks WHERE id = 1').get() as {
      last_notified_at: string | null
    }
    expect(task.last_notified_at).toBeNull()
  })
})

describe('checkCriticalTasks', () => {
  beforeEach(() => {
    setupDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetDb()
  })

  test('sends APNs for P4 task at 60-minute boundary', async () => {
    vi.setSystemTime(new Date('2026-01-15T11:00:00.000Z'))
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkCriticalTasks()

    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        title: 'URGENT: Urgent task',
        interruptionLevel: 'time-sensitive',
      }),
    )
  })

  test('skips P4 task between 60-minute boundaries', async () => {
    vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'))
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkCriticalTasks()

    expect(sendApnsNotification).not.toHaveBeenCalled()
  })

  test('non-P4 task is never included', async () => {
    vi.setSystemTime(new Date('2026-01-15T11:00:00.000Z'))
    insertTask(1, 'High task', '2026-01-15T10:00:00.000Z', 3)

    await checkCriticalTasks()

    expect(sendApnsNotification).not.toHaveBeenCalled()
  })

  test('does not write last_critical_alert_at to database', async () => {
    vi.setSystemTime(new Date('2026-01-15T11:00:00.000Z'))
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkCriticalTasks()

    const db = getDb()
    const task = db.prepare('SELECT last_critical_alert_at FROM tasks WHERE id = 1').get() as {
      last_critical_alert_at: string | null
    }
    expect(task.last_critical_alert_at).toBeNull()
  })

  test('P4 task at 2-hour boundary sends alert', async () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))
    insertTask(1, 'Urgent task', '2026-01-15T10:00:00.000Z', 4)

    await checkCriticalTasks()

    // 120 min / 60 = 2 → 120 % 60 === 0 → boundary
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
  })
})
