/**
 * The shelved AI features over HTTP (2026-10-22; src/core/ai/shelved.ts).
 *
 * The server runs with OPENTASK_AI_UNSHELVE unset, as production does and as
 * every other file expects: every What's Next, Insights and Quick Take
 * endpoint answers the one shelved response, and enrichment's endpoints answer
 * exactly as before. The "unshelved" block turns the switch on through the
 * test route and off again afterwards.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { apiFetch, apiAnon, resetTestData, setAiUnshelved } from './helpers'

const SHELVED_BODY = {
  error: "What's Next, Insights and Quick Take are shelved",
  code: 'FEATURE_SHELVED',
}

/** Every shelved endpoint, with a body that would otherwise pass validation. */
const SHELVED: { name: string; path: string; init?: Parameters<typeof apiFetch>[1] }[] = [
  { name: 'GET /api/ai/whats-next', path: '/api/ai/whats-next' },
  { name: 'GET /api/ai/whats-next?refresh=true', path: '/api/ai/whats-next?refresh=true' },
  {
    name: 'POST /api/ai/insights/generate',
    path: '/api/ai/insights/generate',
    init: { method: 'POST' },
  },
  { name: 'GET /api/ai/insights/results', path: '/api/ai/insights/results' },
  { name: 'GET /api/ai/insights/status', path: '/api/ai/insights/status?session_id=abc' },
  {
    name: 'POST /api/ai/quick-take',
    path: '/api/ai/quick-take',
    init: { method: 'POST', body: { title: 'Buy milk' } },
  },
  ...(['whats_next', 'insights', 'quick_take'] as const).map((feature) => ({
    name: `POST /api/ai/test { feature: ${feature} }`,
    path: '/api/ai/test',
    init: { method: 'POST' as const, body: { feature } },
  })),
]

describe('shelved AI features (the default)', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  for (const { name, path, init } of SHELVED) {
    test(`${name} answers 410 FEATURE_SHELVED`, async () => {
      const res = await apiFetch(path, init)
      expect(res.status).toBe(410)
      expect(await res.json()).toEqual(SHELVED_BODY)
    })
  }

  test('a shelved endpoint still answers 401 without auth', async () => {
    const res = await apiAnon('/api/ai/whats-next')
    expect(res.status).toBe(401)
  })

  test('preferences report ai_unshelved: false, and the saved AI modes unchanged', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.ai_unshelved).toBe(false)
    expect(data.ai_whats_next_mode).toBeDefined()
    expect(data.ai_insights_mode).toBeDefined()
    expect(data.ai_quicktake_mode).toBeDefined()
  })

  describe('enrichment is untouched', () => {
    test('POST /api/ai/test { feature: enrichment } is not shelved (503: AI off here)', async () => {
      const res = await apiFetch('/api/ai/test', {
        method: 'POST',
        body: { feature: 'enrichment' },
      })
      expect(res.status).toBe(503)
      expect((await res.json()).code).toBe('SERVICE_UNAVAILABLE')
    })

    test('GET /api/ai/status (enrichment status) is not shelved', async () => {
      const res = await apiFetch('/api/ai/status')
      expect(res.status).toBe(503)
      expect((await res.json()).code).toBe('SERVICE_UNAVAILABLE')
    })

    test('creating a task still works', async () => {
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title: 'Shelved-features create check' },
      })
      expect(res.status).toBe(201)
    })

    // Process has its own AI mode and is not shelved (2026-10-22): with AI
    // off here, both of its AI steps answer their AI-off empty list, never 410.
    test('Process AI is not shelved: recommend-projects and duplicates answer 200', async () => {
      const created = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title: 'Shelved-features Process check' },
      })
      const id = (await created.json()).data.id
      const rec = await apiFetch('/api/process/recommend-projects', {
        method: 'POST',
        body: { ids: [id] },
      })
      expect(rec.status).toBe(200)
      expect((await rec.json()).data).toEqual({ recommendations: [] })
      const dup = await apiFetch('/api/process/duplicates')
      expect(dup.status).toBe(200)
      expect((await dup.json()).data).toEqual({ groups: [] })
    })

    test('POST /api/ai/test { feature: process } is not shelved (503: AI off here)', async () => {
      const res = await apiFetch('/api/ai/test', { method: 'POST', body: { feature: 'process' } })
      expect(res.status).toBe(503)
    })

    test('the review-session API (not an AI feature) is not shelved', async () => {
      const res = await apiFetch('/api/review')
      expect(res.status).toBe(200)
    })
  })
})

describe('unshelved (OPENTASK_AI_UNSHELVE=1)', () => {
  beforeAll(async () => {
    await setAiUnshelved(true)
  })
  afterAll(async () => {
    await setAiUnshelved(false)
  })

  test('preferences report ai_unshelved: true', async () => {
    const { data } = await (await apiFetch('/api/user/preferences')).json()
    expect(data.ai_unshelved).toBe(true)
  })

  test("What's Next, Insights generate and Quick Take reach their old answer (503: AI off here)", async () => {
    for (const { path, init } of [
      { path: '/api/ai/whats-next', init: undefined },
      { path: '/api/ai/insights/generate', init: { method: 'POST' as const } },
      { path: '/api/ai/quick-take', init: { method: 'POST' as const, body: { title: 'x' } } },
    ]) {
      const res = await apiFetch(path, init)
      expect(res.status, path).toBe(503)
      expect((await res.json()).code, path).toBe('SERVICE_UNAVAILABLE')
    }
  })

  test('Insights results serve the (empty) cache again', async () => {
    const res = await apiFetch('/api/ai/insights/results')
    expect(res.status).toBe(200)
  })
})
