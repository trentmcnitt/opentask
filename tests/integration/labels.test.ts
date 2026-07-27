/**
 * Label registry HTTP tests (REDESIGN-V03 §7.2)
 *
 * The behavioral suite covers the registry's logic. This covers the wire
 * contract: that an unknown label is a 400 rather than a silent write, that
 * `create_label` is the documented way through, and that `confirm` swaps
 * provenance without touching anything else.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Label registry', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('GET /api/labels lists the registry including system vocabulary', async () => {
    const res = await apiFetch('/api/labels')
    expect(res.status).toBe(200)
    const { data } = await res.json()

    const names = data.labels.map((l: { name: string }) => l.name)
    expect(names).toContain('work')
    expect(names).toContain('ai-added')

    const aiAdded = data.labels.find((l: { name: string }) => l.name === 'ai-added')
    expect(aiAdded.facet).toBe('operational')
  })

  test('POST /api/tasks with an unknown label is rejected', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Typo label task', labels: ['definitely-not-registered'] },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/unknown label/i)
  })

  test('POST /api/tasks with create_label registers it and succeeds', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Deliberate label task', labels: ['garden'], create_label: true },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data.labels).toContain('garden')

    const list = await apiFetch('/api/labels')
    const names = (await list.json()).data.labels.map((l: { name: string }) => l.name)
    expect(names).toContain('garden')
  })

  test('POST /api/labels registers a label directly', async () => {
    const res = await apiFetch('/api/labels', {
      method: 'POST',
      body: { name: 'finance', facet: 'domain' },
    })
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.name).toBe('finance')

    // Now usable with no flag.
    const taskRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Pay tax', labels: ['finance'] },
    })
    expect(taskRes.status).toBe(201)
  })

  test('an unrelated edit succeeds on a task carrying a deregistered label', async () => {
    const create = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Orphan holder', labels: ['transient'], create_label: true },
    })
    const task = (await create.json()).data

    const del = await apiFetch('/api/labels/transient', { method: 'DELETE' })
    expect(del.status).toBe(200)

    // §7.2: only NEWLY added labels are checked, so this must still save.
    const patch = await apiFetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: { title: 'Orphan holder renamed' },
    })
    expect(patch.status).toBe(200)
    expect((await patch.json()).data.title).toBe('Orphan holder renamed')
  })

  test('ai_proposed flag applies provenance, and confirm swaps it to ai-added', async () => {
    const create = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Assistant suggestion', ai_proposed: true },
    })
    expect(create.status).toBe(201)
    const task = (await create.json()).data
    expect(task.labels).toContain('ai-proposed')

    const confirm = await apiFetch(`/api/tasks/${task.id}/confirm`, { method: 'POST' })
    expect(confirm.status).toBe(200)
    const confirmed = (await confirm.json()).data

    expect(confirmed.labels).toContain('ai-added')
    expect(confirmed.labels).not.toContain('ai-proposed')
    // Confirming is a statement about provenance only.
    expect(confirmed.title).toBe('Assistant suggestion')
  })

  test('confirm is idempotent', async () => {
    const create = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Confirm twice', ai_proposed: true },
    })
    const task = (await create.json()).data

    await apiFetch(`/api/tasks/${task.id}/confirm`, { method: 'POST' })
    const second = await apiFetch(`/api/tasks/${task.id}/confirm`, { method: 'POST' })
    expect(second.status).toBe(200)

    const labels = (await second.json()).data.labels
    expect(labels.filter((l: string) => l === 'ai-added')).toHaveLength(1)
  })
})
