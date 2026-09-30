/**
 * The Settings page after its split into src/components/settings/ (cleanup
 * A11b): every section still renders in order, and the state each section
 * now owns still behaves:
 *
 * - each auto-snooze row owns its "Custom..." editor (it used to be ten
 *   page-level useStates), so opening one leaves the others as selects;
 * - the AI context field shows the saved context once the preferences load
 *   (a draft that stays null until the user types, not a synced copy);
 * - Connected App shows only inside the native iOS wrapper.
 *
 * The E2E user is shared with every spec, so any preference changed here is
 * put back before the test ends.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'

async function pref(page: Page, field: string): Promise<unknown> {
  return (await (await page.request.get('/api/user/preferences')).json()).data[field]
}

async function setPref(page: Page, data: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch('/api/user/preferences', { data })
  expect(res.ok()).toBeTruthy()
}

/** Report `ai_available: true` on the preferences GET (E2E runs without AI). */
async function reportAiAvailable(page: Page): Promise<void> {
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const json = await response.json()
    json.data.ai_available = true
    await route.fulfill({ response, json })
  })
}

function autoSnoozeRow(page: Page, label: string) {
  return page.locator('div.justify-between').filter({ has: page.getByText(label, { exact: true }) })
}

test.describe('Settings sections', () => {
  test('every section renders, in order', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Account',
      'Theme',
      'Help',
      'Priority Display',
      'Notifications',
      'Snooze',
      'Reminder periods',
      'Labels',
      'Projects',
      'API Tokens',
      'More',
      'About',
    ])
  })

  test('an auto-snooze row opens its own custom editor and saves it', async ({
    authenticatedPage: page,
  }) => {
    // Read from the page: the preferences GET doesn't return this field.
    await page.goto('/settings')
    const low = autoSnoozeRow(page, 'Low auto-snooze')
    const before = Number(await low.locator('select').inputValue())
    try {
      await low.locator('select').selectOption('custom')

      // Only this row swapped to the minutes field; the other four keep their selects.
      await expect(page.getByPlaceholder('min')).toHaveCount(1)
      await expect(low.getByPlaceholder('min')).toBeVisible()
      for (const other of ['Default', 'Medium', 'High', 'Urgent']) {
        await expect(autoSnoozeRow(page, `${other} auto-snooze`).locator('select')).toBeVisible()
      }

      await low.getByPlaceholder('min').fill('7')
      const saved = waitForPreferenceSave(page, 'auto_snooze_low_minutes')
      await low.getByRole('button', { name: 'Set' }).click()
      const response = await saved
      expect(response.ok()).toBeTruthy()
      expect(response.request().postDataJSON()).toEqual({ auto_snooze_low_minutes: 7 })
      await expect(low.locator('select')).toHaveValue('7')
    } finally {
      await setPref(page, { auto_snooze_low_minutes: before })
    }
  })

  test('the AI context field shows the saved context and tracks edits', async ({
    authenticatedPage: page,
  }) => {
    const before = await pref(page, 'ai_context')
    try {
      await setPref(page, { ai_context: 'Saved E2E context' })
      await reportAiAvailable(page)
      await page.goto('/settings')

      const field = page.getByPlaceholder(/I work from home/)
      await expect(field).toHaveValue('Saved E2E context')
      const save = page.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeDisabled()

      await field.fill('Saved E2E context, edited')
      await expect(save).toBeEnabled()
      await field.fill('Saved E2E context')
      await expect(save).toBeDisabled()
    } finally {
      await setPref(page, { ai_context: before })
    }
  })

  test('Connected App shows only inside the native wrapper', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Connected App' })).toHaveCount(0)

    await page.addInitScript(() => {
      ;(window as unknown as { __OPENTASK_IOS: boolean }).__OPENTASK_IOS = true
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Connected App' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Disconnect App' })).toBeVisible()
  })
})
