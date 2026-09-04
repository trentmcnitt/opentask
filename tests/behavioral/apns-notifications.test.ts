/**
 * APNs Notification Behavioral Tests
 *
 * Tests the apns_devices table CRUD operations and payload structure.
 * Does NOT test actual APNs delivery (requires real Apple credentials).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { listTimeSlots } from '@/core/time-slots'
import { pendingSlotNotifications, slotsDueNow } from '@/core/notifications/slot-reminders'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

describe('APNs Device Registration', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('insert a new device token', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'abc123token', 'io.mcnitt.opentask', 'production')

    const device = db
      .prepare('SELECT * FROM apns_devices WHERE user_id = ?')
      .get(TEST_USER_ID) as Record<string, unknown>

    expect(device).toBeDefined()
    expect(device.device_token).toBe('abc123token')
    expect(device.bundle_id).toBe('io.mcnitt.opentask')
    expect(device.environment).toBe('production')
    expect(device.created_at).toBeTruthy()
  })

  test('device_token is unique', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'abc123token', 'io.mcnitt.opentask', 'production')

    // Upsert with same token should update, not duplicate
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_token) DO UPDATE SET
         user_id = excluded.user_id,
         bundle_id = excluded.bundle_id,
         environment = excluded.environment`,
    ).run(TEST_USER_ID, 'abc123token', 'io.mcnitt.opentask', 'development')

    const devices = db
      .prepare('SELECT * FROM apns_devices WHERE device_token = ?')
      .all('abc123token') as Record<string, unknown>[]

    expect(devices).toHaveLength(1)
    expect(devices[0].environment).toBe('development')
  })

  test('multiple devices per user', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'iphone-token', 'io.mcnitt.opentask', 'production')

    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'ipad-token', 'io.mcnitt.opentask', 'production')

    const devices = db.prepare('SELECT * FROM apns_devices WHERE user_id = ?').all(TEST_USER_ID)

    expect(devices).toHaveLength(2)
  })

  test('delete device token', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'abc123token', 'io.mcnitt.opentask', 'production')

    db.prepare('DELETE FROM apns_devices WHERE user_id = ? AND device_token = ?').run(
      TEST_USER_ID,
      'abc123token',
    )

    const devices = db.prepare('SELECT * FROM apns_devices WHERE user_id = ?').all(TEST_USER_ID)

    expect(devices).toHaveLength(0)
  })

  test('index on user_id exists', () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='apns_devices'")
      .all() as { name: string }[]

    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_apns_devices_user_id')
  })
})

/**
 * Time-slot reminder pushes (REDESIGN-V03 §6 / §6.1)
 *
 * The SLOT notifies, not the item — so the whole decision is "which slot is
 * opening this minute, and does it have anything pending". These tests cover
 * that decision; delivery itself needs real APNs credentials and a device.
 */
describe('Slot reminder notifications', () => {
  beforeEach(() => {
    // 2026-01-15 07:00 Chicago (13:00 UTC) — the "Early morning" boundary.
    vi.setSystemTime(new Date('2026-01-15T13:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function makeReminder(hour: number, minute = 0) {
    return createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Consider the day ahead',
        is_reminder: true,
        due_at: localTime(hour, minute),
      },
    })
  }

  test('a slot is due only on the minute its start_time matches local time', () => {
    const slots = listTimeSlots(TEST_USER_ID)

    const due = slotsDueNow(slots, TEST_TIMEZONE, new Date('2026-01-15T13:00:00Z'))
    expect(due.map((s) => s.label)).toEqual(['Early morning'])

    // One minute later is not the boundary — no catch-up, by design.
    const late = slotsDueNow(slots, TEST_TIMEZONE, new Date('2026-01-15T13:01:00Z'))
    expect(late).toHaveLength(0)
  })

  test('slot boundaries are local, not UTC', () => {
    const slots = listTimeSlots(TEST_USER_ID)
    // 07:00 UTC is 01:00 in Chicago — before every slot boundary.
    expect(slotsDueNow(slots, TEST_TIMEZONE, new Date('2026-01-15T07:00:00Z'))).toHaveLength(0)
  })

  test('an opening slot with pending reminders produces one notification with its count', () => {
    makeReminder(7)
    makeReminder(7, 30)
    makeReminder(20, 30) // different slot — must not inflate the count

    const pending = pendingSlotNotifications()

    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      userId: TEST_USER_ID,
      slotLabel: 'Early morning',
      count: 2,
    })
    expect(pending[0].slotId).toBeGreaterThan(0)
  })

  test('an empty slot stays silent', () => {
    expect(pendingSlotNotifications()).toHaveLength(0)
  })

  test('completed reminders drop out of the count', () => {
    const first = makeReminder(7)
    makeReminder(7, 30)

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: first.id })

    const pending = pendingSlotNotifications()
    expect(pending).toHaveLength(1)
    expect(pending[0].count).toBe(1)
  })

  test('users with notifications disabled are skipped', () => {
    makeReminder(7)
    getDb().prepare('UPDATE users SET notifications_enabled = 0 WHERE id = ?').run(TEST_USER_ID)

    expect(pendingSlotNotifications()).toHaveLength(0)
  })
})
