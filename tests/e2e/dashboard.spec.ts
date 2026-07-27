import { test, expect } from './fixtures'

test.describe('Dashboard', () => {
  test('tasks are displayed on the dashboard', async ({ authenticatedPage: page }) => {
    // Should see task titles from seed
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Morning routine')).toBeVisible()
  })
})

/**
 * REDESIGN-V03 §7.3 — the filter chips collapse behind one control so the front
 * door shows tasks, not a wall of chips. The collapse rules themselves are
 * documented in src/hooks/useFilterSection.ts.
 */
test.describe('Dashboard filter section', () => {
  const toggle = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: /^Filters/ })

  test('filter chips are collapsed by default and open in one click', async ({
    authenticatedPage: page,
  }) => {
    await expect(toggle(page)).toBeVisible({ timeout: 5000 })
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)

    await toggle(page).click()

    const chips = page.locator('#dashboard-filter-chips')
    await expect(chips).toBeVisible()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    // The chips the section hides are really there once opened
    await expect(chips.getByText('Overdue', { exact: false }).first()).toBeVisible()

    // ...and close again
    await toggle(page).click()
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
  })

  test('applying a filter shows a count badge on the collapsed control', async ({
    authenticatedPage: page,
  }) => {
    await toggle(page).click()
    const chips = page.locator('#dashboard-filter-chips')
    await chips.getByText('Overdue', { exact: false }).first().click()

    // Filter applied: the list is narrowed and the control carries the count
    await expect(page.getByText(/Showing \d+ of \d+ tasks/)).toBeVisible()
    await expect(toggle(page)).toContainText('1')

    // Collapsing by hand keeps the active filter legible via the badge
    await toggle(page).click()
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
    await expect(toggle(page)).toContainText('1')
  })

  test('clearing every filter drops the badge and lets the section stay closed', async ({
    authenticatedPage: page,
  }) => {
    await toggle(page).click()
    const chips = page.locator('#dashboard-filter-chips')
    await chips.getByText('Overdue', { exact: false }).first().click()
    await expect(toggle(page)).toContainText('1')

    await page.getByRole('button', { name: 'Clear filter' }).click()

    await expect(page.getByText(/Showing \d+ of \d+ tasks/)).toHaveCount(0)
    await expect(toggle(page)).toHaveText('Filters')
    // Auto-expand released, so the toggle is free to close again
    await toggle(page).click()
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
  })
})
