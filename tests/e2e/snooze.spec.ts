import {
  test,
  expect,
  holdUntil,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'

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

    const snoozeBtn = page.getByRole('button', { name: /snooze "Review PRs"/i })
    await expect(snoozeBtn).toBeVisible({ timeout: 3000 })

    // Long-press: hold until the menu opens, not for a hand-timed interval
    // (the 400ms threshold under CI load made a timed hold read as a tap).
    const menu = page.getByRole('menu', { name: 'Snooze options' })
    await holdUntil(snoozeBtn, () => expect(menu).toBeVisible({ timeout: 3000 }))

    // Verify menu items
    await expect(menu.getByRole('menuitem', { name: '1 hour' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '2 hours' })).toBeVisible()
    // The user's time slots are targets too (Trent, 2026-09-22), each labelled
    // with where it lands: "Midday · 12:00 PM", or "… · tomorrow …" once begun.
    // Whichever slot starts next leads the menu as "Next period · Midday 12:00 PM"
    // (#106), so each slot may appear in either form depending on the hour.
    const slotItem = (name: string, time: string) =>
      menu.getByRole('menuitem', {
        name: new RegExp(
          `^(Next period · ${name} (tomorrow )?${time}|${name} · (tomorrow )?${time})$`,
        ),
      })
    await expect(slotItem('Midday', '12:00 PM')).toBeVisible()
    await expect(slotItem('Evening', '8:30 PM')).toBeVisible()
    // Tomorrow morning is always offered: as "Tomorrow at 9:00 AM", or as the
    // time slot that already lands there.
    await expect(menu.getByRole('menuitem', { name: /tomorrow( at)? 9:00 AM$/i })).toBeVisible()

    // Dismiss with Escape. The menu registers its keydown listener in a
    // setTimeout(0) after opening, so an Escape can arrive first; toPass
    // re-sends until the listener is there, rather than a guessed sleep.
    await expect(async () => {
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await expect(menu).not.toBeVisible({ timeout: 500 })
    }).toPass({ timeout: 5000 })
    await expect(menu).not.toBeVisible({ timeout: 5000 })
  })
})

/**
 * A right-click on a row's snooze button is not a tap. The button used its own
 * copy of the long-press timer, which read any pointerdown/pointerup pair as a
 * press — so a right-click snoozed the task. It now shares
 * `useSimpleLongPress`, which counts the primary button only.
 *
 * Proved by what follows: a plain click on the same button sends exactly one
 * snooze, so the right-click before it sent none.
 */
test.describe('Row snooze button', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('a right-click does not snooze the task', async ({ authenticatedPage: page }) => {
    const title = uniqueTitle('Row right-click probe')
    const res = await page.request.post('/api/tasks', {
      data: {
        title,
        priority: 1,
        due_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    })
    expect(res.ok()).toBeTruthy()
    const id = (await res.json()).data.id as number
    const snoozes: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/api/tasks/${id}/snooze`))
        snoozes.push(r.url())
    })

    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        await row.hover()
        const snoozeBtn = row.getByRole('button', { name: `Snooze "${title}"` })
        await expect(snoozeBtn).toBeVisible()

        await snoozeBtn.click({ button: 'right' })
        await expect(page.getByRole('menu', { name: 'Snooze options' })).toHaveCount(0)

        const sent = page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tasks/${id}/snooze`),
        )
        await snoozeBtn.click()
        expect((await sent).ok()).toBeTruthy()
        expect(snoozes).toHaveLength(1)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
