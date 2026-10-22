/**
 * `users.ai_process_mode` (2026-10-22): Process's own AI mode. A database from
 * before it gets the column from `runMigrations()`, filled once from each
 * user's `ai_insights_mode` (what Process read until then), so nobody's
 * Process behaviour changes. It runs once: afterwards the two modes are
 * independent, and a restart never copies Insights over again.
 *
 * The "old database" is the test DB with the column dropped; closing and
 * reopening it runs the schema and migrations again, as a server start does.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, seedTestUser, TEST_USER_ID } from '../helpers/setup'
import { getDb, closeDb } from '@/core/db'
import { getUserFeatureModes } from '@/core/ai/user-context'

const SDK_USER = 2
const OFF_USER = 3

function processModes(): Record<number, string> {
  const rows = getDb().prepare('SELECT id, ai_process_mode FROM users ORDER BY id').all() as {
    id: number
    ai_process_mode: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.ai_process_mode]))
}

function hasProcessColumn(): boolean {
  const cols = getDb().prepare('PRAGMA table_info(users)').all() as { name: string }[]
  return cols.some((c) => c.name === 'ai_process_mode')
}

/** Close and reopen the DB: schema + `runMigrations()` run again, as on a server start. */
function restart() {
  closeDb()
  getDb()
}

beforeAll(() => {
  setupTestDb()
  seedTestUser(SDK_USER, 'sdk@example.com')
  seedTestUser(OFF_USER, 'off@example.com')
})

afterAll(() => teardownTestDb())

describe('ai_process_mode migration', () => {
  test('a fresh database has the column, defaulting to api', () => {
    expect(hasProcessColumn()).toBe(true)
    expect(processModes()).toEqual({ [TEST_USER_ID]: 'api', [SDK_USER]: 'api', [OFF_USER]: 'api' })
  })

  test('an old database gets it as a copy of each user’s Insights mode', () => {
    const db = getDb()
    db.prepare('UPDATE users SET ai_insights_mode = ? WHERE id = ?').run('api', TEST_USER_ID)
    db.prepare('UPDATE users SET ai_insights_mode = ? WHERE id = ?').run('sdk', SDK_USER)
    db.prepare('UPDATE users SET ai_insights_mode = ? WHERE id = ?').run('off', OFF_USER)
    db.exec('ALTER TABLE users DROP COLUMN ai_process_mode')
    expect(hasProcessColumn()).toBe(false)

    restart()

    expect(hasProcessColumn()).toBe(true)
    expect(processModes()).toEqual({ [TEST_USER_ID]: 'api', [SDK_USER]: 'sdk', [OFF_USER]: 'off' })
    expect(getUserFeatureModes(OFF_USER)).toMatchObject({ insights: 'off', process: 'off' })
  })

  test('it runs once: a later restart never copies Insights over again', () => {
    const db = getDb()
    db.prepare("UPDATE users SET ai_process_mode = 'api' WHERE id = ?").run(OFF_USER)
    db.prepare("UPDATE users SET ai_insights_mode = 'off' WHERE id = ?").run(TEST_USER_ID)

    restart()

    expect(processModes()).toEqual({ [TEST_USER_ID]: 'api', [SDK_USER]: 'sdk', [OFF_USER]: 'api' })
    expect(getUserFeatureModes(TEST_USER_ID)).toMatchObject({ insights: 'off', process: 'api' })
  })
})
