/**
 * NOTHING ON THE DASHBOARD IS WIDER THAN THE SCREEN (Trent, 2026-10-30). One
 * task title ending in a long URL laid its last word out ~735px wide (the row
 * kept the last word on one line, `whitespace-nowrap`); the document grew past
 * the phone, and the iOS app let him pan the whole dashboard sideways — in
 * every view that showed the row, and with a row long-pressed into select
 * mode. The last word is `TITLE_TAIL` now; this pins it on each dashboard
 * view at 375 and 402, at the app's 119% text, with a long-URL title, a long
 * plain title and a labelled one.
 *
 * The lean row (production's). Unique titles; every task trashed in `finally`. Today / Scan / All is
 * client state (`useDashboardMode`), so switching it saves nothing.
 */
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { CDPSession, Page } from '@playwright/test'

const LONG_URL =
  'https://example.com/an-invented-path-long-enough-to-run-past-any-phone-screen/1234567890'

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  return (await res.json()).data.id as number
}

/**
 * The first box that reaches past the screen's right edge, if any. Not
 * `scrollWidth`: html and body clip sideways now, and a clipped box adds no
 * scrollable width in Chromium — yet the iOS app still panned over one.
 * Boxes inside their own sideways scroller (a chip row) are that scroller's
 * business and skipped.
 */
function pastEdge(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const inScroller = (e: Element) => {
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') return true
      }
      return false
    }
    const past = [...document.querySelectorAll('body *')].find((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.right > vw + 0.5 && !inScroller(e)
    })
    return past ? `${past.tagName} "${(past.textContent ?? '').trim().slice(0, 40)}"` : null
  })
}

/** The dashboard modes' stable ids, in the switch's order. */
function modeIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-mode]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')!))
}

async function seed(page: Page): Promise<number[]> {
  return [
    // The URL LAST: the title's last word is what the row kept on one line.
    await create(page, { title: `${uniqueTitle('NS read this later')} ${LONG_URL}` }),
    await create(page, {
      title: uniqueTitle(
        'NS a long plain title that wraps across several lines on a phone and keeps going a while',
      ),
      priority: 3,
    }),
    await create(page, {
      title: uniqueTitle('NS overdue'),
      due_at: new Date(Date.now() - 3_600_000).toISOString(),
    }),
  ]
}

// The lean row, as production builds it (`NEXT_PUBLIC_DEFAULT_TASK_ROWS`): the
// dashboard modes come with it.
// The task queue on, as in production (and `dashboard-modes.spec.ts`).
test.describe.configure({ mode: 'serial' })
test.beforeEach(async ({ request, authenticatedPage: page }) => {
  const res = await request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
  await page.addInitScript(() => window.localStorage.setItem('opentask_task_rows', 'lean'))
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

for (const width of [375, 402]) {
  test.describe(`${width}px at 119%`, () => {
    test.use({ viewport: { width, height: 874 }, hasTouch: true, isMobile: true })

    test('Today, Scan and All never widen the page', async ({ authenticatedPage: page }) => {
      const ids = await seed(page)
      try {
        await withPreferences(page, { default_grouping: 'new' }, async () => {
          await page.goto('/')
          await page.evaluate(() => (document.documentElement.style.fontSize = '19.04px'))
          await expect(page.locator('[data-mode-switch]')).toBeVisible()
          const modes = await modeIds(page)
          expect(modes.length).toBeGreaterThan(1)
          for (const mode of modes) {
            await page.locator(`[data-mode="${mode}"]`).click()
            await expect(page.locator(`[data-mode="${mode}"]`)).toHaveAttribute(
              'aria-pressed',
              'true',
            )
            if (mode === 'all') await expect(page.locator(`#task-row-${ids[0]}`)).toBeVisible()
            expect(await pastEdge(page), mode).toBeNull()
          }
        })
      } finally {
        await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
      }
    })

    test('a long-press into select mode never widens the page', async ({
      authenticatedPage: page,
    }) => {
      const ids = await seed(page)
      try {
        await withPreferences(page, { default_grouping: 'new' }, async () => {
          await page.goto('/')
          await page.evaluate(() => (document.documentElement.style.fontSize = '19.04px'))
          await page.locator('[data-mode="all"]').click()
          const r = page.locator(`#task-row-${ids[0]}`)
          await r.scrollIntoViewIfNeeded()
          const box = (await r.boundingBox())!
          const cdp: CDPSession = await page.context().newCDPSession(page)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.x + 80, y: box.y + box.height / 2 }],
          })
          await expect(r).toHaveAttribute('aria-selected', 'true')
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect(page.locator('[data-selection-sheet]')).toContainText('1 selected')
          expect(await pastEdge(page), 'select mode').toBeNull()
          expect(await page.evaluate(() => window.scrollX)).toBe(0)
          if (width === 402)
            await page.screenshot({ path: '.tmp/screens/select-longpress-402.png' })
        })
      } finally {
        await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
      }
    })
  })
}
