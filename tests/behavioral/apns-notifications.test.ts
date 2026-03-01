/**
 * APNs Notification Behavioral Tests
 *
 * Tests the apns_devices table CRUD operations and payload structure.
 * Does NOT test actual APNs delivery (requires real Apple credentials).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'

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
