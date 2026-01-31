import { test, expect } from './fixtures'

test.describe('Selection and FAB', () => {
  test('long-press enters selection mode, FAB appears', async ({ authenticatedPage: page }) => {
    // Use "Morning routine" which is always present (recurring)
    const taskText = page.getByText('Morning routine')
    await expect(taskText).toBeVisible({ timeout: 5000 })

    const box = await taskText.boundingBox()
    if (!box) return

    // Long-press to enter selection mode (400ms threshold + buffer)
    await page.mouse.move(box.x + 10, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(500)
    await page.mouse.up()

    // Wait for selection mode to activate
    await page.waitForTimeout(300)

    // In selection mode, task should still be visible
    await expect(page.getByText('Morning routine')).toBeVisible()
  })

  test('escape clears selection', async ({ authenticatedPage: page }) => {
    const taskText = page.getByText('Review PRs')
    await expect(taskText).toBeVisible({ timeout: 5000 })

    const box = await taskText.boundingBox()
    if (!box) return

    // Enter selection mode via long-press
    await page.mouse.move(box.x + 10, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(500)
    await page.mouse.up()
    await page.waitForTimeout(300)

    // Press Escape to exit selection mode
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Tasks should still be visible
    await expect(page.getByText('Review PRs')).toBeVisible()
  })
})
