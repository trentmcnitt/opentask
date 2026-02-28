import { test, expect } from './fixtures'

test.describe('Snooze', () => {
  test('quick tap on overdue task triggers immediate snooze', async ({
    authenticatedPage: page,
  }) => {
    // "Reply to email" is overdue — quick-tap should instant-snooze
    await expect(page.getByText('Reply to email')).toBeVisible({ timeout: 5000 })

    // Click snooze button (force: true because it's opacity-0 until hover)
    const snoozeBtn = page.getByRole('button', { name: /snooze "Reply to email"/i })
    await snoozeBtn.click({ force: true })

    // Quick tap on overdue task triggers immediate snooze with a toast
    await expect(page.getByText(/Snoozed to .+ — "Reply to email"/)).toBeVisible({ timeout: 3000 })
    await expect(page.getByText('Undo')).toBeVisible({ timeout: 3000 })
  })

  test('quick tap on future task opens snooze menu instead of instant snooze', async ({
    authenticatedPage: page,
  }) => {
    // "Buy groceries" is future-dated — quick-tap should open menu, not instant-snooze
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })

    const snoozeBtn = page.getByRole('button', { name: /snooze "Buy groceries"/i })
    await snoozeBtn.click({ force: true })

    // Snooze menu should open instead of instant snooze
    const menu = page.getByRole('menu', { name: 'Snooze options' })
    await expect(menu).toBeVisible({ timeout: 3000 })
  })

  test('long-press opens snooze menu', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 5000 })

    // Hover the task row to make the snooze button visible
    const taskText = page.getByText('Review PRs')
    await taskText.hover()

    // Get snooze button bounding box for long-press simulation
    const snoozeBtn = page.getByRole('button', { name: /snooze "Review PRs"/i })
    await expect(snoozeBtn).toBeVisible({ timeout: 3000 })
    const box = await snoozeBtn.boundingBox()
    if (!box) throw new Error('Snooze button bounding box not found')

    // Long-press: mouse down, wait 500ms (threshold is 400ms), mouse up
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(500)
    await page.mouse.up()

    // Snooze menu (role="menu") should appear
    const menu = page.getByRole('menu', { name: 'Snooze options' })
    await expect(menu).toBeVisible({ timeout: 3000 })

    // Verify menu items
    await expect(menu.getByRole('menuitem', { name: '1 hour' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '2 hours' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Tomorrow at/ })).toBeVisible()

    // Dismiss the menu by dispatching keydown Escape directly on document.
    // The component registers its keydown listener in setTimeout(0), so wait first.
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(menu).not.toBeVisible({ timeout: 5000 })
  })
})
