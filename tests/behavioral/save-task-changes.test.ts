/**
 * `withAiFailedCleared` — the reminder editors' rule that a hand edit takes
 * the `ai-failed` mark off (see `saveReminderDetail`).
 */
import { describe, expect, test } from 'vitest'
import { withAiFailedCleared } from '@/lib/save-task-changes'

describe('withAiFailedCleared', () => {
  test('adds ai-failed to labels_remove when the task carries it', () => {
    const changes = { rrule: 'FREQ=DAILY' }
    expect(withAiFailedCleared({ labels: ['ai-failed'] }, changes)).toEqual({
      rrule: 'FREQ=DAILY',
      labels_remove: ['ai-failed'],
    })
  })

  test('keeps labels the edit already removes', () => {
    expect(
      withAiFailedCleared({ labels: ['home', 'ai-failed'] }, { labels_remove: ['home'] }),
    ).toEqual({ labels_remove: ['home', 'ai-failed'] })
  })

  test('does not mutate the changes it was given', () => {
    const changes = { labels_remove: ['home'] }
    withAiFailedCleared({ labels: ['ai-failed'] }, changes)
    expect(changes).toEqual({ labels_remove: ['home'] })
  })

  test('returns the changes untouched when the task has no ai-failed mark', () => {
    const changes = { title: 'Stretch' }
    expect(withAiFailedCleared({ labels: ['home'] }, changes)).toBe(changes)
  })

  test('returns the changes untouched when the task is unknown', () => {
    const changes = { title: 'Stretch' }
    expect(withAiFailedCleared(undefined, changes)).toBe(changes)
  })
})
