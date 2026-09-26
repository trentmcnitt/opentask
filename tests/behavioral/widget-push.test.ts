/**
 * WidgetKit Push Sync Behavioral Tests
 *
 * Covers the two things that don't need real APNs credentials or a device:
 * - the widget_push_tokens table (CRUD, uniqueness, index)
 * - the per-token coalescing policy in widget-push.ts (settle, minimum
 *   interval with a guaranteed trailing push, quiet hours), with fake timers
 * - which sync events reach which tokens (demo user, `{ widgets: false }`)
 * - which task edits count as widget-visible
 *
 * Does NOT test actual APNs delivery (requires real Apple credentials) —
 * same boundary as tests/behavioral/apns-notifications.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import {
  createWidgetPushCoalescer,
  isBudgetedPlatform,
  parseMinIntervalSeconds,
  parseQuietHoursEnabled,
  quietHoursEnd,
  widgetPushTargets,
} from '@/core/notifications/widget-push'
import { createTask, updateTask } from '@/core/tasks'
import { isWidgetVisibleEdit } from '@/core/tasks/update'
import { reprocessTask } from '@/core/tasks/reprocess'
import { onSyncEvent, offSyncEvent, type SyncEventInfo } from '@/lib/sync-events'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

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

function insertToken(userId: number, token: string, platform: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, environment)
         VALUES (?, ?, ?, ?, 'production')`,
      )
      .run(userId, token, 'io.mcnitt.opentask', platform).lastInsertRowid,
  )
}

describe('widgetPushTargets', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  test("returns every one of the user's tokens with its platform", () => {
    const phone = insertToken(TEST_USER_ID, 'phone', 'ios')
    const mac = insertToken(TEST_USER_ID, 'mac', 'macos')

    const targets = widgetPushTargets(TEST_USER_ID)
    expect(targets.map((t) => [t.id, t.platform]).sort()).toEqual(
      [
        [phone, 'ios'],
        [mac, 'macos'],
      ].sort(),
    )
    expect(targets.every((t) => t.user_id === TEST_USER_ID)).toBe(true)
  })

  test('a { widgets: false } event (a change no widget shows) targets nothing', () => {
    insertToken(TEST_USER_ID, 'phone', 'ios')
    expect(widgetPushTargets(TEST_USER_ID, { widgets: false })).toEqual([])
    expect(widgetPushTargets(TEST_USER_ID, { widgets: true })).toHaveLength(1)
  })

  test('the demo user is never pushed to', () => {
    insertToken(TEST_USER_ID, 'phone', 'ios')
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    expect(widgetPushTargets(TEST_USER_ID)).toEqual([])
  })

  test('a user with no tokens targets nothing', () => {
    expect(widgetPushTargets(TEST_USER_ID)).toEqual([])
  })
})

describe('createWidgetPushCoalescer', () => {
  const SETTLE = 2000
  const INTERVAL = 300_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeCoalescer(options: { interval?: (key: number) => number } = {}) {
    const flushes: { key: number; at: number }[] = []
    const coalescer = createWidgetPushCoalescer<number>({
      settleMs: SETTLE,
      minIntervalMs: options.interval ?? (() => INTERVAL),
      flush: (key) => {
        flushes.push({ key, at: Date.now() })
      },
    })
    return { coalescer, flushes }
  }

  test('the first change after a quiet spell goes out after the settle, not the window', () => {
    const { coalescer, flushes } = makeCoalescer()
    const start = Date.now()

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE - 1)
    expect(flushes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(flushes).toEqual([{ key: 1, at: start + SETTLE }])
  })

  test("a bulk action's burst of events inside the settle is one push", () => {
    const { coalescer, flushes } = makeCoalescer()
    for (let i = 0; i < 5; i++) coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    expect(flushes).toHaveLength(1)
  })

  test('a burst of edits is one leading push plus ONE trailing push at the window end', () => {
    // The 2026-09-25 11:22 shape: web edits ~6s apart for about a minute,
    // which the old 2s debounce turned into eleven pushes.
    const { coalescer, flushes } = makeCoalescer()
    const start = Date.now()

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    expect(flushes).toHaveLength(1) // leading push

    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(6000)
      coalescer.schedule(1)
    }
    vi.advanceTimersByTime(INTERVAL - 66_000 - 1)
    expect(flushes).toHaveLength(1) // nothing more inside the window

    vi.advanceTimersByTime(1)
    expect(flushes).toHaveLength(2)
    expect(flushes[1].at).toBe(start + SETTLE + INTERVAL) // the guaranteed trailing push

    vi.advanceTimersByTime(INTERVAL * 3)
    expect(flushes).toHaveLength(2) // and nothing after it without new changes
  })

  test('a change a full window after the last push goes out promptly again', () => {
    const { coalescer, flushes } = makeCoalescer()

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    vi.advanceTimersByTime(INTERVAL + 60_000) // quiet for longer than the window

    const changedAt = Date.now()
    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    expect(flushes).toHaveLength(2)
    expect(flushes[1].at).toBe(changedAt + SETTLE)
  })

  test('a change late in the window waits only for the rest of the window', () => {
    const { coalescer, flushes } = makeCoalescer()
    const start = Date.now()

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    vi.advanceTimersByTime(INTERVAL - 30_000)
    coalescer.schedule(1)
    vi.advanceTimersByTime(30_000)
    expect(flushes.map((f) => f.at)).toEqual([start + SETTLE, start + SETTLE + INTERVAL])
  })

  test('tokens are paced independently', () => {
    const { coalescer, flushes } = makeCoalescer()
    const start = Date.now()

    coalescer.schedule(1) // token 1 pushes at +2s, then its window runs
    vi.advanceTimersByTime(60_000)
    coalescer.schedule(2) // token 2 has never pushed: prompt
    coalescer.schedule(1) // token 1 is inside its window: trailing
    vi.advanceTimersByTime(SETTLE)

    expect(flushes).toEqual([
      { key: 1, at: start + SETTLE },
      { key: 2, at: start + 60_000 + SETTLE },
    ])

    vi.advanceTimersByTime(INTERVAL)
    expect(flushes[2]).toEqual({ key: 1, at: start + SETTLE + INTERVAL })
    expect(flushes).toHaveLength(3)
  })

  test('a key with a zero interval (macOS: free pushes) only settles', () => {
    const { coalescer, flushes } = makeCoalescer({ interval: (key) => (key === 9 ? 0 : INTERVAL) })

    coalescer.schedule(9)
    vi.advanceTimersByTime(SETTLE)
    coalescer.schedule(9)
    vi.advanceTimersByTime(SETTLE)
    expect(flushes).toHaveLength(2)
  })

  test('quiet hours hold the push until wake, and overnight changes ride that one push', () => {
    const wakeAt = new Date('2026-09-26T12:00:00Z').getTime() // 07:00 Chicago
    const flushes: number[] = []
    const coalescer = createWidgetPushCoalescer<number>({
      settleMs: SETTLE,
      minIntervalMs: () => INTERVAL,
      deferUntil: (_key, now) => (now < wakeAt ? wakeAt : null),
      flush: () => {
        flushes.push(Date.now())
      },
    })
    vi.setSystemTime(new Date('2026-09-26T04:00:00Z')) // 23:00 Chicago

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE)
    expect(flushes).toHaveLength(0)
    expect(coalescer.pendingCount()).toBe(1)

    vi.advanceTimersByTime(3 * 3600_000) // more changes at 02:00
    coalescer.schedule(1)
    coalescer.schedule(1)

    vi.advanceTimersByTime(wakeAt - Date.now())
    expect(flushes).toEqual([wakeAt])
    expect(coalescer.pendingCount()).toBe(0)
  })
})

describe('createWidgetPushCoalescer — failed sends', () => {
  const SETTLE = 2000
  const INTERVAL = 300_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A flush whose send fails (resolves false) must not use up the window:
   * the next change goes out after the settle, not 5 minutes later.
   */
  function makeFailingCoalescer(results: boolean[]) {
    const flushes: number[] = []
    const coalescer = createWidgetPushCoalescer<number>({
      settleMs: SETTLE,
      minIntervalMs: () => INTERVAL,
      flush: () => {
        flushes.push(Date.now())
        return Promise.resolve(results.shift() ?? true)
      },
    })
    return { coalescer, flushes }
  }

  test('a failed send does not consume the window: the next change goes out after the settle', async () => {
    const { coalescer, flushes } = makeFailingCoalescer([false])
    const start = Date.now()

    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE) // push #1 fails

    vi.advanceTimersByTime(10_000)
    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE)
    expect(flushes).toEqual([start + SETTLE, start + SETTLE + 10_000 + SETTLE])
  })

  test('a successful send, by contrast, holds the next change to the window end', async () => {
    const { coalescer, flushes } = makeFailingCoalescer([true])
    const start = Date.now()

    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE)
    vi.advanceTimersByTime(10_000)
    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE)
    expect(flushes).toEqual([start + SETTLE])
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(flushes).toEqual([start + SETTLE, start + SETTLE + INTERVAL])
  })

  test('a change made while a failing send is in flight is moved up to the settle', async () => {
    let resolveSend: (ok: boolean) => void = () => {}
    const flushes: number[] = []
    const coalescer = createWidgetPushCoalescer<number>({
      settleMs: SETTLE,
      minIntervalMs: () => INTERVAL,
      flush: () => {
        flushes.push(Date.now())
        return new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
      },
    })
    const start = Date.now()

    coalescer.schedule(1)
    vi.advanceTimersByTime(SETTLE) // send #1 starts, still in flight
    coalescer.schedule(1) // queued for the window end (start + SETTLE + INTERVAL)
    expect(coalescer.pendingCount()).toBe(1)

    resolveSend(false)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(SETTLE)
    // Re-timed from "now + settle" instead of waiting the whole window.
    expect(flushes).toEqual([start + SETTLE, start + 2 * SETTLE])
    expect(coalescer.pendingCount()).toBe(0)
  })

  test('a rejected send is treated as a failure too', async () => {
    const flushes: number[] = []
    const coalescer = createWidgetPushCoalescer<number>({
      settleMs: SETTLE,
      minIntervalMs: () => INTERVAL,
      flush: () => {
        flushes.push(Date.now())
        return flushes.length === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(true)
      },
    })
    const start = Date.now()

    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE)
    coalescer.schedule(1)
    await vi.advanceTimersByTimeAsync(SETTLE)
    expect(flushes).toEqual([start + SETTLE, start + 2 * SETTLE])
  })
})

