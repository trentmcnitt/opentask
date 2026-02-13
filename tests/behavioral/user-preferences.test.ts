/**
 * Behavioral tests for user preference fields: wake_time, sleep_time, ai_bubble_model
 *
 * Tests getUserBubbleModel() helper and database default values for new preference columns.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'
import { getUserBubbleModel } from '@/core/ai/user-context'
import { getDb } from '@/core/db'

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

describe('getUserBubbleModel', () => {
  test('returns haiku when user has no preference set (default)', () => {
    const result = getUserBubbleModel(TEST_USER_ID)
    expect(result).toBe('haiku')
  })

  test('returns the stored value when set to claude-opus-4-6', () => {
    const db = getDb()
    db.prepare('UPDATE users SET ai_bubble_model = ? WHERE id = ?').run(
      'claude-opus-4-6',
      TEST_USER_ID,
    )

    const result = getUserBubbleModel(TEST_USER_ID)
    expect(result).toBe('claude-opus-4-6')

    // Clean up
    db.prepare('UPDATE users SET ai_bubble_model = ? WHERE id = ?').run('haiku', TEST_USER_ID)
  })

  test('returns haiku for non-existent user', () => {
    const result = getUserBubbleModel(99999)
    expect(result).toBe('haiku')
  })

  test('returns haiku after resetting to default', () => {
    const db = getDb()
    db.prepare('UPDATE users SET ai_bubble_model = ? WHERE id = ?').run(
      'claude-opus-4-6',
      TEST_USER_ID,
    )
    expect(getUserBubbleModel(TEST_USER_ID)).toBe('claude-opus-4-6')

    db.prepare('UPDATE users SET ai_bubble_model = ? WHERE id = ?').run('haiku', TEST_USER_ID)
    expect(getUserBubbleModel(TEST_USER_ID)).toBe('haiku')
  })
})

describe('database defaults for new preference columns', () => {
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

  test('new user gets ai_bubble_model = haiku', () => {
    const db = getDb()
    const row = db.prepare('SELECT ai_bubble_model FROM users WHERE id = ?').get(TEST_USER_ID) as {
      ai_bubble_model: string
    }
    expect(row.ai_bubble_model).toBe('haiku')
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
