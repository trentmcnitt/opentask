/**
 * THE SELECT BAR'S DETAILS AND HORIZON (Trent, 2026-10-30; mockups
 * `.tmp/select-detail/`, `src/components/SelectionDetail.tsx`):
 * - L1: a hold on a queue card row enters select mode with that row picked —
 *   no bubble — and the bar opens with the task: title, meta line, notes
 *   (only when it has some), Open · Show in list. A second pick drops them.
 * - The horizon is a control in that meta line ("● Days ⌄") opening the task
 *   details' own menu; with several picked it sits beside ⋯ — the shared
 *   horizon, or "Mixed" (nothing marked) — and a pick sets them all in ONE
 *   request.
 * - The main list's bar is the same object.
 *
 * Its own user (`queue@opentask.local`, as qr-select-mode): the switch on,
 * lean rows, at 375. Unique titles; every task trashed in `finally`.
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

async function horizonOf(page: Page, id: number): Promise<string | null> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data.horizon
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
/** Every bulk/edit request the page sends, counted. */
function countBulkEdits(page: Page): () => number {
  let n = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks/bulk/edit') n++
  })
  return () => n
}

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

test('a hold picks the row; the bar shows the task, notes only when it has some; its horizon menu sets it', async ({
  page,
}) => {
  const withNotes = await daysTask(
    page,
    'SD noted',
    'Called the office: they need the printed form before they can issue it.',
  )
  const bare = await daysTask(page, 'SD bare')
  const ids = [withNotes, bare]
  try {
    await page.goto('/')
    await expect(row(page, withNotes)).toBeVisible()
    const bar = queueBar(page)

    // L1: the hold picks the row — no bubble — and the bar opens with it.
    await holdRow(page, row(page, withNotes).getByText(/^SD noted/), () =>
      expect(bar).toBeVisible(),
    )
    await expect(page.locator('[data-task-peek]')).toHaveCount(0)
    await expect(row(page, withNotes).locator('[data-pick-box]')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(bar.locator('[data-selection-title]')).toContainText('SD noted')
    await expect(bar).toContainText('1 selected')
    await expect(bar.locator('[data-selection-detail-notes]')).toContainText('printed form')
    await expect(bar.locator('[data-selection-open]')).toBeVisible()
    await expect(bar.locator('[data-selection-show-in-list]')).toBeVisible()
    await expect(bar.locator('[data-bar-horizon="days"]')).toContainText('Days')
    await page.screenshot({
      path: '.tmp/screens/select-detail-notes-375.png',
      animations: 'disabled',
    })

    // Without notes: no notes line.
    await bar.getByRole('button', { name: 'Cancel selection' }).click()
    await expect(bar).toHaveCount(0)
    await holdRow(page, row(page, bare).getByText(/^SD bare/), () => expect(bar).toBeVisible())
    await expect(bar.locator('[data-selection-title]')).toContainText('SD bare')
    await expect(bar.locator('[data-selection-detail-notes]')).toHaveCount(0)
    await page.screenshot({
      path: '.tmp/screens/select-detail-bare-375.png',
      animations: 'disabled',
    })

    // The horizon: the task details' own menu, Days marked; a pick sets it.
    const edits = countBulkEdits(page)
    await bar.locator('[data-bar-horizon]').click()
    const menu = page.getByRole('menu')
    await expect(menu.locator('[data-horizon-option="days"]')).toHaveAttribute(
      'data-state',
      'checked',
    )
    await expect(menu.locator('[data-horizon-option="unset"]')).toBeVisible()
    await page.screenshot({
      path: '.tmp/screens/select-detail-horizon-375.png',
      animations: 'disabled',
    })
    await menu.locator('[data-horizon-option="months"]').click()
    await expect.poll(() => horizonOf(page, bare)).toBe('months')
    expect(edits()).toBe(1)
    await expect(page.getByText(/^Horizon: Months/).first()).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('a second pick drops the details; the shared horizon sits beside ⋯ and sets both at once', async ({
  page,
}) => {
  const ids = [await daysTask(page, 'SD one'), await daysTask(page, 'SD two')]
  try {
    await page.goto('/')
    await expect(row(page, ids[0])).toBeVisible()
    const bar = queueBar(page)
    await holdRow(page, row(page, ids[0]).getByText(/^SD one/), () => expect(bar).toBeVisible())
    await expect(bar.locator('[data-selection-title]')).toBeVisible()
    // Select mode is on: a tap picks the second.
    await row(page, ids[1]).locator('[data-pick-box]').click()
    await expect(bar).toContainText('2 selected')
    await expect(bar.locator('[data-selection-title]')).toHaveCount(0)
    await expect(bar.locator('[data-selection-detail]')).toHaveCount(0)
    const control = bar.locator('[data-bar-horizon]')
    await expect(control).toHaveAttribute('data-bar-horizon', 'days')
    const edits = countBulkEdits(page)
    await control.click()
    await page.getByRole('menu').locator('[data-horizon-option="weeks"]').click()
    await expect.poll(() => horizonOf(page, ids[0])).toBe('weeks')
    expect(await horizonOf(page, ids[1])).toBe('weeks')
    expect(edits()).toBe(1)
    await expect(page.getByText('Horizon: Weeks · 2 tasks').first()).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test("the main list's bar: one task's details; mixed horizons say Mixed, nothing marked", async ({
  page,
}) => {
  const days = await daysTask(page, 'SD list days')
  const res = await page.request.post('/api/tasks', {
    data: { title: uniqueTitle('SD list months'), horizon: 'months' },
  })
  const months = (await res.json()).data.id as number
  const ids = [days, months]
  try {
    await withPreferences(page, { default_grouping: 'new' }, async () => {
      await page.goto('/')
      const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
      // Cmd-click on the title (the row's lower-left can be its horizon dot).
      const pick = (id: number, title: RegExp) =>
        page
          .locator(`#task-row-${id}`)
          .getByText(title)
          .click({ modifiers: ['ControlOrMeta'] })
      await pick(days, /^SD list days/)
      await expect(bar.locator('[data-selection-title]')).toContainText('SD list days')
      await expect(bar.locator('[data-bar-horizon="days"]')).toBeVisible()
      await pick(months, /^SD list months/)
      await expect(bar).toContainText('2 selected')
      const control = bar.locator('[data-bar-horizon]')
      await expect(control).toHaveAttribute('data-bar-horizon', 'mixed')
      await expect(control).toContainText('Mixed')
      await control.click()
      const menu = page.getByRole('menu')
      await expect(menu.locator('[data-state="checked"]')).toHaveCount(0)
      await page.screenshot({
        path: '.tmp/screens/select-detail-mixed-375.png',
        animations: 'disabled',
      })
      await menu.locator('[data-horizon-option="days"]').click()
      await expect.poll(() => horizonOf(page, months)).toBe('days')
    })
  } finally {
    await trash(page, ids)
  }
})
