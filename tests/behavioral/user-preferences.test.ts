/**
 * Behavioral tests for user preference fields: wake_time, sleep_time, per-feature AI modes
 *
 * Tests getUserFeatureModes() helper and database default values for preference columns.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'
import { getUserFeatureModes } from '@/core/ai/user-context'
import { getDb } from '@/core/db'

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

describe('getUserFeatureModes', () => {
  test('returns api for all features by default', () => {
    const modes = getUserFeatureModes(TEST_USER_ID)
    expect(modes.enrichment).toBe('api')
    expect(modes.quick_take).toBe('api')
    expect(modes.whats_next).toBe('api')
    expect(modes.insights).toBe('api')
  })

  test('returns stored modes when set', () => {
    const db = getDb()
    db.prepare(
      "UPDATE users SET ai_enrichment_mode = 'sdk', ai_quicktake_mode = 'off' WHERE id = ?",
    ).run(TEST_USER_ID)

    const modes = getUserFeatureModes(TEST_USER_ID)
    expect(modes.enrichment).toBe('sdk')
    expect(modes.quick_take).toBe('off')
    expect(modes.whats_next).toBe('api')
    expect(modes.insights).toBe('api')

    // Clean up
    db.prepare(
      "UPDATE users SET ai_enrichment_mode = 'api', ai_quicktake_mode = 'api' WHERE id = ?",
    ).run(TEST_USER_ID)
  })

  test('returns api for non-existent user', () => {
    const modes = getUserFeatureModes(99999)
    expect(modes.enrichment).toBe('api')
    expect(modes.quick_take).toBe('api')
    expect(modes.whats_next).toBe('api')
    expect(modes.insights).toBe('api')
  })
})

describe('database defaults for preference columns', () => {
  test('new user gets wake_time = 07:00', () => {
    const db = getDb()
    const row = db.prepare('SELECT wake_time FROM users WHERE id = ?').get(TEST_USER_ID) as {
      wake_time: string
    }
    expect(row.wake_time).toBe('07:00')
  })

  test('new user gets sleep_time = 22:00', () => {
    const db = getDb()
    const row = db.prepare('SELECT sleep_time FROM users WHERE id = ?').get(TEST_USER_ID) as {
      sleep_time: string
    }
    expect(row.sleep_time).toBe('22:00')
  })

  test('new user gets per-feature modes = api', () => {
    const db = getDb()
    const row = db
      .prepare(
        'SELECT ai_enrichment_mode, ai_quicktake_mode, ai_whats_next_mode, ai_insights_mode FROM users WHERE id = ?',
      )
      .get(TEST_USER_ID) as {
      ai_enrichment_mode: string
      ai_quicktake_mode: string
      ai_whats_next_mode: string
      ai_insights_mode: string
    }
    expect(row.ai_enrichment_mode).toBe('api')
    expect(row.ai_quicktake_mode).toBe('api')
    expect(row.ai_whats_next_mode).toBe('api')
    expect(row.ai_insights_mode).toBe('api')
  })

  test('wake_time and sleep_time are stored as HH:MM strings', () => {
    const db = getDb()
    db.prepare('UPDATE users SET wake_time = ?, sleep_time = ? WHERE id = ?').run(
      '05:30',
      '23:45',
      TEST_USER_ID,
    )

    const row = db
      .prepare('SELECT wake_time, sleep_time FROM users WHERE id = ?')
      .get(TEST_USER_ID) as { wake_time: string; sleep_time: string }
    expect(row.wake_time).toBe('05:30')
    expect(row.sleep_time).toBe('23:45')

    // Clean up
    db.prepare('UPDATE users SET wake_time = ?, sleep_time = ? WHERE id = ?').run(
      '07:00',
      '22:00',
      TEST_USER_ID,
    )
  })
})
