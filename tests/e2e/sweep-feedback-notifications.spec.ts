/**
 * Settings → Notifications → "Bulk snooze results" (2026-10-04): the switch for
 * the quiet push sent when a snooze from a notification, a widget or a Shortcut
 * leaves High or Urgent tasks overdue (src/core/notifications/sweep-feedback.ts).
 *
 * Unlike the "AI finished" switch it does not depend on AI, so it shows on
 * every server. The E2E user is shared with every spec, so both preferences
 * are put back to their defaults before the test ends.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'

const SWITCH = 'Bulk snooze results'

async function pref(page: Page, field: string): Promise<unknown> {
  return (await (await page.request.get('/api/user/preferences')).json()).data[field]
}

test('Bulk snooze results is on by default, turns off, survives a reload, and greys out with notifications off', async ({
  authenticatedPage: page,
}) => {
  try {
    expect(await pref(page, 'sweep_feedback_notifications_enabled')).toBe(true)

    await page.goto('/settings')
    const toggle = page.getByRole('switch', { name: SWITCH })
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()

    const saved = waitForPreferenceSave(page, 'sweep_feedback_notifications_enabled')
    await toggle.click()
    expect((await saved).ok()).toBeTruthy()
    await expect(toggle).not.toBeChecked()
    expect(await pref(page, 'sweep_feedback_notifications_enabled')).toBe(false)

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
      data: { sweep_feedback_notifications_enabled: true, notifications_enabled: true },
    })
  }
})
