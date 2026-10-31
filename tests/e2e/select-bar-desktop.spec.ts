/**
 * THE SELECT BAR AT DESKTOP WIDTHS (Trent's Mac, 2026-10-31): a task-queue row
 * picked in the right column showed the bar as a clipped fragment between the
 * two columns — the Mac app's WKWebView clipped the fixed bar to the sticky
 * column it was rendered in. The bar is now portalled to <body>. At 1600 (two
 * columns: `xl` is 1450px), 1440 and 1024 the bar — for a queue row and for a
 * list row — sits whole inside the viewport with every verb visible, under
 * <body>. The queue case uses Trent's layout: a right column taller than the
 * window, the page scrolled. (Playwright's WebKit never clipped it; the
 * structural check is what pins the fix.)
 *
 * Its own user (`queue@opentask.local`, as qr-select-detail): the switch on,
 * lean rows, Today (Trent's view). Unique titles; every task trashed in
 * `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** A `days` one-off made yesterday: it waits in today's Days segment. */
async function daysTask(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title: uniqueTitle(title), horizon: 'days' },
  })
  const id = (await res.json()).data.id as number
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    ).run(id)
  } finally {
    db.close()
  }
  return id
}

/** The bar is whole inside the viewport and every verb in it is visible. */
async function expectWholeBar(page: Page, bar: Locator, verbs: string[]) {
  await expect(bar).toBeVisible()
  const box = (await bar.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  // Wide enough to be the bar, not a sliver of it.
  expect(box.width).toBeGreaterThan(300)
  for (const verb of verbs) {
    const button = bar.getByRole('button', { name: new RegExp(`^${verb}`) }).first()
    await expect(button).toBeVisible()
    await expect(button).toBeInViewport({ ratio: 1 })
    // Not covered by anything: the topmost element at its centre is inside it.
    const b = (await button.boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-selection-sheet]') !== null,
      [b.x + b.width / 2, b.y + b.height / 2],
    )
    expect(hit, `${verb} is on top`).toBe(true)
  }
  // Under <body>: no ancestor can capture or clip a fixed bar (the Mac app's
  // WKWebView clipped it to the sticky right column).
  expect(await bar.evaluate((el) => el.parentElement === document.body)).toBe(true)
  // Every control in the bar, not just the named verbs, is fully on screen.
  for (const button of await bar.getByRole('button').all()) {
    if (await button.isVisible()) await expect(button).toBeInViewport({ ratio: 1 })
  }
  // The title is shown whole enough to read (not clipped away to the left).
  const title = bar.locator('[data-selection-title]')
  if (await title.count()) await expect(title).toBeInViewport({ ratio: 1 })
}

test.describe.configure({ mode: 'serial' })

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

for (const width of [1600, 1440, 1024]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 560 } })

    test('a task-queue row picked: the bar is whole, centred, every verb visible', async ({
      page,
    }) => {
      const id = await daysTask(page, 'SB queue row')
      // A quota splits the dashboard into two columns from xl up, and a
      // reminder puts the Reminders card over the Tasks card in the right one
      // — Trent's layout.
      const make = async (data: Record<string, unknown>) =>
        (await (await page.request.post('/api/tasks', { data })).json()).data.id as number
      const reminder = await make({
        title: uniqueTitle('SB thought'),
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      })
      // Enough quotas that the right column is taller than the (short)
      // window, as on Trent's Mac: the sticky column then pins its bottom (a
      // negative top).
      const quotas: number[] = []
      for (let i = 0; i < 5; i++) {
        quotas.push(
          await make({
            title: uniqueTitle(
              `SB quota ${i} — a long enough title that each chip takes its own line`,
            ),
            is_tracked: true,
            progress_target: 3,
            rrule: 'FREQ=WEEKLY',
          }),
        )
      }
      try {
        await page.goto('/?tasks=days')
        const card = page.locator('[data-tasks-panel]')
        const row = card.locator(`[data-segment-task="${id}"]`)
        await expect(row).toBeVisible()
        await card.getByRole('button', { name: 'Select', exact: true }).click()
        await row.locator('[data-pick-box]').click()
        // Scrolled, as a long page is.
        await page.evaluate(() => window.scrollTo(0, 600))
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
        const bar = page.locator('[data-queue-selection-bar]')
        await expect(bar.locator('[data-selection-title]')).toContainText('SB queue row')
        await page.screenshot({
          path: `.tmp/screens/select-bar-queue-${width}.png`,
          animations: 'disabled',
        })
        await expectWholeBar(page, bar, ['Details', 'Delete'])
      } finally {
        await trash(page, [id, reminder, ...quotas])
      }
    })

    test('a list row picked: the bar is whole, centred, every verb visible', async ({ page }) => {
      const res = await page.request.post('/api/tasks', {
        data: { title: uniqueTitle('SB list row') },
      })
      const id = (await res.json()).data.id as number
      try {
        await page.addInitScript(() =>
          window.localStorage.setItem('opentask_dashboard_mode', 'all'),
        )
        await page.goto('/')
        const row = page.locator(`#task-row-${id}`)
        await row.getByText(/^SB list row/).click({ modifiers: ['ControlOrMeta'] })
        const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
        await expect(bar.locator('[data-selection-title]')).toContainText('SB list row')
        await page.screenshot({
          path: `.tmp/screens/select-bar-list-${width}.png`,
          animations: 'disabled',
        })
        await expectWholeBar(page, bar, ['Details', 'Delete'])
      } finally {
        await trash(page, [id])
      }
    })
  })
}
