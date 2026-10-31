/**
 * THE REMINDERS WIDGET'S GENERAL TAP (Trent, 2026-10-31): the widget's
 * background, 2×2 and Lock Screen taps load `/?focus=reminders`
 * (`DeepLinkRouter.remindersCardPath`, pinned by the Swift
 * DeepLinkRouterTests), which opens the dashboard with its Reminders card
 * under the top bar — not the tasks (the usual first landing), not the
 * Reminders tab. The param is consumed; the Dashboard re-tap keeps its rule
 * afterwards (at the top → the tasks, else the top).
 *
 * A phone (402), the shared user with a reminder (so the card has a row).
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

test.use({ viewport: { width: 402, height: 874 } })

/** `el`'s top on its own landing line (`scroll-margin-top`). */
async function onTheLine(el: Locator) {
  await expect
    .poll(() =>
      el.evaluate((node) => {
        const line = parseFloat(getComputedStyle(node).scrollMarginTop) || 0
        return Math.round(node.getBoundingClientRect().top - line)
      }),
    )
    .toBe(0)
}

async function room(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = 'body { padding-bottom: 3000px; }'
      document.head.append(style)
    })
  })
}

test('the widget tap lands on the Reminders card; the param goes; the re-tap rule stands', async ({
  authenticatedPage: page,
}) => {
  const res = await page.request.post('/api/tasks', {
    data: {
      title: uniqueTitle('WF thought'),
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    },
  })
  const id = (await res.json()).data.id as number
  try {
    await room(page)
    await page.goto('/?focus=reminders')
    const card = page.locator('section[data-reminders-panel]')
    await expect(card).toBeVisible()
    await onTheLine(card)
    await expect(page).toHaveURL('/')
    await page.screenshot({ path: '.tmp/screens/widget-focus-reminders-402.png' })
    // Not the tasks: the list's anchor is below the card, not on the line.
    const anchor = page.locator('[data-task-list-landing]')
    const cardBox = (await card.boundingBox())!
    expect((await anchor.boundingBox())!.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height)
    // Afterwards the re-tap rule as ever: not at the top → the top; at the top → the tasks.
    const dashboard = page.locator('nav').getByRole('link', { name: 'Dashboard', exact: true })
    if ((await page.evaluate(() => window.scrollY)) > 8) {
      await dashboard.click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    }
    await dashboard.click()
    await onTheLine(anchor)
  } finally {
    await page.request.delete(`/api/tasks/${id}`)
  }
})