describe('quietHoursEnd', () => {
  const at = (iso: string) => new Date(iso)
  const tz = 'America/Chicago'

  test('awake (10:00 local) → no quiet hours', () => {
    expect(quietHoursEnd(at('2026-09-25T15:00:00Z'), tz, '07:00', '22:00')).toBeNull()
  })

  test('23:00 local → held until 07:00 the next local morning', () => {
    expect(quietHoursEnd(at('2026-09-26T04:00:00Z'), tz, '07:00', '22:00')).toBe(
      at('2026-09-26T12:00:00Z').getTime(),
    )
  })

  test('03:00 local → held until 07:00 the same local morning', () => {
    expect(quietHoursEnd(at('2026-09-26T08:00:00Z'), tz, '07:00', '22:00')).toBe(
      at('2026-09-26T12:00:00Z').getTime(),
    )
  })

  test('sleep_time is the first quiet minute, wake_time the first awake one', () => {
    expect(quietHoursEnd(at('2026-09-26T02:59:00Z'), tz, '07:00', '22:00')).toBeNull() // 21:59
    expect(quietHoursEnd(at('2026-09-26T03:00:00Z'), tz, '07:00', '22:00')).not.toBeNull() // 22:00
    expect(quietHoursEnd(at('2026-09-26T12:00:00Z'), tz, '07:00', '22:00')).toBeNull() // 07:00
  })

  test('a sleep_time past midnight (wake 09:00, sleep 01:00) wraps', () => {
    expect(quietHoursEnd(at('2026-09-26T05:30:00Z'), tz, '09:00', '01:00')).toBeNull() // 00:30
    expect(quietHoursEnd(at('2026-09-26T07:00:00Z'), tz, '09:00', '01:00')).toBe(
      at('2026-09-26T14:00:00Z').getTime(), // 02:00 → 09:00
    )
  })

  test('on a spring-forward night the hold still ends at 07:00 local, not 08:00', () => {
    // 2027-03-14: Chicago jumps 02:00 CST → 03:00 CDT. 01:00 CST = 07:00Z; 07:00 CDT = 12:00Z.
    expect(quietHoursEnd(at('2027-03-14T07:00:00Z'), tz, '07:00', '22:00')).toBe(
      at('2027-03-14T12:00:00Z').getTime(),
    )
  })

  test('wake == sleep means no quiet hours', () => {
    expect(quietHoursEnd(at('2026-09-26T08:00:00Z'), tz, '07:00', '07:00')).toBeNull()
  })

  test('a malformed time or timezone fails open (no quiet hours)', () => {
    expect(quietHoursEnd(at('2026-09-26T08:00:00Z'), tz, 'nope', '22:00')).toBeNull()
    expect(quietHoursEnd(at('2026-09-26T08:00:00Z'), 'Not/AZone', '07:00', '22:00')).toBeNull()
  })
})

