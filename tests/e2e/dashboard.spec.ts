import { test, expect } from './fixtures'

test.describe('Dashboard', () => {
  test('tasks are displayed on the dashboard', async ({ authenticatedPage: page }) => {
    // Should see task titles from seed
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Morning routine')).toBeVisible()
  })

  test('toggle grouping mode changes layout', async ({ authenticatedPage: page }) => {
    // The grouping toggle is now inside the hamburger menu
    const menuBtn = page.getByRole('button', { name: 'Menu' })
    await expect(menuBtn).toBeVisible()

    // Open menu and click "Group by" option
    await menuBtn.click()
    const groupByItem = page.getByRole('menuitem', { name: /group by/i })
    await expect(groupByItem).toBeVisible()
    await groupByItem.click()

    // Tasks should still be visible after toggling
    await expect(page.getByText('Buy groceries')).toBeVisible()

    // Toggle again
    await menuBtn.click()
    await page.getByRole('menuitem', { name: /group by/i }).click()
    await expect(page.getByText('Buy groceries')).toBeVisible()
  })
})
