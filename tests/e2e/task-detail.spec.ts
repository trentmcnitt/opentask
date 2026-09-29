import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

async function createTask(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { title } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function taskTitle(page: Page, id: number): Promise<string> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data.title
}

/** Stage a title edit in the task page's panel without saving it. */
async function stageTitle(page: Page, from: string, to: string): Promise<void> {
  await page.getByText(from, { exact: true }).click()
  const titleInput = page.locator('textarea').first()
  await titleInput.fill(to)
  await titleInput.press('Enter')
  await expect(page.getByText(to, { exact: true })).toBeVisible()
}

test.describe('Task detail', () => {
  test('clicking task title navigates to detail page with fields visible', async ({
    authenticatedPage: page,
  }) => {
    const taskLink = page.getByRole('link', { name: 'Review PRs' })
    await expect(taskLink).toBeVisible({ timeout: 5000 })
    await taskLink.click()

    // Should navigate to task detail page
    await page.waitForURL(/\/tasks\/\d+/, { timeout: 5000 })

    // Should see the task title (rendered as paragraph in QuickActionPanel)
    await expect(page.getByText('Review PRs')).toBeVisible()

    // In editable mode, QuickActionPanel shows interactive buttons for task fields
    // Verify project button (shows "Work" from seed data) and priority button are visible
    await expect(page.getByRole('button', { name: 'Work' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'High' })).toBeVisible()

    // Navigate back
    await page.goBack()
    await page.waitForURL('/', { timeout: 5000 })
  })

  test('edit title on detail page persists after reload', async ({ authenticatedPage: page }) => {
    // Navigate to "Buy groceries" detail
    const taskLink = page.getByRole('link', { name: 'Buy groceries' })
    await expect(taskLink).toBeVisible({ timeout: 5000 })
    await taskLink.click()
    await page.waitForURL(/\/tasks\/\d+/, { timeout: 5000 })

    // Click on the title to enter edit mode (rendered as paragraph in QuickActionPanel)
    const titleText = page.getByText('Buy groceries')
    await expect(titleText).toBeVisible({ timeout: 3000 })
    await titleText.click()

    // The title should become an editable textarea (prominent variant uses textarea)
    const titleInput = page.locator('textarea').first()
    await expect(titleInput).toBeVisible({ timeout: 3000 })

    // Clear and type new title
    await titleInput.fill('Buy organic groceries')
    await titleInput.press('Enter')

    // Verify the title shows in the UI (staged but not yet saved)
    await expect(page.getByText('Buy organic groceries')).toBeVisible({
      timeout: 3000,
    })

    // Click Save to persist the change, wait for the save toast before reloading
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Renamed', { exact: false })).toBeVisible({ timeout: 5000 })

    // Reload to verify persistence
    await page.reload()
    await expect(page.getByText('Buy organic groceries')).toBeVisible({
      timeout: 5000,
    })
  })

  /*
   * Leaving with unsaved edits asks first; "Save" must store the edit BEFORE
   * the page goes, and a save that fails must keep the user (and the edit)
   * on the page.
   */
  test('save-and-leave stores the edit before the next page loads', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, 'Leave-with-save probe')
    try {
      await page.goto(`/tasks/${id}`)
      await stageTitle(page, 'Leave-with-save probe', 'Leave-with-save probe, renamed')

      await page.getByRole('button', { name: 'Back to dashboard' }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Unsaved Changes' })
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForURL('/')

      // Not polled: the page may only leave once the PATCH has landed, so the
      // new title is already stored by the time the dashboard loads.
      expect(await taskTitle(page, id)).toBe('Leave-with-save probe, renamed')
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a failed save-and-leave stays on the page with the edit', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, 'Failed-save probe')
    try {
      await page.goto(`/tasks/${id}`)
      await stageTitle(page, 'Failed-save probe', 'Failed-save probe, renamed')

      // Refuse the save once.
      await page.route(`**/api/tasks/${id}`, (route) =>
        route.request().method() === 'PATCH'
          ? route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'The server said no', code: 'INTERNAL_ERROR' }),
            })
          : route.fallback(),
      )

      await page.getByRole('button', { name: 'Back to dashboard' }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Unsaved Changes' })
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()

      await expect(page.getByText('The server said no')).toBeVisible()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText('Changes saved')).toHaveCount(0)
      expect(await taskTitle(page, id)).toBe('Failed-save probe')

      // Still here, edit still staged: the panel's own Save now stores it.
      await page.unroute(`**/api/tasks/${id}`)
      await expect(page).toHaveURL(`/tasks/${id}`)
      await expect(page.getByText('Failed-save probe, renamed', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => taskTitle(page, id)).toBe('Failed-save probe, renamed')
      await expect(page).toHaveURL(`/tasks/${id}`)
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
