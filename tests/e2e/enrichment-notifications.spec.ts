/**
 * Settings → Notifications → "Notify when AI finishes a new task" (2026-09-29):
 * the switch for the push sent when AI enrichment finishes for a
 * just-added task (src/core/notifications/enrichment-notify.ts).
 *
 * E2E runs without AI, and the switch only shows where AI runs, so the saving
 * test reports `ai_available: true` on the preferences GET (every other field
 * is the server's own, and the PATCH goes through untouched).
 *
 * The E2E user is shared with every spec, so both preferences are put back to
 * their defaults before the test ends.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'

const SWITCH = 'Notify when AI finishes a new task'

async function pref(page: Page, field: string): Promise<unknown> {
  return (await (await page.request.get('/api/user/preferences')).json()).data[field]
}

async function reportAiAvailable(page: Page): Promise<void> {
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const json = await response.json()
    json.data.ai_available = true
    await route.fulfill({ response, json })
  })
}

test.describe('Notify when AI finishes a new task', () => {
  test('is hidden when AI is not available', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('switch', { name: 'Toggle notifications' })).toBeVisible()
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveCount(0)
  })

  test('is on by default, turns off, survives a reload, and greys out with notifications off', async ({
    authenticatedPage: page,
  }) => {
    try {
      expect(await pref(page, 'enrichment_notifications_enabled')).toBe(true)
      await reportAiAvailable(page)

      await page.goto('/settings')
      const toggle = page.getByRole('switch', { name: SWITCH })
      await expect(toggle).toBeChecked()
      await expect(toggle).toBeEnabled()

      const saved = waitForPreferenceSave(page, 'enrichment_notifications_enabled')
      await toggle.click()
      expect((await saved).ok()).toBeTruthy()
      await expect(toggle).not.toBeChecked()
      expect(await pref(page, 'enrichment_notifications_enabled')).toBe(false)

      await page.reload()
      await expect(page.getByRole('switch', { name: SWITCH })).not.toBeChecked()

      // With notifications as a whole off, the server sends none of these, so
      // the switch is greyed out.
      const off = waitForPreferenceSave(page, 'notifications_enabled')
      await page.getByRole('switch', { name: 'Toggle notifications' }).click()
      expect((await off).ok()).toBeTruthy()
      await expect(page.getByRole('switch', { name: SWITCH })).toBeDisabled()
    } finally {
      await page.request.patch('/api/user/preferences', {
        data: { enrichment_notifications_enabled: true, notifications_enabled: true },
      })
    }
  })
})
