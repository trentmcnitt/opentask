/**
 * QN-I: THE KIND'S ICON AND LABEL LINE (Trent, 2026-11-07, round 4 of the
 * mockups; src/core/notifications/format.ts). Five APNs push kinds carry
 * `data.icon`, `mutable-content` (so the native service extension can put the
 * kind's avatar on them) and a label line as the alert's `subtitle`. Every
 * other push stays plain: no icon, no `mutable-content`.
 */
import { describe, expect, test } from 'vitest'
import {
  buildDeadlineCapNotification,
  buildDeadlinesNagNotification,
  buildEnrichedNotification,
  buildEnrichmentFailedNotification,
  buildPromptNagNotification,
  buildReminderNagNotification,
  buildSlotReminderNotification,
  buildSweepResultNotification,
} from '@/core/notifications/apns'
import {
  deadlinePushLabel,
  periodPushLabel,
  priorityWord,
  quotaPushLabel,
  reminderPushLabel,
  shortAgo,
  taskPushLabel,
} from '@/core/notifications/format'
import type { Notification } from 'apns2'

const TOKEN = 'tok'
const TOPIC = 'io.mcnitt.opentask'

function json(n: Notification): { aps: Record<string, unknown>; [k: string]: unknown } {
  return JSON.parse(JSON.stringify(n.buildApnsOptions()))
}

describe('QN-I01 the label lines', () => {
  test('the five kinds say what they are, in the mockup’s words', () => {
    const now = new Date('2026-11-07T18:00:00Z')
    expect(taskPushLabel(3, '2026-11-07T16:00:00Z', now)).toBe('Task · High · 2h over target')
    expect(taskPushLabel(4, '2026-11-07T17:45:00Z', now)).toBe('Task · Urgent · 15m over target')
    // None has no priority word.
    expect(taskPushLabel(0, '2026-11-04T18:00:00Z', now)).toBe('Task · 3d over target')
    expect(reminderPushLabel('After School')).toBe('Reminder · After School')
    expect(periodPushLabel('After School', 5)).toBe('Period · After School · 5 items')
    expect(periodPushLabel('Morning', 1)).toBe('Period · Morning · 1 item')
    expect(quotaPushLabel('Health', '1 of 2 today')).toBe('Quota · Health · 1 of 2 today')
    expect(quotaPushLabel(null, '0 of 3 this week')).toBe('Quota · 0 of 3 this week')
    expect(deadlinePushLabel('Sun')).toBe('Deadline · due Sun')
  })

  test('shortAgo rounds down to whole units, never below a minute', () => {
    const now = new Date('2026-11-07T18:00:00Z')
    expect(shortAgo('2026-11-07T17:59:50Z', now)).toBe('1m')
    expect(shortAgo('2026-11-07T17:01:00Z', now)).toBe('59m')
    expect(shortAgo('2026-11-07T17:00:00Z', now)).toBe('1h')
    expect(shortAgo('2026-11-06T18:00:01Z', now)).toBe('23h')
    expect(shortAgo('2026-11-05T17:00:00Z', now)).toBe('2d')
    expect([4, 3, 2, 1, 0].map(priorityWord)).toEqual(['Urgent', 'High', 'Medium', 'Low', null])
  })
})

describe('QN-I02 the five kinds wear their icon', () => {
  test('period: icon, mutable-content, the label line from its own counts', () => {
    const j = json(
      buildSlotReminderNotification(TOKEN, TOPIC, {
        slotId: 14,
        slotLabel: 'After School',
        count: 3,
        promptCount: 2,
      }),
    )
    expect(j.icon).toBe('period')
    expect(j.aps['mutable-content']).toBe(1)
    expect(j.aps.alert).toEqual({
      title: 'After School',
      subtitle: 'Period · After School · 5 items',
      body: '3 reminders · 2 quotas waiting',
    })
    expect(j.aps.category).toBe('SLOT_REMINDER')
  })

  test('reminder: the period names the label line', () => {
    const j = json(
      buildReminderNagNotification(TOKEN, TOPIC, {
        taskId: 7,
        title: 'Pack the gym bag',
        body: 'After School · High reminder',
        slotLabel: 'After School',
        reminderDay: '2026-11-07',
        sound: true,
      }),
    )
    expect(j.icon).toBe('reminder')
    expect(j.aps['mutable-content']).toBe(1)
    expect(j.aps.alert).toMatchObject({ subtitle: 'Reminder · After School' })
    expect(j.reminder_day).toBe('2026-11-07')
  })

  test('quota and deadline: the label line as given, the deadline keeping its `kind`', () => {
    const q = json(
      buildPromptNagNotification(TOKEN, TOPIC, {
        taskId: 9,
        promptKey: 'q:9:1:2026-11-07',
        title: 'Evening walk',
        subtitle: 'Quota · Health · 1 of 2 today',
        body: 'After School · 1/2 today',
        sound: false,
      }),
    )
    expect(q.icon).toBe('quota')
    expect(q.aps['mutable-content']).toBe(1)
    expect(q.aps.alert).toMatchObject({ subtitle: 'Quota · Health · 1 of 2 today' })
    const d = json(
      buildDeadlinesNagNotification(TOKEN, TOPIC, {
        title: 'Deadlines',
        subtitle: 'Deadline · due Sun',
        body: '2 deadlines to plan · nearest Sun',
      }),
    )
    // `kind` still routes the body tap natively; the icon has its own field.
    expect(d).toMatchObject({ kind: 'deadlines', icon: 'deadline' })
    expect(d.aps['mutable-content']).toBe(1)
  })
})

describe('QN-I03 every other push stays plain', () => {
  test('no icon and no mutable-content: enrichment, its failure, the sweep result, the deadline cap', () => {
    const plain = [
      buildEnrichedNotification(TOKEN, TOPIC, {
        title: 'Added',
        body: 'Water the plants',
        taskId: 1,
      }),
      buildEnrichmentFailedNotification(TOKEN, TOPIC, { title: 'AI failed', body: 'x', taskId: 1 }),
      buildSweepResultNotification(TOKEN, TOPIC, {
        title: 'Deferred 3',
        body: '1 High still overdue',
        totalOverdueCount: 1,
        priority: 3,
      }),
      buildDeadlineCapNotification(TOKEN, TOPIC, { title: 'Deferred to deadline', body: 'x' }),
    ].map(json)
    for (const j of plain) {
      expect(j).not.toHaveProperty('icon')
      expect(j.aps).not.toHaveProperty('mutable-content')
    }
  })
})
