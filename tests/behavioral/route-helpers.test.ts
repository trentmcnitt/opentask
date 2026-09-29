/**
 * Small server helpers (cleanup A18): strict route-id parsing, AuthError as an
 * AppError, notification copy, and the shared retention purge.
 */
import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'
import { getDb } from '@/core/db'
import { parseRouteId, handleError } from '@/lib/api-response'
// From core/errors, not core/auth: core/auth pulls in next-auth, which vitest can't load.
import { AppError, AuthError } from '@/core/errors'
import { notificationTitlePrefix, interruptionLevelFor } from '@/core/notifications/format'
import { purgeOldUndoLogs } from '@/core/undo/purge'

describe('parseRouteId', () => {
  test('accepts digits only', () => {
    expect(parseRouteId('12')).toBe(12)
    expect(parseRouteId('0')).toBe(0)
  })

  test('rejects anything that is not all digits', () => {
    for (const raw of ['', 'abc', '12abc', '1.5', '-3', ' 7', '1e3']) {
      expect(parseRouteId(raw)).toBeNull()
    }
  })
})

describe('AuthError', () => {
  test('is an AppError that handleError turns into a 401 UNAUTHORIZED', async () => {
    const err = new AuthError('Authentication required')
    expect(err).toBeInstanceOf(AppError)
    const res = handleError(err)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    })
  })
})

describe('notification copy', () => {
  test.each([
    [0, '', 'active'],
    [2, '', 'active'],
    [3, 'HIGH: ', 'time-sensitive'],
    [4, 'URGENT: ', 'critical'],
  ] as const)('P%i → prefix %j, level %s', (priority, prefix, level) => {
    expect(notificationTitlePrefix(priority)).toBe(prefix)
    expect(interruptionLevelFor(priority)).toBe(level)
  })
})

describe('retention purge', () => {
  beforeAll(() => {
    setupTestDb()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function insertUndoEntry(daysAgo: number) {
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
    getDb()
      .prepare(
        `INSERT INTO undo_log (user_id, action, description, fields_changed, snapshot, created_at)
         VALUES (?, 'edit', 'purge test', '[]', '[]', ?)`,
      )
      .run(TEST_USER_ID, createdAt)
  }

  const purgeTestRows = () =>
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM undo_log WHERE description = 'purge test'`)
      .get() as {
      n: number
    }

  test('an unparseable retention env var falls back to the default instead of throwing', () => {
    getDb().prepare(`DELETE FROM undo_log WHERE description = 'purge test'`).run()
    insertUndoEntry(40) // older than the 30-day default
    insertUndoEntry(10)
    vi.stubEnv('OPENTASK_RETENTION_UNDO_DAYS', 'not-a-number')

    expect(() => purgeOldUndoLogs()).not.toThrow()
    expect(purgeTestRows().n).toBe(1)
  })

  test('a valid retention env var is honored', () => {
    getDb().prepare(`DELETE FROM undo_log WHERE description = 'purge test'`).run()
    insertUndoEntry(10)
    insertUndoEntry(2)
    vi.stubEnv('OPENTASK_RETENTION_UNDO_DAYS', '5')

    expect(purgeOldUndoLogs()).toBeGreaterThanOrEqual(1)
    expect(purgeTestRows().n).toBe(1)
  })
})
