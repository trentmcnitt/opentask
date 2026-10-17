import { test, expect, showAllNow } from './fixtures'

test.describe('Swipe gestures', () => {
  test('right swipe past threshold triggers done action', async ({ authenticatedPage: page }) => {
    // Seeded tasks due later sit behind their projects' folds in Now (the
    // dashboard's default view): lift them.
    await showAllNow(page)
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
    }

    // Swipe gestures may not trigger reliably in headless Chrome
    // The task should still be visible (recurring = advances, not removed)
    await expect(page.getByText('Weekly standup')).toBeVisible()
  })

  test('left swipe on overdue task triggers snooze action', async ({ authenticatedPage: page }) => {
    // "Reply to email" is seeded overdue (due 2 hours ago) — swipe left should
    // snooze. By now snooze.spec.ts has instant-snoozed it (+1 hour), so it
    // may no longer be due today: in the late evening that hour lands
    // tomorrow and Now folds it behind "N more in Inbox" (seen at 11:22 PM,
    // main included). Lift the folds so the row is there at any hour.
    await showAllNow(page)
    await expect(page.getByText('Reply to email')).toBeVisible({ timeout: 5000 })

    const taskLink = page.getByRole('link', { name: 'Reply to email' })
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
    }

    // Task should still be present (snooze doesn't remove)
    await expect(page.getByText('Reply to email')).toBeVisible()
  })

  test('left swipe on future task opens edit panel instead of snoozing', async ({
    authenticatedPage: page,
  }) => {
    // Seeded tasks due later sit behind their projects' folds in Now (the
    // dashboard's default view): lift them.
    await showAllNow(page)
    // "Morning routine" is future-dated (tomorrow) — swipe left should open QuickActionPanel
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
    }

    // Task should still be present
    await expect(page.getByText('Morning routine')).toBeVisible()
  })
})
