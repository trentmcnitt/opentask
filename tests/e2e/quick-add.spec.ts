import { test, expect } from './fixtures'

test.describe('Quick add', () => {
  test('type and Enter creates a new task', async ({ authenticatedPage: page }) => {
    // The quick-add input has placeholder "Add a task..."
    const input = page.getByRole('textbox', { name: 'Quick add task' })
    await expect(input).toBeVisible({ timeout: 5000 })

    // Type a new task
    const taskTitle = `E2E test task ${Date.now()}`
    await input.fill(taskTitle)
    await input.press('Enter')

    // It landed: the Just added card above the list names it. (Its real row
    // is in its project's group in All, which may be past that group's
    // "Show all" cap — the card is how a new task is seen without scrolling.)
    await expect(page.locator('[data-just-added-card]').getByText(taskTitle)).toBeVisible({
      timeout: 5000,
    })
    // And it is a real task in the list: the search finds its row.
    await page.getByRole('textbox', { name: 'Search tasks' }).fill(taskTitle)
    await expect(page.getByRole('link', { name: taskTitle })).toBeVisible({ timeout: 5000 })
  })
})
