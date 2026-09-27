import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Review workflow integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('GET /review creates session, POST /review/execute marks tasks done', async () => {
    // The review takes what is overdue or due within the next 24 hours. The
    // shared seed only has "tomorrow 07:00" and later, which is inside that
    // window only after 07:00 in the seed's zone — so the test brings its own
    // tasks, relative to now: one overdue, one due within the hour.
    const now = Date.now()
    const ownIds: number[] = []
    for (const [title, offsetMs] of [
      ['Review test — overdue', -60 * 60 * 1000],
      ['Review test — due soon', 60 * 60 * 1000],
    ] as const) {
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title, due_at: new Date(now + offsetMs).toISOString() },
      })
      expect(res.status).toBe(201)
      ownIds.push((await res.json()).data.id)
    }

    // Get a review session
    const reviewRes = await apiFetch('/api/review')
    expect(reviewRes.status).toBe(200)
    const session = (await reviewRes.json()).data

    expect(typeof session.session_id).toBe('string')
    expect(session.session_id.length).toBeGreaterThan(0)

    // Find seq numbers for tasks in the session
    const allSeqs: number[] = []
    const sessionIds: number[] = []
    for (const group of session.groups) {
      for (const task of group.tasks) {
        allSeqs.push(task.seq)
        sessionIds.push(task.id)
      }
    }
    expect(sessionIds).toEqual(expect.arrayContaining(ownIds))

    // Mark some as done using seq numbers
    const targetSeqs = allSeqs.slice(0, 2).map(String)

    const executeRes = await apiFetch('/api/review/execute', {
      method: 'POST',
      body: {
        session_id: session.session_id,
        actions: [{ type: 'done', targets: targetSeqs }],
      },
    })
    expect(executeRes.status).toBe(200)
    const execData = (await executeRes.json()).data
    expect(execData.executed).toBe(true)
  })

  test('POST /review/execute with invalid session returns error', async () => {
    const res = await apiFetch('/api/review/execute', {
      method: 'POST',
      body: {
        session_id: 'nonexistent-session-id',
        actions: [{ type: 'done', targets: ['1'] }],
      },
    })
    expect(res.status).toBe(409)
  })
})
