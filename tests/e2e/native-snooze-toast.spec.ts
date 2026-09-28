/**
 * The toast for a snooze the iOS app did natively, from a Home Screen quick
 * action (`useNativeSnoozeToast`). The app hands the page the bulk snooze
 * result — `window.__opentaskNativeSnooze` plus an `opentask-native-snoozed`
 * event — and the page shows "Snoozed N tasks · Undo". Here the "native"
 * snooze is the same API call the app makes, and the handoff is done by hand.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

async function dueMillis(page: Page, id: number): Promise<number> {
  const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
  return DateTime.fromISO(task.due_at).toMillis()
}

test.describe('Native quick-action snooze toast', () => {
  test('shows the result with an Undo that reverses the snooze', async ({
    authenticatedPage: page,
  }) => {
    const created = await page.request.post('/api/tasks', {
      data: {
        title: 'Native snooze probe',
        priority: 1,
        due_at: DateTime.now().minus({ hours: 2 }).toUTC().toISO(),
      },
    })
    expect(created.ok()).toBeTruthy()
    const id = (await created.json()).data.id as number

    try {
      // What the app does: sweep the overdue set, +1 hour.
      const res = await page.request.post('/api/tasks/bulk/snooze-overdue', {
        data: { delta_minutes: 60 },
      })
      expect(res.ok()).toBeTruthy()
      const result = (await res.json()).data
      expect(result.tasks_affected).toBeGreaterThan(0)
      expect(await dueMillis(page, id)).toBeGreaterThan(Date.now())

      // ...and hands the page its result.
      await page.evaluate((r) => {
        window.__opentaskNativeSnooze = r
        window.dispatchEvent(new CustomEvent('opentask-native-snoozed'))
      }, result)

      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: `Snoozed ${result.tasks_affected} ` })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: /^Undid: / }),
      ).toBeVisible()
      await expect.poll(() => dueMillis(page, id)).toBeLessThan(Date.now())
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a failed snooze says so', async ({ authenticatedPage: page }) => {
    await page.evaluate(() => {
      window.__opentaskNativeSnooze = { error: true }
      window.dispatchEvent(new CustomEvent('opentask-native-snoozed'))
    })
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Snooze failed' }),
    ).toBeVisible()
  })

  test('a result delivered before the page mounted shows once it does', async ({
    authenticatedPage: page,
  }) => {
    // The cold-launch order: the global is set before the page's scripts run.
    await page.addInitScript(() => {
      window.__opentaskNativeSnooze = {
        tasks_affected: 0,
        snoozed_high: 0,
        skipped_high: 0,
        skipped_urgent: 0,
      }
    })
    await page.goto('/')
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'No snoozable tasks' }),
    ).toBeVisible()
    // Read once: it is gone after the toast.
    expect(await page.evaluate(() => window.__opentaskNativeSnooze)).toBeUndefined()
  })
})
