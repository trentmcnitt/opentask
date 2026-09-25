/**
 * Quota reminders over HTTP (2026-09-24)
 *
 * GET /api/reminders grows `groups[].prompts`; `groups[].reminders` and the
 * counts beside it must stay exactly what native builds already parse. The
 * two actions (POST /api/quota-prompts/consider and /did) and the mixed
 * commit (POST /api/tasks/bulk/complete with `prompts`) are scoped to the
 * caller's own quotas, and undo like anything else. The server-wide
 * `OPENTASK_QUOTA_PROMPTS=off` switch is covered behaviorally (QP-020): the
 * integration server's environment is fixed for the whole run.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

interface Prompt {
  prompt_key: string
  task_id: number
  number: number | null
  title: string
  current: number
  target: number
  period: string | null
  stripe_color: string | null
  considered: boolean
  done: boolean
}

interface Group {
  slot: { id: number; label: string } | null
  reminders: { id: number }[]
  count: number
  considered: number
  considered_items: { id: number }[]
  prompts: Prompt[]
  prompts_waiting: number
  prompts_considered: number
}

async function reminders(fetcher = apiFetch) {
  const res = await fetcher('/api/reminders')
  expect(res.status).toBe(200)
  return (await res.json()).data as {
    groups: Group[]
    total: number
    considered_total: number
    prompts_total: number
    prompts_considered_total: number
    has_any: boolean
  }
}

async function allPrompts(fetcher = apiFetch): Promise<(Prompt & { slot: string | null })[]> {
  const data = await reminders(fetcher)
  return data.groups.flatMap((g) => g.prompts.map((p) => ({ ...p, slot: g.slot?.label ?? null })))
}

async function makeQuota(title: string, rrule: string, target: number, fetcher = apiFetch) {
  const res = await fetcher('/api/tasks', {
    method: 'POST',
    body: { title, rrule, progress_target: target, is_tracked: true },
  })
  expect(res.status).toBe(201)
  return (await res.json()).data as { id: number }
}

async function post(path: string, body: unknown, fetcher = apiFetch) {
  return fetcher(path, { method: 'POST', body })
}

describe('GET /api/reminders — prompts', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('prompts arrive in their own array; reminders[] and its counts are unchanged', async () => {
    const quota = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const reminderRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Breathe', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })
    const reminder = (await reminderRes.json()).data

    const data = await reminders()
    const reminderIds = data.groups.flatMap((g) => g.reminders.map((r) => r.id))
    expect(reminderIds).toContain(reminder.id)
    expect(reminderIds).not.toContain(quota.id)
    // The old counts are reminder-only, exactly as before prompts existed.
    expect(data.total).toBe(reminderIds.length)
    for (const g of data.groups) expect(g.count).toBe(g.reminders.length)

    const prompts = data.groups.flatMap((g) => g.prompts)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      task_id: quota.id,
      number: null,
      title: 'Cook vegetables',
      current: 0,
      target: 5,
      period: 'WEEKLY',
      stripe_color: null,
      considered: false,
      done: false,
    })
    expect(prompts[0].prompt_key).toMatch(new RegExp(`^q:${quota.id}:0:\\d{4}-\\d{2}-\\d{2}$`))
    expect(data.prompts_total).toBe(1)
    expect(data.prompts_considered_total).toBe(0)
    // Every group carries the array, empty or not — a client never has to guess.
    for (const g of data.groups) expect(Array.isArray(g.prompts)).toBe(true)
  })

  test("another user's quotas never appear", async () => {
    await makeQuota('Theirs', 'FREQ=WEEKLY', 3, apiFetchB)
    expect(await allPrompts()).toEqual([])
    expect(await allPrompts(apiFetchB)).toHaveLength(1)
  })

  test('the user switch hides every prompt; the default period moves them', async () => {
    await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const prefs = (await (await apiFetch('/api/user/preferences')).json()).data
    expect(prefs.quota_prompts_enabled).toBe(true)
    expect(prefs.quota_prompt_slot_id).toBeNull()

    let res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompts_enabled: false },
    })
    expect(res.status).toBe(200)
    const off = await reminders()
    expect(off.groups.every((g) => g.prompts.length === 0)).toBe(true)
    expect(off.prompts_total).toBe(0)

    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompts_enabled: true },
    })
    const slots = (await (await apiFetch('/api/time-slots')).json()).data.time_slots as {
      id: number
      label: string
    }[]
    const evening = slots.find((s) => s.label === 'Evening')!
    res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: evening.id },
    })
    expect(res.status).toBe(200)
    expect((await allPrompts())[0].slot).toBe('Evening')
  })

  test("the default period must be one of the user's own", async () => {
    const theirs = (await (await apiFetchB('/api/time-slots')).json()).data.time_slots[0]
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: theirs.id },
    })
    expect(res.status).toBe(400)
  })

  test('the quota editor setting round-trips through PATCH', async () => {
    const quota = await makeQuota('Physical', 'FREQ=YEARLY', 1)
    expect(await allPrompts()).toEqual([]) // yearly: off by default
    const res = await apiFetch(`/api/tasks/${quota.id}`, {
      method: 'PATCH',
      body: { quota_prompt_config: { enabled: true } },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.quota_prompt_config).toEqual({ enabled: true })
    expect(await allPrompts()).toHaveLength(1)

    const bad = await apiFetch(`/api/tasks/${quota.id}`, {
      method: 'PATCH',
      body: { quota_prompt_config: { enabled: 'yes' } },
    })
    expect(bad.status).toBe(400)
  })
})

describe('POST /api/quota-prompts/consider and /did', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('require auth', async () => {
    expect(
      (await apiAnon('/api/quota-prompts/consider', { method: 'POST', body: {} })).status,
    ).toBe(401)
    expect((await apiAnon('/api/quota-prompts/did', { method: 'POST', body: {} })).status).toBe(401)
  })

  test('consider handles it for today without progress; undo brings it back', async () => {
    const quota = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const [prompt] = await allPrompts()
    const res = await post('/api/quota-prompts/consider', { keys: [prompt.prompt_key] })
    expect(res.status).toBe(200)
    const body = (await res.json()).data
    expect(body).toMatchObject({ considered: 1, did: 0 })
    expect(body.tasks[0]).toMatchObject({ id: quota.id, progress_current: 0 })

    const [after] = await allPrompts()
    expect(after).toMatchObject({ considered: true, done: false })

    expect((await apiFetch('/api/undo', { method: 'POST' })).status).toBe(200)
    expect((await allPrompts())[0]).toMatchObject({ considered: false, done: false })
  })

  test('did is +1 and idempotent per key', async () => {
    const quota = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const [prompt] = await allPrompts()
    for (let i = 0; i < 2; i++) {
      const res = await post('/api/quota-prompts/did', { keys: [prompt.prompt_key] })
      expect(res.status).toBe(200)
    }
    const task = (await (await apiFetch(`/api/tasks/${quota.id}`)).json()).data
    expect(task.progress_current).toBe(1)
    expect((await allPrompts())[0]).toMatchObject({ considered: true, done: true, current: 1 })
  })

  test("a stale key, a malformed key and another user's key are refused", async () => {
    const quota = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const stale = `q:${quota.id}:0:2020-01-01`
    expect((await post('/api/quota-prompts/did', { keys: [stale] })).status).toBe(400)
    expect((await post('/api/quota-prompts/did', { keys: ['nope'] })).status).toBe(400)
    expect((await post('/api/quota-prompts/did', { keys: [] })).status).toBe(400)

    const [prompt] = await allPrompts()
    expect(
      (await post('/api/quota-prompts/did', { keys: [prompt.prompt_key] }, apiFetchB)).status,
    ).toBe(400)
    const task = (await (await apiFetch(`/api/tasks/${quota.id}`)).json()).data
    expect(task.progress_current).toBe(0)
  })
})

describe('POST /api/tasks/bulk/complete with prompts', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('a mixed commit is one undo entry', async () => {
    const reminder = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'Breathe', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
        })
      ).json()
    ).data
    const weekly = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const daily = await makeQuota('Daily Walks', 'FREQ=DAILY', 2)
    const prompts = await allPrompts()
    const weeklyKey = prompts.find((p) => p.task_id === weekly.id)!.prompt_key
    const dailyKey = prompts.find((p) => p.task_id === daily.id && p.number === 1)!.prompt_key

    const res = await post('/api/tasks/bulk/complete', {
      ids: [reminder.id],
      prompts: [weeklyKey, { key: dailyKey, did: true }],
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      tasks_affected: 1,
      prompts_considered: 1,
      prompts_did: 1,
    })
    const dailyTask = (await (await apiFetch(`/api/tasks/${daily.id}`)).json()).data
    expect(dailyTask.progress_current).toBe(1)

    expect((await apiFetch('/api/undo', { method: 'POST' })).status).toBe(200)
    const restored = (await (await apiFetch(`/api/tasks/${daily.id}`)).json()).data
    expect(restored.progress_current).toBe(0)
    const again = await allPrompts()
    expect(again.every((p) => !p.considered && !p.done)).toBe(true)
    const data = await reminders()
    expect(data.groups.flatMap((g) => g.reminders.map((r) => r.id))).toContain(reminder.id)
  })

  test('prompts alone are accepted; bare quota ids and an empty body are still refused', async () => {
    const weekly = await makeQuota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const [prompt] = await allPrompts()
    const ok = await post('/api/tasks/bulk/complete', { prompts: [prompt.prompt_key] })
    expect(ok.status).toBe(200)

    expect((await post('/api/tasks/bulk/complete', { ids: [weekly.id] })).status).toBe(400)
    expect((await post('/api/tasks/bulk/complete', {})).status).toBe(400)
  })
})
