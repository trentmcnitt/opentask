/**
 * Bulk snooze feedback (src/core/notifications/sweep-feedback.ts): the quiet
 * push after a sweep from outside the app — a notification button, a widget,
 * a Shortcut — that left High or Urgent tasks overdue.
 *
 * Pinned here: WHEN it is sent (the pure `decideSweepFeedback`, and
 * `planSweepFeedback` reading the user's settings), WHAT it says
 * (`sweepFeedbackContent` — counts only, never titles), and the APNs wire
 * payload (`buildSweepResultNotification`: banner without sound, TASK_SUMMARY,
 * its own collapse id, the `priority` that keeps a sweep from clearing it).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { PushType, Priority } from 'apns2'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { getDb } from '@/core/db'
import {
  decideSweepFeedback,
  planSweepFeedback,
  sweepFeedbackContent,
  type SweepCounts,
  type SweepFeedbackInput,
  type SweepFeedbackUser,
} from '@/core/notifications/sweep-feedback'
import { buildSweepResultNotification } from '@/core/notifications/apns'

// 10:00 AM Chicago on Thursday 2026-01-15; the sweep moved things to 3:00 PM.
const NOW = new Date('2026-01-15T16:00:00Z')
const UNTIL_3PM = '2026-01-15T21:00:00.000Z'
const UNTIL_TOMORROW_9AM = '2026-01-16T15:00:00.000Z'

function counts(c: Partial<SweepCounts>): SweepCounts {
  return { affected: 0, highAffected: 0, high: 0, urgent: 0, ...c }
}

const USER_ON: SweepFeedbackUser = {
  is_demo: 0,
  notifications_enabled: 1,
  sweep_feedback_notifications_enabled: 1,
}

function input(
  c: Partial<SweepCounts>,
  extra: Partial<SweepFeedbackInput> = {},
): SweepFeedbackInput {
  return {
    viaBearer: true,
    notify: undefined,
    counts: counts(c),
    until: UNTIL_3PM,
    timezone: TEST_TIMEZONE,
    totalOverdueCount: (c.high ?? 0) + (c.urgent ?? 0),
    ...extra,
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the copy (counts only)', () => {
  test('nothing High or Urgent left: no notification', () => {
    expect(sweepFeedbackContent(counts({ affected: 8 }), UNTIL_3PM, TEST_TIMEZONE)).toBeNull()
    expect(sweepFeedbackContent(counts({}), UNTIL_3PM, TEST_TIMEZONE)).toBeNull()
  })

  test('High left after the first press: says when, and that a second press moves them', () => {
    expect(
      sweepFeedbackContent(counts({ affected: 8, high: 2 }), UNTIL_3PM, TEST_TIMEZONE),
    ).toEqual({
      title: 'Snoozed 8 tasks until 3:00 PM',
      body: '2 High still overdue. Snooze again to move the High ones',
      priority: 3,
    })
    expect(
      sweepFeedbackContent(counts({ affected: 1, high: 1 }), UNTIL_3PM, TEST_TIMEZONE)?.body,
    ).toBe('1 High still overdue. Snooze again to move the High one')
  })

  test('High and Urgent left: both named, the hint is about High only', () => {
    expect(
      sweepFeedbackContent(counts({ affected: 8, high: 2, urgent: 1 }), UNTIL_3PM, TEST_TIMEZONE),
    ).toEqual({
      title: 'Snoozed 8 tasks until 3:00 PM',
      body: '2 High and 1 Urgent still overdue. Snooze again to move the High ones',
      priority: 4,
    })
  })

  test('Urgent only, nothing snoozed', () => {
    expect(sweepFeedbackContent(counts({ urgent: 3 }), UNTIL_3PM, TEST_TIMEZONE)).toEqual({
      title: 'Nothing snoozed',
      body: "3 Urgent can't be bulk snoozed",
      priority: 4,
    })
  })

  test('something snoozed, Urgent left', () => {
    expect(
      sweepFeedbackContent(counts({ affected: 4, urgent: 1 }), UNTIL_3PM, TEST_TIMEZONE),
    ).toEqual({
      title: 'Snoozed 4 tasks until 3:00 PM',
      body: "1 Urgent still overdue. Urgent can't be bulk snoozed",
      priority: 4,
    })
  })

  test('second press of a double snooze: names the High it moved, and the target day', () => {
    expect(
      sweepFeedbackContent(
        counts({ affected: 2, highAffected: 2, urgent: 1 }),
        UNTIL_TOMORROW_9AM,
        TEST_TIMEZONE,
      ),
    ).toEqual({
      title: 'Snoozed 2 high-priority tasks until tomorrow 9:00 AM',
      body: "1 Urgent still overdue. Urgent can't be bulk snoozed",
      priority: 4,
    })
  })

  test('nothing moved but High left: no "snooze again" (it would do the same)', () => {
    expect(sweepFeedbackContent(counts({ high: 2, urgent: 1 }), UNTIL_3PM, TEST_TIMEZONE)).toEqual({
      title: 'Nothing snoozed',
      body: '2 High and 1 Urgent still overdue',
      priority: 4,
    })
  })

  test('one task: singular', () => {
    expect(
      sweepFeedbackContent(counts({ affected: 1, urgent: 1 }), UNTIL_3PM, TEST_TIMEZONE)?.title,
    ).toBe('Snoozed 1 task until 3:00 PM')
  })
})

describe('the decision', () => {
  test('a Bearer-token sweep that left High/Urgent: sent, with the grid count', () => {
    expect(decideSweepFeedback(input({ affected: 8, high: 2, urgent: 1 }), USER_ON)).toEqual({
      title: 'Snoozed 8 tasks until 3:00 PM',
      body: '2 High and 1 Urgent still overdue. Snooze again to move the High ones',
      priority: 4,
      totalOverdueCount: 3,
    })
  })

  test('nothing left behind: not sent', () => {
    expect(decideSweepFeedback(input({ affected: 8 }), USER_ON)).toBeNull()
  })

  test('session (web UI) auth: not sent — the page shows the toast', () => {
    expect(decideSweepFeedback(input({ urgent: 3 }, { viaBearer: false }), USER_ON)).toBeNull()
  })

  test('notify: false suppresses it; notify: true is the default', () => {
    expect(decideSweepFeedback(input({ urgent: 3 }, { notify: false }), USER_ON)).toBeNull()
    expect(decideSweepFeedback(input({ urgent: 3 }, { notify: true }), USER_ON)).not.toBeNull()
  })

  test('the setting off, notifications off, or the demo user: not sent', () => {
    const left = input({ affected: 2, urgent: 3 })
    expect(
      decideSweepFeedback(left, { ...USER_ON, sweep_feedback_notifications_enabled: 0 }),
    ).toBeNull()
    expect(decideSweepFeedback(left, { ...USER_ON, notifications_enabled: 0 })).toBeNull()
    expect(decideSweepFeedback(left, { ...USER_ON, is_demo: 1 })).toBeNull()
    expect(decideSweepFeedback(left, undefined)).toBeNull()
  })
})

describe('planSweepFeedback reads the user’s settings', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())

  function setUser(column: string, value: number): void {
    getDb().prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(value, TEST_USER_ID)
  }

  test('the column defaults to on for a new user', () => {
    const row = getDb()
      .prepare('SELECT sweep_feedback_notifications_enabled AS v FROM users WHERE id = ?')
      .get(TEST_USER_ID) as { v: number }
    expect(row.v).toBe(1)
    expect(planSweepFeedback(TEST_USER_ID, input({ urgent: 2 }))?.title).toBe('Nothing snoozed')
  })

  test('turned off: nothing; back on: sent again', () => {
    setUser('sweep_feedback_notifications_enabled', 0)
    expect(planSweepFeedback(TEST_USER_ID, input({ urgent: 2 }))).toBeNull()
    setUser('sweep_feedback_notifications_enabled', 1)
    expect(planSweepFeedback(TEST_USER_ID, input({ urgent: 2 }))).not.toBeNull()
  })

  test('notifications off as a whole: nothing', () => {
    setUser('notifications_enabled', 0)
    expect(planSweepFeedback(TEST_USER_ID, input({ urgent: 2 }))).toBeNull()
    setUser('notifications_enabled', 1)
  })
})

describe('the APNs payload', () => {
  test('a banner without sound, TASK_SUMMARY on the tasks thread, its own collapse id', () => {
    const n = buildSweepResultNotification('tok', 'io.mcnitt.opentask', {
      title: 'Snoozed 8 tasks until 3:00 PM',
      body: '2 High still overdue. Snooze again to move the High ones',
      totalOverdueCount: 2,
      priority: 3,
    })

    expect(n.pushType).toBe(PushType.alert)
    expect(n.priority).toBe(Priority.immediate)
    // No `sound`, no `badge`, no `taskId` (so a task's `dismiss` push never
    // matches it). `priority` keeps the apps' after-sweep dismissal
    // (`dismissNotifications(atOrBelowPriority:)`) from clearing it as the
    // sweep it reports comes back; `totalOverdueCount` is the content
    // extension's bulk grid header.
    expect(n.buildApnsOptions()).toEqual({
      aps: {
        alert: {
          title: 'Snoozed 8 tasks until 3:00 PM',
          body: '2 High still overdue. Snooze again to move the High ones',
        },
        category: 'TASK_SUMMARY',
        'thread-id': 'ot-tasks',
        'interruption-level': 'active',
      },
      kind: 'sweep-result',
      totalOverdueCount: 2,
      overflowCount: 2,
      priority: 3,
    })
    expect(n.options.collapseId).toBe('sweep-result')
  })
})
