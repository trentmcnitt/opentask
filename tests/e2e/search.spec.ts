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
    await expect(page.getByText(/result/i)).toBeVisible({ timeout: 5000 })

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

    // Should see other tasks again after clearing
    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 5000 })
  })

  /**
   * Regression: search hits used to be rendered from their own fetched copy,
   * so acting on one never touched the list you were looking at. Completing a
   * task from the results left it sitting there until the query was re-run.
   * These two assert the results are a live view of the task list — without
   * re-searching.
   */
  test('completing a task from the results removes it without re-searching', async ({
    authenticatedPage: page,
  }) => {
    // Create the subject rather than borrowing a seeded task: this test
    // completes it, and every spec here shares one database.
    const title = `Zarquon search subject ${Date.now()}`
    const quickAdd = page.getByRole('textbox', { name: 'Quick add task' })
    await expect(quickAdd).toBeVisible({ timeout: 5000 })
    await quickAdd.fill(title)
    await quickAdd.press('Enter')
    await expect(page.getByText(title)).toBeVisible({ timeout: 5000 })

    const searchInput = page.getByRole('textbox', { name: 'Search tasks' })
    await searchInput.fill('Zarquon')
    await expect(page.getByText('1 result for “Zarquon”')).toBeVisible({ timeout: 5000 })

    await page.getByRole('button', { name: `Mark "${title}" as done` }).click()

    // The query is still active — the row and the count both update in place
    await expect(page.getByText('0 results for “Zarquon”')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(title)).toHaveCount(0)
    await expect(searchInput).toHaveValue('Zarquon')
  })

  test('advancing a recurring task from the results keeps it in the list', async ({
    authenticatedPage: page,
  }) => {
    // Negative control for the test above: rendering the results out of the
    // live task list must not drop a row that is still there, only one that
    // genuinely left. "Weekly standup" is used by no other spec.
    const searchInput = page.getByRole('textbox', { name: 'Search tasks' })
    await expect(searchInput).toBeVisible({ timeout: 3000 })

    await searchInput.fill('standup')
    await expect(page.getByText('1 result for “standup”')).toBeVisible({ timeout: 5000 })

    await page.getByRole('button', { name: 'Advance "Weekly standup" to next occurrence' }).click()

    await expect(page.getByText(/advanced/i)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('1 result for “standup”')).toBeVisible()
    await expect(page.getByText('Weekly standup')).toBeVisible()
  })
})
