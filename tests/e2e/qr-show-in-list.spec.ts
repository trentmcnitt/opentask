/**
 * SHOW IN LIST (Trent, 2026-10-30; `src/lib/show-in-list.ts`): the queue row
 * bubble's button next to Open. On the dashboard it switches the list to All
 * (the modes on), scrolls to the task's row and flashes it; from /reminders it
 * opens the dashboard and does the same. A filter that hides the row is said
 * out loud — a toast with "Clear" — never cleared or skipped silently.
 *
 * Its own user (`queue@opentask.local`, as rp-row-peek): the task-queue switch
 * on, lean rows (and with them the modes) on this device, Today the mode to
 * start from. Unique titles; every task trashed in `finally`.
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

/** A `days` one-off made yesterday: it waits in today's Days segment at any hour. */
async function daysTask(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { title, horizon: 'days' } })
  expect(res.ok()).toBeTruthy()
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

const bubble = (page: Page, id: number) => page.locator(`[data-task-peek="${id}"]`)
const listRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)
const allMode = (page: Page) => page.locator('[data-mode-switch] [data-mode="all"]')

/** Hold the row open, then press the bubble's Show in list. */
async function showInList(page: Page, row: Locator, id: number, title: string) {
  await expect(row).toBeVisible()
  // Held near the title's start: on a phone its centre can sit under the
  // row's buttons (the title wraps around them).
  const text = row.getByText(title)
  await text.scrollIntoViewIfNeeded()
  const box = (await text.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 8)
  await page.mouse.down()
  try {
    await expect(bubble(page, id)).toBeVisible()
  } finally {
    await page.mouse.up()
  }
  const b = bubble(page, id)
  await expect(b.getByRole('button', { name: 'Open' })).toBeVisible()
  await b.getByRole('button', { name: 'Show in list' }).click()
  await expect(b).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 } })

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

test('on the dashboard: the list switches to All and its row is scrolled to and flashed', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('SIL dashboard')
    const id = await daysTask(page, title)
    ids.push(id)
    await page.goto('/')
    await expect(page.locator('[data-mode-switch] [data-mode="today"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Today doesn't list an undated Days task: All does.
    await expect(listRow(page, id)).toHaveCount(0)
    const cardRow = page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)
    await showInList(page, cardRow, id, title)
    await expect(allMode(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(listRow(page, id)).toHaveAttribute('data-task-highlight', '')
    // It visibly lights up (the lean row had the hook but not the class, 2026-10-30).
    await expect(listRow(page, id)).toHaveClass(/animate-row-highlight/)
    await expect(listRow(page, id)).toBeInViewport()
    // Show, not act: nothing selected, nothing opened.
    await expect(listRow(page, id)).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('a filter that hides the row is said out loud, with Clear; Clear shows it', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('SIL filtered')
    const id = await daysTask(page, title)
    ids.push(id)
    // The overdue filter: an undated task isn't in it.
    await page.goto('/?filter=overdue')
    const cardRow = page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)
    await showInList(page, cardRow, id, title)
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'hidden by your filters' })
    await expect(toast).toContainText(title)
    // Nothing moved under the user: still filtered, no row flashed.
    await expect(listRow(page, id)).toHaveCount(0)
    await toast.getByRole('button', { name: 'Clear' }).click()
    await expect(listRow(page, id)).toHaveAttribute('data-task-highlight', '')
    await expect(listRow(page, id)).toBeInViewport()
  } finally {
    await trash(page, ids)
  }
})

test('from /reminders: it opens the dashboard on All with the row flashed', async ({ page }) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('SIL reminders')
    const id = await daysTask(page, title)
    ids.push(id)
    await page.goto('/reminders')
    const row = page.locator(
      `[data-task-segments] [data-task-segment="days"] [data-segment-task="${id}"]`,
    )
    await showInList(page, row, id, title)
    await expect(page).toHaveURL('/')
    await expect(allMode(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(listRow(page, id)).toHaveAttribute('data-task-highlight', '')
    await expect(listRow(page, id)).toBeInViewport()
  } finally {
    await trash(page, ids)
  }
})

test.describe('phone, dark', () => {
  test.use({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' })

  test('from /reminders the row lights up, blue, on the dashboard', async ({ page }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('SIL phone')
      const id = await daysTask(page, title)
      ids.push(id)
      await page.goto('/reminders')
      const row = page.locator(
        `[data-task-segments] [data-task-segment="days"] [data-segment-task="${id}"]`,
      )
      await showInList(page, row, id, title)
      await expect(page).toHaveURL('/')
      const target = listRow(page, id)
      await expect(allMode(page)).toHaveAttribute('aria-pressed', 'true')
      await expect(target).toHaveClass(/animate-row-highlight/)
      await expect(target).toBeInViewport()
      // Lit while it holds: the ring is the highlight's blue, not transparent.
      await expect
        .poll(() => target.evaluate((e) => getComputedStyle(e).boxShadow))
        .toMatch(/rgb\(96, 165, 250\)/)
      await page.screenshot({ path: '.tmp/screens/show-in-list-375-dark.png' })
    } finally {
      await trash(page, ids)
    }
  })
})
