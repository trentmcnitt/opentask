/**
 * Time slot editing over HTTP (Settings → Reminder periods, 2026-09-24)
 *
 * PATCH / DELETE /api/time-slots/{id}: validation, per-user scoping (another
 * user's slot id is a 404 and is left untouched), the last-slot guard, and a
 * move carrying a reminder along, undone in one step via the returned undo_id.
 * The movement rules themselves are pinned in tests/behavioral/ts-slot-edit.test.ts.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slotsA(): Promise<Slot[]> {
  const res = await apiFetch('/api/time-slots')
  return (await res.json()).data.time_slots
}

async function slotsB(): Promise<Slot[]> {
  const res = await apiFetchB('/api/time-slots')
  return (await res.json()).data.time_slots
}

async function slotA(label: string): Promise<Slot> {
  const slot = (await slotsA()).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot
}

describe('Time slot editing', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('PATCH and DELETE require auth', async () => {
    const slot = await slotA('Morning')
    expect(
      (await apiAnon(`/api/time-slots/${slot.id}`, { method: 'PATCH', body: { label: 'X' } }))
        .status,
    ).toBe(401)
    expect((await apiAnon(`/api/time-slots/${slot.id}`, { method: 'DELETE' })).status).toBe(401)
  })

  test('another user’s slot is a 404 for PATCH and DELETE, and stays untouched', async () => {
    const theirs = (await slotsB())[0]
    const patch = await apiFetch(`/api/time-slots/${theirs.id}`, {
      method: 'PATCH',
      body: { label: 'Mine now' },
    })
    expect(patch.status).toBe(404)
    const del = await apiFetch(`/api/time-slots/${theirs.id}`, { method: 'DELETE' })
    expect(del.status).toBe(404)
    expect((await slotsB()).find((s) => s.id === theirs.id)).toEqual(theirs)
  })

  test('PATCH validates label, start_time format, and unique start times', async () => {
    const slot = await slotA('Morning')
    const bad = async (body: unknown) =>
      (await apiFetch(`/api/time-slots/${slot.id}`, { method: 'PATCH', body })).status
    expect(await bad({ label: '   ' })).toBe(400)
    expect(await bad({ start_time: '9:00' })).toBe(400)
    expect(await bad({ start_time: '24:00' })).toBe(400)
    expect(await bad({})).toBe(400)
    expect(await bad({ start_time: '12:00' })).toBe(400) // Midday's
    expect(await bad({ sort_order: 3 })).toBe(400)
  })

  test('POST refuses a start time the user already has', async () => {
    const res = await apiFetch('/api/time-slots', {
      method: 'POST',
      body: { label: 'Dup', start_time: '09:00' },
    })
    expect(res.status).toBe(400)
  })

  test('a rename returns undo_id null; a new start moves the reminder and one undo restores both', async () => {
    const morning = await slotA('Morning')
    const create = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Stretch', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })
    expect(create.status).toBe(201)
    const reminder = (await create.json()).data

    const rename = await apiFetch(`/api/time-slots/${morning.id}`, {
      method: 'PATCH',
      body: { label: 'Work start' },
    })
    expect(rename.status).toBe(200)
    const renamed = (await rename.json()).data
    expect(renamed.slot.label).toBe('Work start')
    expect(renamed.undo_id).toBeNull()

    const move = await apiFetch(`/api/time-slots/${morning.id}`, {
      method: 'PATCH',
      body: { start_time: '09:30' },
    })
    expect(move.status).toBe(200)
    const moved = (await move.json()).data
    expect(moved.slot.start_time).toBe('09:30')
    expect(moved.reminders_moved).toBe(1)
    expect(moved.undo_id).toEqual(expect.any(Number))

    const after = (await (await apiFetch(`/api/tasks/${reminder.id}`)).json()).data
    expect(after.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')

    const undo = await apiFetch('/api/undo/batch', {
      method: 'POST',
      body: { through_id: moved.undo_id },
    })
    expect(undo.status).toBe(200)
    expect((await slotA('Work start')).start_time).toBe('09:00')
    const restored = (await (await apiFetch(`/api/tasks/${reminder.id}`)).json()).data
    expect(restored.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
  })

  test('DELETE removes a slot, undo brings it back, and the last slot is refused', async () => {
    const midday = await slotA('Midday')
    const del = await apiFetch(`/api/time-slots/${midday.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const body = (await del.json()).data
    expect(body.slot.id).toBe(midday.id)
    expect((await slotsA()).some((s) => s.id === midday.id)).toBe(false)

    await apiFetch('/api/undo/batch', { method: 'POST', body: { through_id: body.undo_id } })
    expect((await slotsA()).find((s) => s.id === midday.id)?.start_time).toBe('12:00')

    const all = await slotsA()
    for (const slot of all.slice(1)) {
      expect((await apiFetch(`/api/time-slots/${slot.id}`, { method: 'DELETE' })).status).toBe(200)
    }
    const last = await apiFetch(`/api/time-slots/${all[0].id}`, { method: 'DELETE' })
    expect(last.status).toBe(400)
    expect(await slotsA()).toHaveLength(1)
  })

  test('a non-numeric id is a 400', async () => {
    const res = await apiFetch('/api/time-slots/abc', { method: 'DELETE' })
    expect(res.status).toBe(400)
  })
})
