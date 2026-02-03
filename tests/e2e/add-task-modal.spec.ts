import { test, expect } from './fixtures'

test.describe('Add task modal (mobile FAB)', () => {
  test('plus button opens modal and creates a task', async ({ authenticatedPage: page }) => {
    // Set mobile viewport to show the bottom tabs
    await page.setViewportSize({ width: 375, height: 812 })

    // Reload to ensure mobile layout renders correctly after viewport change
    await page.reload()
    await page.waitForLoadState('networkidle')

    // The bottom nav Add button should be visible on mobile
    // BottomTabs has md:hidden, so it's hidden on desktop and visible on mobile
    // Use exact match to avoid matching "Open full add form" button
    const addButton = page.getByRole('button', { name: 'Add', exact: true })
    await expect(addButton).toBeVisible({ timeout: 5000 })

    // Click the FAB
    await addButton.click()

    // Dialog should open without errors
    const dialog = page.getByRole('dialog', { name: 'New Task' })
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Verify key form elements are present
    await expect(dialog.getByLabel('Title')).toBeVisible()
    await expect(dialog.getByText('Project', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Priority', { exact: true })).toBeVisible()

    // Fill in a task title and submit
    const taskTitle = `E2E modal task ${Date.now()}`
    await dialog.getByLabel('Title').fill(taskTitle)
    await dialog.getByRole('button', { name: 'Create Task' }).click()

    // Dialog should close and task should appear in the list
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 5000 })
  })
})
