/**
 * The header's snooze-all clock (desktop). A plain tap sends every overdue
 * task to the NEXT PERIOD by default — the next time slot to start — and a
 * setting flips it back to the default snooze option (Trent, 2026-09-22: "I
 * want the default bulk snooze... to default to next period. Add a settings
 * item to toggle that").
 *
 * A tap snoozes EVERY overdue task the shared test user has, seeded ones
 * other specs rely on included, so each tap is taken back with the toast's
 * Undo before the test moves on.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

async function setBulkDefault(page: Page, value: 'next_period' | 'default_option') {
  const res = await page.request.patch('/api/user/preferences', {
    data: { bulk_snooze_default: value },
  })
  expect(res.ok()).toBeTruthy()
}

/** The soonest upcoming slot start, as the server resolves "next". */
async function nextPeriodMillis(page: Page): Promise<number> {
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
    start_time: string
  }[]
  const now = DateTime.now().setZone(TEST_TZ)
  return Math.min(
    ...slots.map((s) => {
      const [h, m] = s.start_time.split(':').map(Number)
      const today = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
      return (today > now ? today : today.plus({ days: 1 })).toMillis()
    }),
  )
}

async function dueMillis(page: Page, id: number): Promise<number> {
  const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
  return DateTime.fromISO(task.due_at).toMillis()
}

/** Tap the clock, wait for the sweep to land, and return its toast. */
async function tapClock(page: Page) {
  const done = page.waitForResponse(
    (r) => r.url().endsWith('/api/tasks/bulk/snooze') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: /hold for options/ }).click()
  expect((await done).ok()).toBeTruthy()
  return page.locator('[data-sonner-toast]').filter({ hasText: /^Snoozed \d+ / })
}

test.describe('Snooze-all clock', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('a tap goes to the next period; the setting flips it to the default snooze', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.post('/api/tasks', {
      data: {
        title: 'Snooze-all clock probe',
        priority: 1,
        due_at: DateTime.now().minus({ hours: 2 }).toUTC().toISO(),
      },
    })
    expect(res.ok()).toBeTruthy()
    const id = (await res.json()).data.id as number

    try {
      // Default: the next period.
      await setBulkDefault(page, 'next_period')
      await page.goto('/')
      let toast = await tapClock(page)
      await expect(toast).toBeVisible()
      expect(await dueMillis(page, id)).toBe(await nextPeriodMillis(page))
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect.poll(() => dueMillis(page, id)).toBeLessThan(Date.now())

      // Flipped: the user's default snooze option (+1 hour for the test user,
      // snapped to the hour) — so within the next two hours, and not the
      // next period unless the two happen to coincide.
      await setBulkDefault(page, 'default_option')
      await page.reload()
      toast = await tapClock(page)
      await expect(toast).toBeVisible()
      const due = await dueMillis(page, id)
      expect(due).toBeGreaterThan(Date.now())
      expect(due - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000)
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect.poll(() => dueMillis(page, id)).toBeLessThan(Date.now())
    } finally {
      await setBulkDefault(page, 'next_period')
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
