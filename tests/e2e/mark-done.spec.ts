import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** The seeded user's zone (globalSetup.ts's `E2E_TZ` override). */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

/*
 * Each test checks the server, not just the toast, and ends by undoing through
 * the toast.
 *
 * The Undo is looked up inside the toast: the top bar has its own always-present
 * "Undo" button, so a page-wide `getByText('Undo')` passed whether or not the
 * toast ever appeared (plan §2 #15, 2026-09-25).
 */

// Seed id (globalSetup.ts): a one-off that other specs don't depend on.
const PREPARE_SLIDES = 6

async function taskOf(page: Page, id: number) {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data as {
    done: boolean
    due_at: string | null
  }
}

function toast(page: Page, message: string) {
  return page.locator('[data-sonner-toast]', { hasText: message })
}

test.describe('Mark done', () => {
  test('clicking done checkbox completes task and shows undo toast', async ({
    authenticatedPage: page,
  }) => {
    expect((await taskOf(page, PREPARE_SLIDES)).done).toBe(false)
    const doneBtn = page.getByRole('button', { name: /mark "Prepare slides" as done/i })
    await expect(doneBtn).toBeVisible({ timeout: 5000 })

    await doneBtn.click()

    const done = toast(page, 'Task completed')
    await expect(done).toBeVisible()
    await expect.poll(async () => (await taskOf(page, PREPARE_SLIDES)).done).toBe(true)

    // The toast's own Undo puts it back, on the server and on screen.
    await done.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await taskOf(page, PREPARE_SLIDES)).done).toBe(false)
    await expect(doneBtn).toBeVisible()
  })

  test('marking recurring task done shows advancement toast', async ({
    authenticatedPage: page,
  }) => {
    // Its own task, created the way the app creates one. The seeded "Evening
    // review" is written straight into SQLite with a bare `FREQ=DAILY` and no
    // `anchor_time` — a shape the API never produces — and advancing it lands
    // on the next day's 00:00 rather than 21:00 (found 2026-09-25, once this
    // test started reading the server back).
    const title = uniqueTitle('Daily wind-down')
    const dueAt = DateTime.now()
      .setZone(TEST_TZ)
      .plus({ days: 1 })
      .set({ hour: 21, minute: 0, second: 0, millisecond: 0 })
    const res = await page.request.post('/api/tasks', {
      data: {
        title,
        due_at: dueAt.toUTC().toISO(),
        rrule: 'FREQ=DAILY',
        recurrence_mode: 'from_due',
        priority: 1,
        project_id: 2, // Routine (globalSetup.ts)
      },
    })
    expect(res.ok()).toBeTruthy()
    const id = (await res.json()).data.id as number
    try {
      const before = await taskOf(page, id)
      await page.reload()
      const doneBtn = page
        .locator(`#task-row-${id}`)
        .getByRole('button', { name: new RegExp(`advance "${title}"`, 'i') })
      await expect(doneBtn).toBeVisible({ timeout: 10_000 })

      await doneBtn.click()

      const advanced = toast(page, 'Task advanced')
      await expect(advanced).toBeVisible()
      // Advanced one calendar day in the user's zone (so a DST change in
      // between doesn't matter), and still open — recurring tasks don't
      // disappear.
      const nextDay = DateTime.fromISO(before.due_at!).setZone(TEST_TZ).plus({ days: 1 }).toMillis()
      await expect
        .poll(async () => DateTime.fromISO((await taskOf(page, id)).due_at!).toMillis())
        .toBe(nextDay)
      expect((await taskOf(page, id)).done).toBe(false)
      await expect(page.locator(`#task-row-${id}`)).toBeVisible()

      await advanced.getByRole('button', { name: 'Undo' }).click()
      await expect.poll(async () => (await taskOf(page, id)).due_at).toBe(before.due_at)
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
