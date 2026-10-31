/**
 * ONE ACTION, THEN OUT (Trent, 2026-10-30: "it was annoying… for individual
 * items because then I have to go back and deselect select mode… It only
 * stays in select mode if you enter select mode with the select button").
 * A selection remembers how it started: a hold on a row is one action, then
 * out (any verb, or deselecting the last row); the queue header's Select keeps
 * the mode through its verbs until Cancel or Select. The list's bar follows
 * the same rule (`useSelectionMode`'s `sticky`).
 *
 * Its own user (`queue@opentask.local`), the switch on, lean rows, at 375.
 * Unique titles; every task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
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

/** `days` one-offs made yesterday (they wait in today's Days segment), with optional notes. */
async function daysTask(page: Page, title: string, notes?: string): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title: uniqueTitle(title), horizon: 'days', ...(notes ? { notes } : {}) },
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

/**
 * Hold a row near its title's start until `shown` holds — on a phone the
 * title's centre can sit under the row's buttons (On deck's own hold).
 */
async function holdRow(page: Page, title: Locator, shown: () => Promise<void>) {
  await title.scrollIntoViewIfNeeded()
  const box = (await title.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 8)
  await page.mouse.down()
  try {
    await shown()
  } finally {
    await page.mouse.up()
  }
}

const card = (page: Page) => page.locator('[data-tasks-panel]')
const row = (page: Page, id: number) => card(page).locator(`[data-segment-task="${id}"]`)
const queueBar = (page: Page) => page.locator('[data-queue-selection-bar]')
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 375, height: 812 } })

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

const toggle = (page: Page) => card(page).locator('[data-queue-select-toggle]')
const pickBoxes = (page: Page) => card(page).locator('[data-pick-box]')

test('a hold, then Done: out of select mode — no bar, no checkboxes', async ({ page }) => {
  const ids = [await daysTask(page, 'HO a'), await daysTask(page, 'HO b')]
  try {
    await page.goto('/')
    await expect(row(page, ids[0])).toBeVisible()
    const bar = queueBar(page)
    await holdRow(page, row(page, ids[0]).getByText(/^HO a/), () => expect(bar).toBeVisible())
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
    await bar.getByRole('button', { name: 'Done' }).click()
    await expect(bar).toHaveCount(0)
    await expect(pickBoxes(page)).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(row(page, ids[1])).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('the Select button, then Done: still in select mode', async ({ page }) => {
  const ids = [await daysTask(page, 'HO c'), await daysTask(page, 'HO d')]
  try {
    await page.goto('/')
    await expect(row(page, ids[0])).toBeVisible()
    await toggle(page).click()
    await row(page, ids[0]).locator('[data-pick-box]').click()
    const bar = queueBar(page)
    await expect(bar).toContainText('1 selected')
    await bar.getByRole('button', { name: 'Done' }).click()
    // The picks go; the mode stays (no bar with nothing picked).
    await expect(bar).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(row(page, ids[1]).locator('[data-pick-box]')).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('a hold, a second pick, then Not today: one action, then out', async ({ page }) => {
  const ids = [await daysTask(page, 'HO e'), await daysTask(page, 'HO f')]
  try {
    await page.goto('/')
    await expect(row(page, ids[0])).toBeVisible()
    const bar = queueBar(page)
    await holdRow(page, row(page, ids[0]).getByText(/^HO e/), () => expect(bar).toBeVisible())
    await row(page, ids[1]).locator('[data-pick-box]').click()
    await expect(bar).toContainText('2 selected')
    await bar.locator('[data-bar-not-today]').click()
    await expect(bar).toHaveCount(0)
    await expect(pickBoxes(page)).toHaveCount(0)
    // Both rows left today, so the card itself may be gone: no Select is on.
    await expect(page.locator('[data-queue-select-toggle][aria-pressed="true"]')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('a hold, then deselecting the row: out of select mode', async ({ page }) => {
  const ids = [await daysTask(page, 'HO g')]
  try {
    await page.goto('/')
    await expect(row(page, ids[0])).toBeVisible()
    const bar = queueBar(page)
    await holdRow(page, row(page, ids[0]).getByText(/^HO g/), () => expect(bar).toBeVisible())
    await row(page, ids[0]).locator('[data-pick-box]').click()
    await expect(bar).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await trash(page, ids)
  }
})

test("the list: a row's selection ends with its horizon change", async ({ page }) => {
  const id = await daysTask(page, 'HO list')
  try {
    await withPreferences(page, { default_grouping: 'new' }, async () => {
      await page.goto('/')
      const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
      await page
        .locator(`#task-row-${id}`)
        .getByText(/^HO list/)
        .click({ modifiers: ['ControlOrMeta'] })
      await expect(bar.locator('[data-selection-title]')).toContainText('HO list')
      await bar.locator('[data-bar-horizon]').click()
      await page.getByRole('menu').locator('[data-horizon-option="weeks"]').click()
      await expect(bar).toHaveCount(0)
    })
  } finally {
    await trash(page, [id])
  }
})
