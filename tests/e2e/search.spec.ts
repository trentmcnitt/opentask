import { test, expect } from './fixtures'

test.describe('Search', () => {
  test('search filters task list, clear restores it', async ({ authenticatedPage: page }) => {
    // Verify initial tasks are visible
    await expect(page.getByText('Morning routine')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Review PRs')).toBeVisible()

    // The search input is already visible (textbox "Search tasks")
    const searchInput = page.getByRole('textbox', { name: 'Search tasks' })
    await expect(searchInput).toBeVisible({ timeout: 3000 })

    // Search for "standup" — matches "Weekly standup" which no other test mutates
    await searchInput.fill('standup')

    // Wait for debounce and results
    await page.waitForTimeout(500)

    // Should show results count
    await expect(page.getByText(/result/i)).toBeVisible({ timeout: 3000 })

    // Should see Weekly standup
    await expect(page.getByText('Weekly standup')).toBeVisible()

    // Clear search via the clear button
    const clearBtn = page.getByRole('button', { name: /clear search/i })
    if (await clearBtn.isVisible()) {
      await clearBtn.click()
    } else {
      // Fallback: clear the input manually
      await searchInput.fill('')
    }

    // Wait for list to restore
    await page.waitForTimeout(500)

    // Should see other tasks again
    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 3000 })
  })
})
