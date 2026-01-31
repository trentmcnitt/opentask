import { test, expect } from './fixtures'

test.describe('Snooze', () => {
  test('snooze via clock icon opens sheet with presets', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })

    const snoozeBtn = page.getByRole('button', { name: /snooze "Buy groceries"/i })
    await snoozeBtn.click({ force: true })

    // Snooze sheet dialog should appear
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 })
    await expect(page.getByText('+1 hour')).toBeVisible()

    // Click +1 hour preset
    await page.getByText('+1 hour').click()

    // Should show snoozed toast — use the toast container to be specific
    // The toast says "Task snoozed" and has an Undo button
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 5000 })
  })

  test('custom datetime picker in snooze sheet', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 5000 })

    const snoozeBtn = page.getByRole('button', { name: /snooze "Review PRs"/i })
    await snoozeBtn.click({ force: true })

    // Snooze sheet dialog should appear
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 })
    await page.getByText('Pick date & time').click()

    // Should show datetime input
    const datetimeInput = page.locator('input[type="datetime-local"]')
    await expect(datetimeInput).toBeVisible()

    // Close the sheet
    await page.getByRole('button', { name: /close/i }).click()
  })
})
