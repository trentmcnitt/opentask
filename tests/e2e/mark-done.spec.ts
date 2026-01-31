import { test, expect } from './fixtures'

test.describe('Mark done', () => {
  test('clicking done checkbox completes task and shows undo toast', async ({ authenticatedPage: page }) => {
    // Use "Prepare slides" — a one-off task that other tests don't depend on
    const doneBtn = page.getByRole('button', { name: /mark "Prepare slides" as done/i })
    await expect(doneBtn).toBeVisible({ timeout: 5000 })

    await doneBtn.click()

    // Should show a toast with "completed"
    await expect(page.getByText(/completed|Task completed/i)).toBeVisible({ timeout: 5000 })

    // Should show undo action
    await expect(page.getByText('Undo')).toBeVisible()
  })

  test('marking recurring task done shows advancement toast', async ({ authenticatedPage: page }) => {
    // Use "Evening review" — recurring daily, other tests use different recurring tasks
    const doneBtn = page.getByRole('button', { name: /advance "Evening review"/i })
    await expect(doneBtn).toBeVisible({ timeout: 5000 })

    await doneBtn.click()

    // Should show a toast about advancing
    await expect(page.getByText(/advanced|Task advanced/i)).toBeVisible({ timeout: 5000 })

    // Task should still be in the list (recurring tasks don't disappear)
    await expect(page.getByText('Evening review')).toBeVisible()
  })
})
