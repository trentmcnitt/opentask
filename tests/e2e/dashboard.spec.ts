import { test, expect } from './fixtures'

test.describe('Dashboard', () => {
  test('tasks are displayed on the dashboard', async ({ authenticatedPage: page }) => {
    // Should see task titles from seed
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Morning routine')).toBeVisible()
  })

  test('toggle grouping mode changes layout', async ({ authenticatedPage: page }) => {
    // Find and click the grouping toggle button
    const toggleBtn = page.getByRole('button', { name: /group by/i })
    await expect(toggleBtn).toBeVisible()

    // Click to switch grouping mode
    await toggleBtn.click()
    await expect(page.getByText('Buy groceries')).toBeVisible()

    // Click again to switch back
    await toggleBtn.click()

    // Tasks should still be visible after toggling
    await expect(page.getByText('Buy groceries')).toBeVisible()
  })
})
