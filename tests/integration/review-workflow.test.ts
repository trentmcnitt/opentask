import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Review workflow integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('GET /review creates session, POST /review/execute marks tasks done', async () => {
    // Get a review session
    const reviewRes = await apiFetch('/api/review')
    expect(reviewRes.status).toBe(200)
    const session = (await reviewRes.json()).data

    expect(session.session_id).toBeTruthy()
    expect(session.total_tasks).toBeGreaterThan(0)

    // Find seq numbers for tasks in the session
    const allSeqs: number[] = []
    for (const group of session.groups) {
      for (const task of group.tasks) {
        allSeqs.push(task.seq)
      }
    }

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
