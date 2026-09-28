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

    // Wait for the task to appear in the list (its row's title link — the
    // just-added preview above the list shows the same title as plain text)
    await expect(page.getByRole('link', { name: taskTitle })).toBeVisible({ timeout: 5000 })
  })
})
