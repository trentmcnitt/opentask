/**
 * POST /api/reminders/move — the one-day move over HTTP (2026-11-21; rules
 * RM-MOVE-*, src/core/tasks/reminder-move.ts). The server's clock is pinned to
 * a morning (`/api/test/clock`) so which periods are open is deterministic; the
 * default periods: Early morning 07:00, Morning 09:00, Midday 12:00,
 * Afternoon 16:00, Evening 20:30. User A is in America/Chicago.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'

const TZ = 'America/Chicago'

/** 10:00 local on the latest day whose 10:00 has passed (pin at or before real now). */
function pinnedMorning(): DateTime {
  const now = DateTime.now().setZone(TZ)
  const today = now.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  return today <= now ? today : today.minus({ days: 1 })
}

async function json(res: Response) {
  return (await res.json()) as { data?: Record<string, unknown>; error?: string }
}

let pinned: DateTime
let slots: { id: number; label: string }[]

async function periodOf(id: number): Promise<string | null> {
  const body = (await json(await apiFetch('/api/reminders'))).data as {
    groups: { slot: { label: string } | null; reminders: { id: number }[] }[]
  }
  const group = body.groups.find((g) => g.reminders.some((t) => t.id === id))
  return group ? (group.slot?.label ?? 'Anytime') : null
}

const slotId = (label: string) => slots.find((s) => s.label === label)!.id

async function reminderAt(hour: number, minute: number): Promise<number> {
  const due = pinned.set({ hour, minute }).toUTC().toISO()
  const res = await apiFetch('/api/tasks', {
    method: 'POST',
    body: { title: 'Water the balcony herbs', is_reminder: true, due_at: due },
  })
  expect(res.status).toBe(201)
  return ((await json(res)).data as { id: number }).id
}

beforeAll(async () => {
  await resetTestData()
  pinned = pinnedMorning()
  const res = await apiFetch('/api/test/clock', {
    method: 'POST',
    body: { now: pinned.toUTC().toISO() },
  })
  expect(res.status).toBe(200)
  slots = ((await json(await apiFetch('/api/time-slots'))).data as { time_slots: typeof slots })
    .time_slots
})

afterAll(async () => {
  await apiFetch('/api/test/clock', { method: 'POST', body: { now: null } })
})

describe('POST /api/reminders/move', () => {
  test('moves a Morning reminder to Afternoon for today; its own Undo puts it back', async () => {
    const id = await reminderAt(9, 30)
    expect(await periodOf(id)).toBe('Morning')
    const res = await apiFetch('/api/reminders/move', {
      method: 'POST',
      body: { ids: [id], slot_id: slotId('Afternoon') },
    })
    expect(res.status).toBe(200)
    const data = (await json(res)).data as Record<string, unknown>
    expect(data).toMatchObject({ moved: [id], moved_prompts: [], slot_label: 'Afternoon' })
    expect(typeof data.undo_id).toBe('number')
    expect(await periodOf(id)).toBe('Afternoon')

    const undo = await apiFetch('/api/undo', { method: 'POST', body: { id: data.undo_id } })
    expect(undo.status).toBe(200)
    expect(await periodOf(id)).toBe('Morning')
  })

  test('refuses its own period, an unknown one, and an empty body', async () => {
    const id = await reminderAt(9, 45)
    const status = async (body: unknown) =>
      (await apiFetch('/api/reminders/move', { method: 'POST', body })).status
    expect(await status({ ids: [id], slot_id: slotId('Morning') })).toBe(400)
    expect(await status({ ids: [id], slot_id: 999_999 })).toBe(400)
    expect(await status({ slot_id: slotId('Evening') })).toBe(400)
    expect(await status({ ids: [id] })).toBe(400)
    expect(await periodOf(id)).toBe('Morning')
  })

  test('moves EARLIER, into a period already open (2026-11-27)', async () => {
    const id = await reminderAt(9, 50)
    const res = await apiFetch('/api/reminders/move', {
      method: 'POST',
      body: { ids: [id], slot_id: slotId('Early morning') },
    })
    expect(res.status).toBe(200)
    expect(await periodOf(id)).toBe('Early morning')
  })
})