describe('isWidgetVisibleEdit', () => {
  test('a notes-only edit is invisible to widgets', () => {
    expect(isWidgetVisibleEdit(['notes'], [], [])).toBe(false)
  })

  test('title, due date, priority etc. are visible', () => {
    expect(isWidgetVisibleEdit(['title'], [], [])).toBe(true)
    expect(isWidgetVisibleEdit(['notes', 'due_at'], [], [])).toBe(true)
    expect(isWidgetVisibleEdit(['priority'], [], [])).toBe(true)
  })

  test('a labels change that only touches ai-* labels is invisible', () => {
    expect(isWidgetVisibleEdit(['labels'], ['health', 'ai-to-process'], ['health'])).toBe(false)
  })

  test('a labels change to a user label is visible, including a reorder', () => {
    expect(isWidgetVisibleEdit(['labels'], ['health'], ['health', 'hub'])).toBe(true)
    expect(isWidgetVisibleEdit(['labels'], ['health', 'hub'], ['hub', 'health'])).toBe(true)
  })
})

describe('env parsing and platform policy', () => {
  test('min interval: unset → 300s, 0 allowed, junk → default', () => {
    expect(parseMinIntervalSeconds(undefined)).toBe(300)
    expect(parseMinIntervalSeconds('')).toBe(300)
    expect(parseMinIntervalSeconds('0')).toBe(0)
    expect(parseMinIntervalSeconds('120')).toBe(120)
    expect(parseMinIntervalSeconds('-5')).toBe(300)
    expect(parseMinIntervalSeconds('abc')).toBe(300)
  })

  test('quiet hours: on unless explicitly off', () => {
    expect(parseQuietHoursEnabled(undefined)).toBe(true)
    expect(parseQuietHoursEnabled('true')).toBe(true)
    expect(parseQuietHoursEnabled('false')).toBe(false)
    expect(parseQuietHoursEnabled('0')).toBe(false)
  })

  test('iOS and watchOS are budgeted, macOS is not', () => {
    expect(isBudgetedPlatform('ios')).toBe(true)
    expect(isBudgetedPlatform('watchos')).toBe(true)
    expect(isBudgetedPlatform('macos')).toBe(false)
  })
})

