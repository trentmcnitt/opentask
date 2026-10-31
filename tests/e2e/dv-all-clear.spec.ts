/**
 * TODAY'S ALL-CLEAR CARD (Trent, 2026-10-30, E2 of `.tmp/all-done/`,
 * `AllClearCard`): with Late and Today both empty, Today shows "All clear for
 * today", what happened today ("1 done · 1 moved to tomorrow", from
 * `GET /api/tasks/today-summary`), and "Next: …"; On deck carries on below.
 * Scan and All never show it.
 *
 * Its own user (`queue@opentask.local`, no seeded tasks), the switch on, lean
 * rows, Today. Other files' work for this user today can add to the counts,
 * so the counts line is checked against the summary the server gives.
 * Unique titles; every task trashed in `finally`.
 */
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** The counts line the card should show, from the server's summary. */
async function expectedCounts(page: Page): Promise<string | null> {
  const { done, moved } = (await (await page.request.get('/api/tasks/today-summary')).json())
    .data as { done: number; moved: number }
  const parts = [done ? `${done} done` : null, moved ? `${moved} moved to tomorrow` : null]
  return parts.filter(Boolean).join(' · ') || null
}

const card = (page: Page) => page.locator('[data-all-clear]')

test.describe.configure({ mode: 'serial' })
test.use({ colorScheme: 'dark' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
    window.localStorage.setItem('opentask_dashboard_mode', 'today')
  })
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

for (const width of [375, 402]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 874 } })

    test('nothing due today: All clear, no counts line unless the day had some', async ({
      page,
    }) => {
      await page.goto('/')
      await expect(card(page)).toBeVisible()
      await expect(card(page)).toContainText('All clear for today')
      // One all-clear message: not the empty list's "All caught up!" too.
      await expect(page.getByText('All caught up!')).toHaveCount(0)
      const counts = await expectedCounts(page)
      if (counts) await expect(card(page).locator('[data-all-clear-counts]')).toHaveText(counts)
      else await expect(card(page).locator('[data-all-clear-counts]')).toHaveCount(0)
      await page.screenshot({
        path: `.tmp/screens/all-clear-zero-${width}.png`,
        animations: 'disabled',
      })
    })

    test('one done and one moved to tomorrow: the counts and the Next line', async ({ page }) => {
      const now = DateTime.now().setZone(TZ)
      const tomorrow = await openTaskDay(page, 1)
      const done = await create(page, {
        title: uniqueTitle('AC done'),
        due_at: now.minus({ hours: 2 }).toUTC().toISO(),
      })
      const moved = await create(page, {
        title: uniqueTitle('AC moved'),
        due_at: now.minus({ hours: 1 }).toUTC().toISO(),
      })
      const ids = [done, moved]
      try {
        await page.goto('/')
        // Both are Late: no card yet.
        await expect(page.locator(`[data-lean-row="${done}"]`)).toBeVisible()
        await expect(card(page)).toHaveCount(0)
        expect((await page.request.post(`/api/tasks/${done}/done`)).ok()).toBeTruthy()
        const at = DateTime.fromISO(`${tomorrow}T10:00`, { zone: TZ }).toUTC().toISO()
        expect(
          (await page.request.patch(`/api/tasks/${moved}`, { data: { due_at: at } })).ok(),
        ).toBeTruthy()
        await page.reload()
        await expect(card(page)).toBeVisible()
        const counts = (await expectedCounts(page))!
        expect(counts).toMatch(/\d+ done · \d+ moved to tomorrow/)
        await expect(card(page).locator('[data-all-clear-counts]')).toHaveText(counts)
        await expect(card(page).locator('[data-all-clear-next]')).toContainText(/^Next: .*target/)
        await page.screenshot({
          path: `.tmp/screens/all-clear-counts-${width}.png`,
          animations: 'disabled',
        })

        // The counts open the same rows (Trent, 11:18 PM): done struck through
        // with its time, moved with where it went.
        const toggle = card(page).locator('[data-all-clear-counts]')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        const items = card(page).locator('[data-all-clear-items]')
        const doneItem = items.locator('[data-all-clear-item="done"]', { hasText: 'AC done' })
        await expect(doneItem).toContainText(/Done \d{1,2}:\d{2} [AP]M/)
        await expect(doneItem.locator('.line-through')).toHaveCount(1)
        await expect(
          items.locator('[data-all-clear-item="moved"]', { hasText: 'AC moved' }),
        ).toContainText('Moved to tomorrow 10:00 AM')

        // Room at the bottom: scrolled to the end, the card clears the view pill.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        const pill = (await page.locator('[data-mode-pill]').boundingBox())!
        const end = (await card(page).boundingBox())!
        expect(end.y + end.height).toBeLessThanOrEqual(pill.y)
        await page.screenshot({
          path: `.tmp/screens/all-clear-open-${width}.png`,
          animations: 'disabled',
        })
      } finally {
        await trash(page, ids)
      }
    })

    test('On deck carries on below the card; Scan and All never show it', async ({ page }) => {
      const today = await openTaskDay(page, 0)
      const ids = [
        await create(page, { title: uniqueTitle('AC deck one') }),
        await create(page, { title: uniqueTitle('AC deck two') }),
      ]
      try {
        expect(
          (await page.request.post('/api/tasks/deck', { data: { ids, day: today } })).ok(),
        ).toBeTruthy()
        await page.goto('/')
        await expect(card(page)).toBeVisible()
        const deck = page.locator('section[data-mode-section="on-deck"]')
        await expect(deck).toBeVisible()
        const cardBox = (await card(page).boundingBox())!
        expect((await deck.boundingBox())!.y).toBeGreaterThan(cardBox.y + cardBox.height - 1)
        await page.screenshot({
          path: `.tmp/screens/all-clear-deck-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        })
        for (const mode of ['pick-mode', 'all']) {
          await page.goto(`/?mode=${mode}`)
          await expect(page.locator(`[data-mode-pill="${mode}"]`)).toBeVisible()
          await expect(card(page)).toHaveCount(0)
        }
      } finally {
        await trash(page, ids)
      }
    })
  })
}
