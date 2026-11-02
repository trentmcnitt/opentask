/**
 * HEADS UP OFF (Trent, 2026-11-02: "I think we just have a switch to turn off
 * heads-up and we just leave repeating [ones] on"): a per-task switch. Off,
 * the task never shows in Upcoming — Tomorrow or Later — and nothing else
 * changes (its target, its nags, the deadlines page). On by default; a
 * reminder or a quota is always on. A PATCH and a bulk edit set it, each one
 * undo entry.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { bulkEdit, createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { getTaskSegments } from '@/core/tasks/task-segments'
import { executeUndo } from '@/core/undo'
import { upcomingState } from '@/lib/task-segments'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}

/** A one-off targeted `days` ahead, its target set 10 days ago (past the minimum wait). */
function targeted(days: number, input: Record<string, unknown> = {}): Task {
  const t = createTask({
    ...u,
    input: {
      title: 'Synthetic heads-up task',
      due_at: DateTime.fromISO('2026-11-02T09:00', { zone: tz }).plus({ days }).toUTC().toISO()!,
      ...input,
    },
  })
  getDb()
    .prepare('UPDATE tasks SET target_set_at = ?, created_at = ? WHERE id = ?')
    .run(at('2026-10-20T09:00'), at('2026-10-20T09:00'), t.id)
  return getTaskById(t.id)!
}

function upcomingIds(): number[] {
  const segs = getTaskSegments(TEST_USER_ID, tz, new Date())
  return (segs.find((s) => s.horizon === 'upcoming')?.tasks ?? []).map((r) => r.task.id)
}

beforeEach(() => {
  vi.setSystemTime(new Date(at('2026-11-02T10:00'))) // Monday
  setupTestDb()
})
afterEach(() => vi.useRealTimers())
afterAll(() => teardownTestDb())

describe('UP-HU: heads-up off keeps a task out of Upcoming', () => {
  test('UP-HU01: on by default; off, neither Tomorrow nor Later lists it', () => {
    const tomorrow = targeted(1)
    const later = targeted(4, { lead_days: 5 })
    expect(tomorrow.heads_up).toBe(true)
    const now = new Date()
    expect(upcomingState(tomorrow, tz, now, CALENDAR_DAY_START)?.section).toBe('tomorrow')
    expect(upcomingState(later, tz, now, CALENDAR_DAY_START)?.section).toBe('later')
    expect(upcomingIds()).toEqual(expect.arrayContaining([tomorrow.id, later.id]))

    updateTask({ ...u, taskId: tomorrow.id, input: { heads_up: false } })
    updateTask({ ...u, taskId: later.id, input: { heads_up: false } })
    expect(getTaskById(tomorrow.id)!.heads_up).toBe(false)
    expect(upcomingState(getTaskById(tomorrow.id)!, tz, now, CALENDAR_DAY_START)).toBeNull()
    expect(upcomingState(getTaskById(later.id)!, tz, now, CALENDAR_DAY_START)).toBeNull()
    expect(upcomingIds()).not.toContain(tomorrow.id)
    expect(upcomingIds()).not.toContain(later.id)
  })

  test('UP-HU02: membership only — the target stays, and it nags on its day', () => {
    const t = targeted(1)
    updateTask({ ...u, taskId: t.id, input: { heads_up: false } })
    const after = getTaskById(t.id)!
    expect(after.due_at).toBe(t.due_at)
    expect(after.lead_days).toBe(t.lead_days)
  })

  test('UP-HU03: a repeat holds it for every occurrence (the row is the series)', () => {
    const t = createTask({
      ...u,
      input: {
        title: 'Synthetic weekday check',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
        heads_up: false,
      },
    })
    expect(getTaskById(t.id)!.heads_up).toBe(false)
    expect(upcomingState(getTaskById(t.id)!, tz, new Date(), CALENDAR_DAY_START)).toBeNull()
  })

  test('UP-HU04: undo puts it back; one entry', () => {
    const t = targeted(1)
    const r = updateTask({ ...u, taskId: t.id, input: { heads_up: false } })
    expect(r.fieldsChanged).toEqual(['heads_up'])
    expect(r.description).toContain('Heads-up off')
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)!.heads_up).toBe(true)
    expect(upcomingIds()).toContain(t.id)
  })

  test('UP-HU05: bulk edit turns several off in one undo entry', () => {
    const a = targeted(1)
    const b = targeted(1)
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }
    bulkEdit({ ...u, taskIds: [a.id, b.id], changes: { heads_up: false } })
    const afterCount = getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }
    expect(afterCount.n - before.n).toBe(1)
    expect(getTaskById(a.id)!.heads_up).toBe(false)
    expect(getTaskById(b.id)!.heads_up).toBe(false)
    executeUndo(TEST_USER_ID)
    expect(getTaskById(a.id)!.heads_up).toBe(true)
    expect(getTaskById(b.id)!.heads_up).toBe(true)
  })

  test('UP-HU06: a reminder or a quota is always on', () => {
    const quota = createTask({
      ...u,
      input: {
        title: 'Synthetic quota',
        is_tracked: true,
        progress_target: 3,
        rrule: 'FREQ=WEEKLY',
        heads_up: false,
      },
    })
    expect(getTaskById(quota.id)!.heads_up).toBe(true)
    const reminder = createTask({
      ...u,
      input: {
        title: 'Synthetic thought',
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })
    updateTask({ ...u, taskId: reminder.id, input: { heads_up: false } })
    expect(getTaskById(reminder.id)!.heads_up).toBe(true)
  })
})
