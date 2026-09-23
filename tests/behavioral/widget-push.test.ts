/**
 * WidgetKit Push Sync Behavioral Tests
 *
 * Covers the two things that don't need real APNs credentials or a device:
 * - the widget_push_tokens table (CRUD, uniqueness, index)
 * - the trailing-edge debounce/coalescing logic in widget-push.ts
 *
 * Does NOT test actual APNs delivery (requires real Apple credentials) —
 * same boundary as tests/behavioral/apns-notifications.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTrailingDebouncer, isDemoUser } from '@/core/notifications/widget-push'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'

describe('widget_push_tokens table', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  test('insert a new widget push token', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, widget_kind, environment)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      TEST_USER_ID,
      'abc123widgettoken',
      'io.mcnitt.opentask',
      'ios',
      'OpenTaskTasks',
      'production',
    )

    const row = db
      .prepare('SELECT * FROM widget_push_tokens WHERE user_id = ?')
      .get(TEST_USER_ID) as Record<string, unknown>

    expect(row).toBeDefined()
    expect(row.push_token).toBe('abc123widgettoken')
    expect(row.bundle_id).toBe('io.mcnitt.opentask')
    expect(row.platform).toBe('ios')
    expect(row.widget_kind).toBe('OpenTaskTasks')
    expect(row.environment).toBe('production')
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
  })

  test('push_token is unique — re-registering upserts instead of duplicating', () => {
    const db = getDb()
    const insert = `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, widget_kind, environment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(push_token) DO UPDATE SET
         user_id = excluded.user_id,
         bundle_id = excluded.bundle_id,
         platform = excluded.platform,
         widget_kind = excluded.widget_kind,
         environment = excluded.environment`

    db.prepare(insert).run(
      TEST_USER_ID,
      'shared-token',
      'io.mcnitt.opentask',
      'ios',
      'OpenTaskTasks',
      'production',
    )
    // Same token reported by a second widget kind's handler instance.
    db.prepare(insert).run(
      TEST_USER_ID,
      'shared-token',
      'io.mcnitt.opentask',
      'ios',
      'OpenTaskReminders',
      'production',
    )

    const rows = db
      .prepare('SELECT * FROM widget_push_tokens WHERE push_token = ?')
      .all('shared-token') as Record<string, unknown>[]

    expect(rows).toHaveLength(1)
    expect(rows[0].widget_kind).toBe('OpenTaskReminders')
  })

  test('multiple distinct tokens per user (e.g. iPhone + Mac)', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, environment)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'iphone-widget-token', 'io.mcnitt.opentask', 'ios', 'production')
    db.prepare(
      `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, environment)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'mac-widget-token', 'io.mcnitt.opentask.mac', 'macos', 'production')

    const rows = db.prepare('SELECT * FROM widget_push_tokens WHERE user_id = ?').all(TEST_USER_ID)
    expect(rows).toHaveLength(2)
  })

  test('delete widget push token (unregister)', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_USER_ID, 'to-remove', 'io.mcnitt.opentask', 'ios')

    db.prepare('DELETE FROM widget_push_tokens WHERE push_token = ?').run('to-remove')

    const rows = db.prepare('SELECT * FROM widget_push_tokens WHERE user_id = ?').all(TEST_USER_ID)
    expect(rows).toHaveLength(0)
  })

  test('index on user_id exists', () => {
    const db = getDb()
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='widget_push_tokens'",
      )
      .all() as { name: string }[]

    expect(indexes.map((i) => i.name)).toContain('idx_widget_push_tokens_user_id')
  })
})

describe('isDemoUser', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  test('false for a regular user', () => {
    expect(isDemoUser(TEST_USER_ID)).toBe(false)
  })

  test('true once is_demo is set', () => {
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    expect(isDemoUser(TEST_USER_ID)).toBe(true)
  })

  test('false for a user id that does not exist', () => {
    expect(isDemoUser(999999)).toBe(false)
  })
})

describe('createTrailingDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('a single schedule() flushes once after the delay', () => {
    const flush = vi.fn()
    const debouncer = createTrailingDebouncer(flush, 2000)

    debouncer.schedule(1)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(1)
  })

  test('a burst of schedule() calls for the same key coalesces to one flush', () => {
    const flush = vi.fn()
    const debouncer = createTrailingDebouncer(flush, 2000)

    // Five calls in quick succession — e.g. a bulk action mutating five tasks,
    // each firing emitSyncEvent separately.
    for (let i = 0; i < 5; i++) {
      debouncer.schedule(42)
      vi.advanceTimersByTime(500) // well under the 2000ms window
    }

    expect(flush).not.toHaveBeenCalled()

    // Only the last call's timer is still pending — it needs its own full window.
    vi.advanceTimersByTime(2000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(42)
  })

  test('re-scheduling resets the timer — flush fires from the LAST call, not the first', () => {
    const flush = vi.fn()
    const debouncer = createTrailingDebouncer(flush, 2000)

    debouncer.schedule(1)
    vi.advanceTimersByTime(1500) // 500ms short of the first call's window
    debouncer.schedule(1) // resets the clock

    vi.advanceTimersByTime(1500)
    expect(flush).not.toHaveBeenCalled() // only 1500ms since the reset

    vi.advanceTimersByTime(500)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('different keys debounce independently', () => {
    const flush = vi.fn()
    const debouncer = createTrailingDebouncer(flush, 2000)

    debouncer.schedule(1)
    vi.advanceTimersByTime(1000)
    debouncer.schedule(2)

    vi.advanceTimersByTime(1000) // key 1 now at 2000ms, key 2 at 1000ms
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(1)

    vi.advanceTimersByTime(1000) // key 2 now at 2000ms
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledWith(2)
  })

  test('pendingCount reflects in-flight timers and clears after flush', () => {
    const flush = vi.fn()
    const debouncer = createTrailingDebouncer(flush, 2000)

    debouncer.schedule(1)
    debouncer.schedule(2)
    expect(debouncer.pendingCount()).toBe(2)

    vi.advanceTimersByTime(2000)
    expect(debouncer.pendingCount()).toBe(0)
  })
})