describe('sync events carry widget visibility from the mutation', () => {
  const seen: SyncEventInfo[] = []
  const listener = (_userId: number, info: SyncEventInfo) => {
    seen.push(info)
  }

  beforeEach(() => {
    setupTestDb()
    seen.length = 0
    onSyncEvent(listener)
  })

  afterEach(() => {
    offSyncEvent(listener)
    teardownTestDb()
  })

  function makeTask() {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Call the plumber', priority: 1 },
    })
    seen.length = 0
    return task
  }

  test('a notes-only PATCH is marked invisible to widgets', () => {
    const task = makeTask()
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { notes: 'ask about the water heater' },
    })
    expect(seen).toEqual([{ widgets: false }])
  })

  test('a title PATCH is marked visible', () => {
    const task = makeTask()
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { title: 'Call the plumber back' },
    })
    expect(seen).toEqual([{ widgets: true }])
  })

  test('re-queuing AI enrichment (an ai-* label only) is marked invisible', () => {
    const task = makeTask()
    getDb().prepare(`UPDATE tasks SET labels = '["ai-failed"]' WHERE id = ?`).run(task.id)
    reprocessTask({ userId: TEST_USER_ID, taskId: task.id })
    expect(seen).toEqual([{ widgets: false }])
  })
})
