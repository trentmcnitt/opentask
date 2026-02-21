import { test, expect } from './fixtures'

test.describe('Add task modal (mobile FAB)', () => {
  test('plus button opens modal and creates a task', async ({ authenticatedPage: page }) => {
    // Set mobile viewport to show the bottom tabs
    await page.setViewportSize({ width: 375, height: 812 })

    // Reload to ensure mobile layout renders correctly after viewport change.
    // Wait for task rows to confirm React hydrated and data loaded.
    // Do NOT use networkidle — the SSE sync stream keeps a connection open.
    await page.reload()
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 })

    // The bottom nav Add button should be visible on mobile
    // BottomTabs has md:hidden, so it's hidden on desktop and visible on mobile
    // Use exact match to avoid matching "Open full add form" button
    const addButton = page.getByRole('button', { name: 'Add', exact: true })
    await expect(addButton).toBeVisible({ timeout: 5000 })

    // Click the FAB
    await addButton.click()

    // Bottom sheet should open — the QuickActionPanel in create mode uses a Sheet on mobile.
    // The sheet has a visually-hidden title "New Task" for accessibility.
    const dialog = page.getByRole('dialog', { name: 'New Task' })
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Verify key elements are present: title input, priority picker, project badge
    await expect(dialog.getByLabel('Task title')).toBeVisible()
    // Priority shows as "None" by default in the QuickActionPanel picker
    await expect(dialog.getByText('None')).toBeVisible()
    // Project shows as "Inbox" badge in create mode
    await expect(dialog.getByText('Inbox')).toBeVisible()

    // Fill in a task title and submit
    const taskTitle = `E2E modal task ${Date.now()}`
    await dialog.getByLabel('Task title').fill(taskTitle)
    await dialog.getByRole('button', { name: 'Create Task' }).click()

    // Dialog should close and task should appear in the list
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 5000 })
  })
})
