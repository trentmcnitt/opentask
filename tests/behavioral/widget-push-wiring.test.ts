/**
 * Widget push wiring: sync event → widget push token → send.
 *
 * widget-push.test.ts covers the pieces (targets, the coalescer). This file
 * runs them joined together through `initWidgetPushSync`, with a fake sender
 * injected in place of APNs (`options.send`), so what's asserted is which
 * token ids actually get a push, and when:
 * - one sync event → every one of the user's tokens is sent to after the settle
 * - a `{ widgets: false }` event and the demo user send nothing
 * - a failed send does not use up the token's minimum interval
 * - a quota prompt consider / did emits an event the widgets see
 *
 * Clock: 2026-01-15 16:00 UTC = 10:00 in the test user's America/Chicago,
 * inside the default 07:00–22:00 waking hours, so quiet hours never hold a
 * push here.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { initWidgetPushSync, WIDGET_PUSH_SETTLE_MS } from '@/core/notifications/widget-push'
import { createTask } from '@/core/tasks'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { promptKey } from '@/lib/quota-prompts'
import { emitSyncEvent } from '@/lib/sync-events'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

const INTERVAL = 300_000
const NOW = new Date('2026-01-15T16:00:00Z')
const TODAY = '2026-01-15'

function insertToken(token: string, platform: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, environment)
         VALUES (?, ?, 'io.mcnitt.opentask', ?, 'production')`,
      )
      .run(TEST_USER_ID, token, platform).lastInsertRowid,
  )
}

describe('initWidgetPushSync wiring', () => {
  let sent: { tokenId: number; at: number }[]
  let results: boolean[]
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    setupTestDb()
    delete process.env.OPENTASK_QUOTA_PROMPTS
    sent = []
    results = []
    stop = initWidgetPushSync({
      minIntervalMs: INTERVAL,
      quietHours: true,
      send: async (tokenId) => {
        sent.push({ tokenId, at: Date.now() })
        return results.shift() ?? true
      },
    })
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
    teardownTestDb()
  })

  test('a sync event sends to each of the user’s tokens after the settle', async () => {
    const phone = insertToken('phone', 'ios')
    const mac = insertToken('mac', 'macos')

    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.map((s) => s.tokenId).sort()).toEqual([phone, mac].sort())
    expect(sent.every((s) => s.at === NOW.getTime() + WIDGET_PUSH_SETTLE_MS)).toBe(true)
  })

  test('each token is paced on its own: the budgeted phone waits, the Mac does not', async () => {
    const phone = insertToken('phone', 'ios')
    const mac = insertToken('mac', 'macos')

    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
    sent = []

    await vi.advanceTimersByTimeAsync(10_000)
    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
    expect(sent.map((s) => s.tokenId)).toEqual([mac])

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(sent.map((s) => s.tokenId)).toEqual([mac, phone])
  })

  test('a { widgets: false } event sends nothing', async () => {
    insertToken('phone', 'ios')
    emitSyncEvent(TEST_USER_ID, { widgets: false })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(sent).toEqual([])
  })

  test('the demo user is never sent to', async () => {
    insertToken('phone', 'ios')
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(sent).toEqual([])
  })

  test('a failed send leaves the window open: the next change retries after the settle', async () => {
    const phone = insertToken('phone', 'ios')
    results = [false]

    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS) // fails
    await vi.advanceTimersByTimeAsync(10_000)
    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)

    expect(sent).toEqual([
      { tokenId: phone, at: NOW.getTime() + WIDGET_PUSH_SETTLE_MS },
      { tokenId: phone, at: NOW.getTime() + 2 * WIDGET_PUSH_SETTLE_MS + 10_000 },
    ])
  })

  test('a failed send is not retried on its own — only the next change sends again', async () => {
    insertToken('phone', 'ios')
    results = [false]

    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS + 2 * INTERVAL)
    expect(sent).toHaveLength(1)
  })

  test('a sender that throws is logged and treated as a failed send, not an edit failure', async () => {
    stop()
    const attempts: number[] = []
    stop = initWidgetPushSync({
      minIntervalMs: INTERVAL,
      send: async (tokenId) => {
        attempts.push(tokenId)
        if (attempts.length === 1) throw new Error('APNs unreachable')
        return true
      },
    })
    const phone = insertToken('phone', 'ios')

    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
    emitSyncEvent(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
    expect(attempts).toEqual([phone, phone])
  })

  describe('quota prompts', () => {
    function weeklyQuota() {
      return createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Cook vegetables',
          rrule: 'FREQ=WEEKLY',
          progress_target: 5,
          is_tracked: true,
        },
      })
    }

    /** Create the quota, then let its own creation push go out and the window pass. */
    async function quotaWithQuietWidget() {
      const phone = insertToken('phone', 'ios')
      const q = weeklyQuota()
      await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS + INTERVAL)
      sent = []
      return { phone, q }
    }

    test('considering a prompt pushes to the widget', async () => {
      const { phone, q } = await quotaWithQuietWidget()
      actOnPrompts({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        actions: [{ key: promptKey(q.id, 0, TODAY), did: false }],
      })
      await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
      expect(sent.map((s) => s.tokenId)).toEqual([phone])
    })

    test('"did it" on a prompt pushes to the widget', async () => {
      const { phone, q } = await quotaWithQuietWidget()
      actOnPrompts({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        actions: [{ key: promptKey(q.id, 0, TODAY), did: true }],
      })
      await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
      expect(sent.map((s) => s.tokenId)).toEqual([phone])
    })
  })
})
