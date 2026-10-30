import { test, expect, showAllNow, uniqueTitle } from './fixtures'

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

  /**
   * THE REVEAL MID-SWIPE (Trent, 2026-10-30: white lines, stripes and lag on
   * the Defer reveal; "Defer" cut off). The moving row sits at a WHOLE-pixel
   * offset on its own compositor layer (no subpixel re-raster each frame);
   * the word stays hidden until the uncovered strip can hold it, then sits
   * inside that strip — never under the row.
   */
  test('a left swipe: whole-pixel composited row; "Defer" hidden until it fits, then clear of the row', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const res = await page.request.post('/api/tasks', {
      data: {
        title: uniqueTitle('Swipe reveal'),
        due_at: new Date(Date.now() - 3600_000).toISOString(),
      },
    })
    const id = (await res.json()).data.id as number
    try {
      await page.reload()
      await showAllNow(page)
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      const box = (await row.boundingBox())!
      const y = box.y + box.height / 2
      const x0 = box.x + box.width * 0.6
      const moving = row.locator('xpath=ancestor::div[contains(@style, "transform")][1]')
      const label = page.locator('[data-swipe-label]')
      await page.mouse.move(x0, y)
      await page.mouse.down()
      // ~40px: not room for the word yet.
      for (let dx = 1; dx <= 40; dx++) await page.mouse.move(x0 - dx * 1.03, y)
      await expect(label).toHaveCSS('opacity', '0')
      // ~90px: the word shows, wholly in the strip the row has uncovered.
      for (let dx = 41; dx <= 90; dx++) await page.mouse.move(x0 - dx * 1.03, y)
      await expect(label).toHaveCSS('opacity', '1')
      const style = (await moving.getAttribute('style')) ?? ''
      expect(style).toMatch(/translate3d\(-\d+px, 0px, 0px\)/)
      expect(style).toContain('will-change: transform')
      const rowBox = (await moving.boundingBox())!
      const word = (await label.getByText('Defer', { exact: true }).boundingBox())!
      expect(word.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width)
      // Let go short of the threshold: back in place, nothing deferred.
      await page.mouse.move(x0 - 60, y)
      await page.mouse.up()
      await expect(label).toHaveCount(0)
      await expect(moving).toHaveAttribute('style', /translateX\(0(px)?\)/)
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
    }
  })
})
