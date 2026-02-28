import { test, expect } from './fixtures'

/**
 * AI feature E2E tests.
 *
 * E2E tests run without OPENTASK_AI_ENABLED set, so AI is fully disabled.
 * These tests verify graceful degradation: the app works normally and
 * AI-dependent UI elements don't render.
 */
test.describe('AI features (disabled)', () => {
  test('AI Status menu item is hidden when AI is disabled', async ({ authenticatedPage: page }) => {
    // Open the hamburger menu
    await page.getByRole('button', { name: 'Menu' }).click()

    // Settings menu item should be visible (confirms menu opened)
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()

    // AI Status menu item should NOT render when AI is disabled
    await expect(page.getByRole('menuitem', { name: 'AI Status' })).not.toBeVisible()
  })

  test('AI chip does not render when AI is disabled', async ({ authenticatedPage: page }) => {
    // Wait for initial data to load (task rows confirm hydration + data fetch).
    // Do NOT use networkidle — the SSE sync stream keeps a connection open.
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 })

    // When AI returns 503, hasData is false so the AI filter chip in FilterBar
    // doesn't render and no AI-related UI is shown.
    await expect(page.getByText('tasks highlighted')).not.toBeVisible()
  })

  test('task creation works normally without AI enrichment', async ({
    authenticatedPage: page,
  }) => {
    const taskTitle = `E2E test task ${Date.now()}`

    // Use the quick-add input to create a task
    const quickAddInput = page.getByRole('textbox', { name: 'Quick add task' })
    await expect(quickAddInput).toBeVisible({ timeout: 5000 })
    await quickAddInput.fill(taskTitle)
    await quickAddInput.press('Enter')

    // The new task should appear in the task list
    await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 10000 })
  })
})
