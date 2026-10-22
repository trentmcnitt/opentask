/**
 * The FAB column clears the toast on a phone (Trent's phone review,
 * 2026-10-22, IMG_8857; `useToastClearance`, `DashboardFabStack`): the
 * full-width toast above the tab bar sat across the snooze FAB. While a toast
 * is up the column lifts above it and drops back after; on a wide screen the
 * centred toast never reaches the column and it does not move.
 *
 * Measured by bounding boxes: every FAB's bottom edge above every toast's top
 * edge, with no horizontal-and-vertical overlap, at 320, 375 and 390.
 *
 * The queue's own user: an over-target task (so the snooze FAB shows) and a
 * Days-horizon task whose consider raises a toast. Isolation: unique titles,
 * every task trashed in `finally`.
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

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

function madeYesterday(ids: number[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    )
    for (const id of ids) stmt.run(id)
  } finally {
    db.close()
  }
}

type Box = { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** The FAB column's buttons and the live toasts, as boxes. */
async function boxes(page: Page): Promise<{ fabs: Box[]; toasts: Box[] }> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const fabs = [...document.querySelectorAll('[data-fab-stack] button')]
      .filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 0 && getComputedStyle(b).visibility !== 'hidden'
      })
      .map(rect)
    const toasts = [...document.querySelectorAll('[data-sonner-toast]')]
      .filter((t) => (t as HTMLElement).dataset.removed !== 'true')
      .map(rect)
    return { fabs, toasts }
  })
}

const fabStack = (page: Page) => page.locator('[data-fab-stack]')
const considerButton = (row: Locator) => row.getByRole('button', { name: /as considered/ })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

for (const width of [320, 375, 390]) {
  test(`phone ${width}: the FAB column lifts above the toast, then drops back`, async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      ids.push(
        await create(page, {
          title: uniqueTitle('TF over'),
          target_at: new Date(Date.now() - 3600_000).toISOString(),
        }),
      )
      const days = await create(page, { title: uniqueTitle('TF days'), horizon: 'days' })
      ids.push(days)
      madeYesterday([days])
      await page.setViewportSize({ width, height: 844 })
      await page.goto('/')
      await expect(fabStack(page).locator('button').last()).toBeVisible()
      const restingBottom = (await fabStack(page).boundingBox())!

      await considerButton(page.locator(`[data-segment-task="${days}"]`)).click()
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Considered' })
      await expect(toast).toHaveAttribute('data-mounted', 'true')
      await expect(fabStack(page)).toHaveAttribute('data-toast-lifted', '')
      // Once both have settled: no FAB over any toast, every FAB above it.
      await expect
        .poll(async () => {
          const { fabs, toasts } = await boxes(page)
          if (fabs.length === 0 || toasts.length === 0) return 'nothing to measure'
          const top = Math.min(...toasts.map((t) => t.y))
          const clash = fabs.some((f) => toasts.some((t) => overlaps(f, t)))
          const below = fabs.some((f) => f.y + f.height > top)
          return clash || below ? 'overlap' : 'clear'
        })
        .toBe('clear')

      // The toast goes (tap to dismiss): the column drops back to rest.
      await toast.locator('[data-title]').click()
      await expect(fabStack(page)).not.toHaveAttribute('data-toast-lifted', '')
      await expect
        .poll(async () => Math.round((await fabStack(page).boundingBox())!.y))
        .toBe(Math.round(restingBottom.y))
    } finally {
      if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    }
  })
}

test('desktop 1280: a toast does not move the FAB column', async ({ page }) => {
  const ids: number[] = []
  try {
    ids.push(
      await create(page, {
        title: uniqueTitle('TF over'),
        target_at: new Date(Date.now() - 3600_000).toISOString(),
      }),
    )
    const days = await create(page, { title: uniqueTitle('TF days'), horizon: 'days' })
    ids.push(days)
    madeYesterday([days])
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await expect(fabStack(page).locator('button').last()).toBeVisible()
    const before = (await fabStack(page).boundingBox())!
    await considerButton(page.locator(`[data-segment-task="${days}"]`)).click()
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Considered' })
    await expect(toast).toHaveAttribute('data-mounted', 'true')
    await expect(fabStack(page)).not.toHaveAttribute('data-toast-lifted', '')
    const after = (await fabStack(page).boundingBox())!
    expect(after.y).toBe(before.y)
    const { fabs, toasts } = await boxes(page)
    expect(fabs.some((f) => toasts.some((t) => overlaps(f, t)))).toBe(false)
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
