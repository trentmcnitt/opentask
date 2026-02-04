import { test, expect } from './fixtures'

test.describe('Task detail', () => {
  test('clicking task title navigates to detail page with fields visible', async ({
    authenticatedPage: page,
  }) => {
    const taskLink = page.getByRole('link', { name: 'Review PRs' })
    await expect(taskLink).toBeVisible({ timeout: 5000 })
    await taskLink.click()

    // Should navigate to task detail page
    await page.waitForURL(/\/tasks\/\d+/, { timeout: 5000 })

    // Should see the task title (rendered as paragraph in QuickActionPanel)
    await expect(page.getByText('Review PRs')).toBeVisible()

    // In editable mode, QuickActionPanel shows interactive buttons for task fields
    // Verify project button (shows "Work" from seed data) and priority button are visible
    await expect(page.getByRole('button', { name: 'Work' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'High' })).toBeVisible()

    // Navigate back
    await page.goBack()
    await page.waitForURL('/', { timeout: 5000 })
  })

  test('edit title on detail page persists after reload', async ({ authenticatedPage: page }) => {
    // Navigate to "Buy groceries" detail
    const taskLink = page.getByRole('link', { name: 'Buy groceries' })
    await expect(taskLink).toBeVisible({ timeout: 5000 })
    await taskLink.click()
    await page.waitForURL(/\/tasks\/\d+/, { timeout: 5000 })

    // Click on the title to enter edit mode (rendered as paragraph in QuickActionPanel)
    const titleText = page.getByText('Buy groceries')
    await expect(titleText).toBeVisible({ timeout: 3000 })
    await titleText.click()

    // The title should become an editable textbox
    const titleInput = page.locator('input').first()
    await expect(titleInput).toBeVisible({ timeout: 3000 })

    // Clear and type new title
    await titleInput.fill('Buy organic groceries')
    await titleInput.press('Enter')

    // Verify the title updated
    await expect(page.getByText('Buy organic groceries')).toBeVisible({
      timeout: 3000,
    })

    // Reload to verify persistence
    await page.reload()
    await expect(page.getByText('Buy organic groceries')).toBeVisible({
      timeout: 5000,
    })
  })
})
