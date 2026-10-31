/**
 * OPENING A MENU MOVES NOTHING (Trent's Mac, 2026-10-31): opening the
 * bottom-left view pill's menu shifted the right column and the header icons
 * by 8–15px. Radix's scroll lock gives <body> a right margin the width of the
 * scrollbar to make up for hiding it — but <html> keeps its scrollbar's room
 * (`scrollbar-gutter: stable`) and, being `overflow-x: clip`, never hands the
 * lock's `overflow: hidden` to the viewport, so the margin moved the page by
 * a scrollbar's width. Here the view pill's menu and a row's target menu open
 * on a long page (a real scrollbar), and the page doesn't move.
 *
 * Its own user (`queue@opentask.local`, the switch on: the pill shows), a
 * short window so the page scrolls. Unique titles, trashed in `finally`.
 */
import { test, expect, openModeMenu, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

/** Where landmarks are: the header's last icon and the main column's first card. */
async function positions(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const at = (sel: string) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : -1
    }
    return [at('header button:last-of-type'), at('main'), at('[data-mode-pill]')]
  })
}

async function expectStill(page: Page, before: number[], open: () => Promise<Locator>) {
  const opened = await open()
  await expect(opened).toBeVisible()
  expect(await positions(page)).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(opened).toBeHidden()
}

test.use({ viewport: { width: 1600, height: 480 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
    window.localStorage.setItem('opentask_dashboard_mode', 'all')
  })
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('the view menu and a target menu open without moving the page', async ({ page }) => {
  const ids: number[] = []
  for (let i = 0; i < 6; i++) {
    const res = await page.request.post('/api/tasks', {
      data: {
        title: uniqueTitle(`MS long page ${i}`),
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    ids.push((await res.json()).data.id as number)
  }
  try {
    await page.goto('/')
    // A classic, always-on scrollbar, as on Trent's Mac (headless browsers
    // draw overlay scrollbars, 0px wide, which can't shift anything).
    await page.addStyleTag({
      content: '::-webkit-scrollbar{width:15px}::-webkit-scrollbar-thumb{background:#999}',
    })
    await expect(page.locator('[data-mode-pill]')).toBeVisible()
    // A real scrollbar: the page is taller than the window.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
    ).toBe(true)
    const before = await positions(page)
    expect(before.every((x) => x >= 0)).toBe(true)
    await expectStill(page, before, () => openModeMenu(page))
    const chip = page.locator('[data-target-time]').first()
    if (await chip.count()) {
      await expectStill(page, before, async () => {
        await chip.click()
        return page.getByRole('menu')
      })
    }
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
