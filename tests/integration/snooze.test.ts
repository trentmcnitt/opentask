import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'
import { DateTime } from 'luxon'

describe('Snooze integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST snooze changes due_at and sets original_due_at', async () => {
    const beforeRes = await apiFetch('/api/tasks/1')
    const before = (await beforeRes.json()).data
    const originalDueAt = before.due_at

    const futureTime = DateTime.now().plus({ hours: 3 }).toUTC().toISO()!

    const snoozeRes = await apiFetch('/api/tasks/1/snooze', {
      method: 'POST',
      body: { until: futureTime },
    })
    expect(snoozeRes.status).toBe(200)

    const afterRes = await apiFetch('/api/tasks/1')
    const after = (await afterRes.json()).data
    expect(after.due_at).toBe(futureTime)
    expect(after.original_due_at).toBe(originalDueAt)
    expect(after.is_snoozed).toBe(true)
  })
})
