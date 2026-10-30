/**
 * Undo on the Reminders surface is optimistic (Trent, 2026-10-29: "if I
 * consider something in the reminders and I undo it, it can take anywhere
 * from fairly quick to many seconds before it reappears";
 * `src/lib/reminder-undo.ts`).
 *
 * The network is made slow on purpose — every reminders refresh, and the undo
 * request itself, answer after `SLOW_MS` — so a row that only came back with
 * the refresh would miss the deadline by seconds:
 * - the toast's Undo puts the row back with no request at all;
 * - the header's Undo puts it back as soon as `POST /api/undo` answers, without
 *   waiting for the (slow) refresh;
 * - and the slow refresh, when it lands, keeps it there.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
/** How slow the network is made: far longer than any deadline below. */
const SLOW_MS = 3000

/** A moment a few minutes ago, today: a reminder there is in a slot that has started. */
function inStartedSlot(): string {
  const now = DateTime.now().setZone(TEST_TZ)
  const passed = now.minus({ minutes: 5 })
  const safe = passed.hasSame(now, 'day') ? passed : now.startOf('day').plus({ minutes: 1 })
  return safe.toUTC().toISO() as string
}

async function createReminder(page: Page, title: string, dueAt: string): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { is_reminder: true, title, due_at: dueAt },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Answer these requests only after `SLOW_MS`: a slow network, on purpose. */
async function slow(page: Page, pattern: string) {
  await page.route(pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    await route.continue().catch(() => undefined)
  })
}

async function isDone(page: Page, id: number): Promise<boolean> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.done as boolean
}

const row = (page: Page, id: number) => page.locator(`li[data-reminder-id="${id}"]`)

test.describe('Reminders: undo puts a considered row back at once', () => {
  test("the toast's Undo: the row is back within 300ms, with no request answered", async ({
    authenticatedPage: page,
  }) => {
    const dueAt = inStartedSlot()
    const title = uniqueTitle('UI toast undo')
    const id = await createReminder(page, title, dueAt)
    const other = await createReminder(page, uniqueTitle('UI toast other'), dueAt)
    try {
      await page.goto('/reminders')
      await expect(row(page, id)).toBeVisible()
      await slow(page, '**/api/reminders?*')
      await slow(page, '**/api/undo')

      await page.getByRole('button', { name: `Mark "${title}" as considered` }).click()
      await expect(row(page, id)).toHaveCount(0)
      await expect.poll(() => isDone(page, id)).toBe(true)

      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
      await expect(row(page, id)).toBeVisible({ timeout: 300 })

      // The server catches up behind it, and the slow refresh keeps the row.
      await expect.poll(() => isDone(page, id), { timeout: 10_000 }).toBe(false)
      await page.waitForResponse((r) => r.url().includes('/api/reminders?'), { timeout: 10_000 })
      await expect(row(page, id)).toBeVisible()
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id, other] } })
    }
  })

  test("the header's Undo: the row is back when the undo answers, before the refresh", async ({
    authenticatedPage: page,
  }) => {
    const dueAt = inStartedSlot()
    const title = uniqueTitle('UI header undo')
    const id = await createReminder(page, title, dueAt)
    const other = await createReminder(page, uniqueTitle('UI header other'), dueAt)
    try {
      await page.goto('/reminders')
      await expect(row(page, id)).toBeVisible()
      await slow(page, '**/api/reminders?*')

      await page.getByRole('button', { name: `Mark "${title}" as considered` }).click()
      await expect(row(page, id)).toHaveCount(0)
      await expect.poll(() => isDone(page, id)).toBe(true)

      const undone = page.waitForResponse((r) => r.url().endsWith('/api/undo'))
      await page.getByRole('banner').getByRole('button', { name: /^Undo/ }).click()
      await undone
      // The refresh it started is still out (SLOW_MS); the row is back already.
      await expect(row(page, id)).toBeVisible({ timeout: 300 })
      expect(await isDone(page, id)).toBe(false)
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id, other] } })
    }
  })
})
