import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

/** Create overdue tasks and open a review session; returns each task's seq by id. */
async function reviewWith(tasks: { title: string; priority?: number }[]) {
  const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const ids: number[] = []
  for (const t of tasks) {
    const res = await apiFetch('/api/tasks', { method: 'POST', body: { ...t, due_at: dueAt } })
    expect(res.status).toBe(201)
    ids.push((await res.json()).data.id)
  }
  const session = (await (await apiFetch('/api/review')).json()).data
  const seqOf = new Map<number, string>()
  for (const group of session.groups) {
    for (const task of group.tasks) seqOf.set(task.id, String(task.seq))
  }
  for (const id of ids) expect(seqOf.has(id)).toBe(true)
  return { sessionId: session.session_id as string, ids, seqOf }
}

async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

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

  test('a snooze action without until is refused before any action runs', async () => {
    const { sessionId, ids, seqOf } = await reviewWith([{ title: 'Review — done target' }])
    const [doneId] = ids

    const res = await apiFetch('/api/review/execute', {
      method: 'POST',
      body: {
        session_id: sessionId,
        actions: [
          { type: 'done', targets: [seqOf.get(doneId)] },
          { type: 'snooze', targets: [seqOf.get(doneId)] },
        ],
      },
    })
    expect(res.status).toBe(400)

    // Nothing ran: the done target is still open, and the session still works.
    expect((await getTask(doneId)).done).toBe(false)
    const retry = await apiFetch('/api/review/execute', {
      method: 'POST',
      body: { session_id: sessionId, actions: [{ type: 'done', targets: [seqOf.get(doneId)] }] },
    })
    expect(retry.status).toBe(200)
  })

  test('snooze moves High and Urgent targets, because review targets are explicit', async () => {
    const { sessionId, ids, seqOf } = await reviewWith([
      { title: 'Review — plain', priority: 0 },
      { title: 'Review — high', priority: 3 },
      { title: 'Review — urgent', priority: 4 },
    ])
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/review/execute', {
      method: 'POST',
      body: {
        session_id: sessionId,
        actions: [{ type: 'snooze', targets: ids.map((id) => seqOf.get(id)), until }],
      },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.results[0].count).toBe(3)
    for (const id of ids) {
      expect(new Date((await getTask(id)).due_at).getTime()).toBe(new Date(until).getTime())
    }
  })
})
