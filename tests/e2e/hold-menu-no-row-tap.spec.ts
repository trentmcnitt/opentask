/**
 * A HOLD MENU'S CHOICE IS THE MENU'S, NEVER A TAP ON THE ROW (Trent,
 * 2026-10-30, on his phone): he held an overdue lean row's clock, the Defer
 * sheet opened, he tapped "Tomorrow" — the task deferred, and its details
 * opened too, every time.
 *
 * The cause, found in the iOS Simulator: the sheet is portaled into <body>,
 * but React bubbles its events up the COMPONENT tree — clock → row — so the
 * option's click reached the row's own click handler, which reads a click as
 * a tap (the details) once the row has seen a touch. Rows now ignore presses
 * whose target their DOM does not hold (`fromPortal`, `useLongPress.ts`).
 *
 * The row must have seen a touch first (any touch scroll over it does), which
 * is why plain emulation never showed it. The lean row, the task queue on,
 * the Today view, a touch-emulated phone. Unique titles; trashed in `finally`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { CDPSession, Locator, Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true })
test.beforeEach(async ({ request, authenticatedPage: page }) => {
  const res = await request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
  await page.addInitScript(() => window.localStorage.setItem('opentask_task_rows', 'lean'))
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

type Point = { x: number; y: number }
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })

async function centre(l: Locator): Promise<Point> {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function dueAt(page: Page, id: number): Promise<string | null> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data.due_at
}

test('hold the clock, tap Tomorrow: the task defers and its details do not open', async ({
  authenticatedPage: page,
}) => {
  const res = await page.request.post('/api/tasks', {
    data: {
      title: uniqueTitle('HM overdue'),
      due_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
  })
  const id = (await res.json()).data.id as number
  try {
    const before = await dueAt(page, id)
    await page.goto('/')
    await page.locator('[data-mode="today"]').click()
    const row = page.locator(`#task-row-${id}`)
    const clock = row.locator('[data-lean-defer]')
    await expect(clock).toBeVisible()
    const cdp = await page.context().newCDPSession(page)

    // A finger has been on the row: a short drag over its title, as a scroll.
    const t = await centre(row.locator('[data-lean-title]'))
    await touch(cdp, 'touchStart', [t])
    await touch(cdp, 'touchMove', [{ x: t.x, y: t.y - 30 }])
    await touch(cdp, 'touchEnd', [])
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)

    // Hold the clock until the Defer sheet is up, then let go.
    await touch(cdp, 'touchStart', [await centre(clock)])
    const sheet = page.getByRole('dialog', { name: 'Defer' })
    await expect(sheet).toBeVisible()
    await touch(cdp, 'touchEnd', [])

    // Tap Tomorrow with a finger.
    const tomorrow = sheet.getByRole('button', { name: /^Tomorrow/ })
    await touch(cdp, 'touchStart', [await centre(tomorrow)])
    await touch(cdp, 'touchEnd', [])

    await expect(page.getByText(/^Deferred to /).first()).toBeVisible()
    await expect.poll(() => dueAt(page, id)).not.toBe(before)
    // No sheet of any kind is left: not the menu, not the task's details.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    // Nor did the press select the row (a long press that reached it would).
    await expect(page.locator('[data-selection-sheet]')).toHaveCount(0)
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
  }
})
