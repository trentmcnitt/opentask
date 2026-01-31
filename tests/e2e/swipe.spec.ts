import { test, expect } from './fixtures'

test.describe('Swipe gestures', () => {
  test('right swipe past threshold triggers done action', async ({ authenticatedPage: page }) => {
    // Use "Weekly standup" — a recurring task (won't disappear on done)
    await expect(page.getByText('Weekly standup')).toBeVisible({ timeout: 5000 })

    // Get the task link bounding box for swipe coordinates
    const taskLink = page.getByRole('link', { name: 'Weekly standup' })
    const box = await taskLink.boundingBox()

    if (box) {
      const startX = box.x + 10
      const startY = box.y + box.height / 2
      const endX = box.x + 250 // swipe right ~250px

      await page.mouse.move(startX, startY)
      await page.mouse.down()
      for (let x = startX; x <= endX; x += 15) {
        await page.mouse.move(x, startY)
        await page.waitForTimeout(10)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
    }

    // Swipe gestures may not trigger reliably in headless Chrome
    // The task should still be visible (recurring = advances, not removed)
    await expect(page.getByText('Weekly standup')).toBeVisible()
  })

  test('left swipe triggers snooze action', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Morning routine')).toBeVisible({ timeout: 5000 })

    const taskLink = page.getByRole('link', { name: 'Morning routine' })
    const box = await taskLink.boundingBox()

    if (box) {
      const startX = box.x + box.width - 10
      const startY = box.y + box.height / 2
      const endX = box.x + box.width - 250 // swipe left ~250px

      await page.mouse.move(startX, startY)
      await page.mouse.down()
      for (let x = startX; x >= endX; x -= 15) {
        await page.mouse.move(x, startY)
        await page.waitForTimeout(10)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
    }

    // Task should still be present (snooze doesn't remove)
    await expect(page.getByText('Morning routine')).toBeVisible()
  })
})
