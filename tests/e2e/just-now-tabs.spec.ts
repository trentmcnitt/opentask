/**
 * THE JUST NOW CARD ON THE REMINDERS AND QUOTAS TABS (Trent, 2026-11-12:
 * "if you add a reminder, you need to see the enrichment progress the same
 * way on the Reminders tab. Likewise for the Quotas tab"): the dashboard's
 * card (`JustAddedCard`) under each tab's add control, listing that tab's
 * kind — the new item at once, "AI is filling in details…" while enrichment
 * runs, then where it landed (`SurfaceJustAdded`).
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

async function post(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}
async function cleanup(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}
const card = (page: Page) => page.locator('[data-just-added-card]')
const entry = (page: Page, id: number) => page.locator(`[data-just-added-entry="${id}"]`)

test.describe('Just now on the Reminders tab', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a typed reminder is in the card at once; one being enriched says so; only reminders; Clear', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      // What a quick add or a Shortcut leaves while the AI works on it — and
      // not today's (weekly, on a day that is not today), so its row is behind
      // the "Not today" fold: the card is the only place it shows.
      const notToday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][(new Date().getUTCDay() + 2) % 7]
      const working = await post(page, {
        title: uniqueTitle('JN tab working'),
        is_reminder: true,
        rrule: `FREQ=WEEKLY;BYDAY=${notToday};BYHOUR=7;BYMINUTE=0`,
        labels: ['ai-to-process'],
      })
      ids.push(working)
      // A task and a quota added meanwhile are not this tab's.
      const task = await post(page, { title: uniqueTitle('JN tab task'), enrich: false })
      const quota = await post(page, {
        title: uniqueTitle('JN tab quota'),
        is_tracked: true,
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
      })
      ids.push(task, quota)

      await page.goto('/reminders')
      await expect(entry(page, working)).toContainText('AI is filling in details')
      await expect(entry(page, working)).toHaveAttribute('data-just-added-item', 'reminder')
      await expect(entry(page, task)).toHaveCount(0)
      await expect(entry(page, quota)).toHaveCount(0)

      // Typed into the tab's own add box: listed at once, under the box.
      const typed = uniqueTitle('JN tab typed')
      const input = page.getByRole('textbox', { name: 'Add a reminder' })
      await input.fill(typed)
      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/tasks') && r.request().method() === 'POST',
      )
      await input.press('Enter')
      const id = (await (await created).json()).data.id as number
      ids.push(id)
      await expect(entry(page, id)).toContainText(typed)
      // Where it landed: its period and rhythm, once nothing is working on it.
      await expect(entry(page, id)).toContainText('· Daily')
      const box = (await input.boundingBox())!
      const cardBox = (await card(page).boundingBox())!
      expect(cardBox.y).toBeGreaterThan(box.y)

      // Searching hides the card; clearing brings it back.
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await page.getByRole('textbox', { name: 'Search reminders' }).fill('JN tab')
      await expect(card(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Close search' }).click()
      await expect(entry(page, id)).toBeVisible()

      // A tap opens its details; back, Clear empties the card.
      await entry(page, id).click()
      await page.waitForURL(`/tasks/${id}`)
      await page.goto('/reminders')
      await card(page).getByRole('button', { name: 'Clear' }).click()
      await expect(card(page)).toHaveCount(0)
    } finally {
      await cleanup(page, ids)
    }
  })
})

test.describe('Just now on the Quotas tab', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a new quota is in the card with its count; one being enriched says so; only quotas', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      const working = await post(page, {
        title: uniqueTitle('JN tab quota working'),
        is_tracked: true,
        progress_target: 3,
        rrule: 'FREQ=WEEKLY',
        labels: ['ai-to-process'],
      })
      const reminder = await post(page, {
        title: uniqueTitle('JN tab reminder'),
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      })
      ids.push(working, reminder)
      await page.goto('/quotas')
      await expect(entry(page, working)).toContainText('AI is filling in details')
      await expect(entry(page, working)).toHaveAttribute('data-just-added-item', 'quota')
      await expect(entry(page, reminder)).toHaveCount(0)

      // One added while the tab is open (the API, a Shortcut, the form): the
      // sync stream brings it into the card, saying where it landed.
      const done = await post(page, {
        title: uniqueTitle('JN tab quota new'),
        is_tracked: true,
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
      })
      ids.push(done)
      await expect(entry(page, done)).toContainText('2 a week')

      await card(page).getByRole('button', { name: 'Clear' }).click()
      await expect(card(page)).toHaveCount(0)
    } finally {
      await cleanup(page, ids)
    }
  })
})
