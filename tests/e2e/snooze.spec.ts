import { test, expect } from './fixtures'

test.describe('Snooze', () => {
  test('snooze via clock icon opens sheet with presets', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })

    const snoozeBtn = page.getByRole('button', { name: /snooze "Buy groceries"/i })
    await snoozeBtn.click({ force: true })

    // Snooze sheet dialog should appear with QuickActionPanel preset grid
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Verify snooze UI elements are present
    // Preset labels use abbreviated form: "+1 hr" not "+1 hour"
    await expect(dialog.getByRole('button', { name: '+1 hr' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '+1 day' })).toBeVisible()

    // Verify the title shows the task name
    await expect(dialog.getByText('Buy groceries')).toBeVisible()

    // Close without snoozing
    await dialog.getByRole('button', { name: /close/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
  })

  test('snooze sheet shows time presets', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 5000 })

    const snoozeBtn = page.getByRole('button', { name: /snooze "Review PRs"/i })
    await snoozeBtn.click({ force: true })

    // Snooze sheet dialog should appear with QuickActionPanel
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Verify preset time buttons are visible (use exact match within dialog)
    await expect(dialog.getByRole('button', { name: '9:00 AM' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '12:00 PM' })).toBeVisible()

    // Verify increment buttons are visible
    await expect(dialog.getByRole('button', { name: '+30 min' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '+1 day' })).toBeVisible()

    // Close the dialog without making changes
    await dialog.getByRole('button', { name: /close/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
  })
})
