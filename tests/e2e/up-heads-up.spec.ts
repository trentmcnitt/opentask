/**
 * HEADS UP OFF (Trent, 2026-11-02): a per-task switch; off, the task never
 * shows in Upcoming. Set in the task details ("Heads up") and from the select
 * bar's ⋯ More ("Turn off heads-up" / "Turn on heads-up", one Undo). An
 * Upcoming row whose switch goes off leaves the page at once; Undo brings it
 * back.
 *
 * Its own user (`queue@opentask.local`, the switch on), lean rows, a phone
 * (402). A task targeted tomorrow, its target set 10 days ago (past the
 * minimum wait) so it is in Upcoming's Tomorrow today. Unique titles; every
 * task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
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

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

/** A task targeted tomorrow at 10:00 whose target was set 10 days ago: in Upcoming's Tomorrow. */
async function tomorrowTask(page: Page, title: string): Promise<number> {
  const tomorrow = await openTaskDay(page, 1)
  const res = await page.request.post('/api/tasks', {
    data: {
      title: uniqueTitle(title),
      target_at: DateTime.fromISO(`${tomorrow}T10:00`, { zone: TZ }).toUTC().toISO(),
    },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const ago = new Date(Date.now() - 10 * 86_400_000).toISOString()
    db.prepare('UPDATE tasks SET target_set_at = ?, created_at = ? WHERE id = ?').run(ago, ago, id)
  } finally {
    db.close()
  }
  return id
}

/** An item of the bar's ⋯ More (a sheet of buttons at a phone's width). */
const moreItem = (page: Page, name: RegExp) =>
  page.getByRole('dialog', { name: 'More' }).getByRole('button', { name })

const upcomingRow = (page: Page, id: number) =>
  page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 402, height: 874 } })

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

test('the details switch turns heads-up off: the task leaves Upcoming, its target kept', async ({
  page,
}) => {
  const id = await tomorrowTask(page, 'HU details')
  try {
    await page.goto('/?tasks=upcoming')
    await expect(upcomingRow(page, id)).toBeVisible()
    // Open its details from the row: the widget's link brings it into view
    // (without selecting it), then a double-click opens it.
    await page.goto(`/?task=${id}&highlight=1`)
    await page
      .locator(`#task-row-${id}`)
      .getByText(/^HU details/)
      .dblclick()
    const dialog = page.getByRole('dialog')
    const toggle = dialog.locator('[data-quick-panel-heads-up]')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await dialog.screenshot({
      path: '.tmp/screens/heads-up-toggle-on-402.png',
      animations: 'disabled',
    })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(dialog).toContainText('Never in Upcoming')
    await dialog.screenshot({
      path: '.tmp/screens/heads-up-toggle-off-402.png',
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await stateOf(page, id)).heads_up).toBe(false)
    // Membership only: the target is where it was.
    expect((await stateOf(page, id)).target_at).not.toBeNull()
    // Out of Upcoming (the server's segments: the card may have nothing left to draw).
    const segs = (await (await page.request.get('/api/reminders?queue=1&deck=1')).json()).data
      .task_segments as { horizon: string; tasks: { id: number }[] }[]
    const upcoming = segs.find((seg) => seg.horizon === 'upcoming')?.tasks ?? []
    expect(upcoming.map((t) => t.id)).not.toContain(id)
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
  }
})

test("the queue bar's ⋯ Turn off heads-up: the Upcoming row leaves at once; Undo brings it back", async ({
  page,
}) => {
  const id = await tomorrowTask(page, 'HU queue')
  try {
    await page.goto('/?tasks=upcoming')
    const card = page.locator('[data-tasks-panel]')
    const row = upcomingRow(page, id)
    await expect(row).toBeVisible()
    await card.getByRole('button', { name: 'Select', exact: true }).click()
    await row.locator('[data-pick-box]').click()
    const bar = page.locator('[data-queue-selection-bar]')
    await bar.locator('[data-bar-more]').click()
    // At a phone's width the ⋯ menu is a sheet of buttons.
    const item = moreItem(page, /^Turn off heads-up/)
    await expect(item).toBeVisible()
    await page.screenshot({
      path: '.tmp/screens/heads-up-more-queue-402.png',
      animations: 'disabled',
    })
    await item.click()
    await expect(row).toHaveCount(0)
    await expect.poll(async () => (await stateOf(page, id)).heads_up).toBe(false)
    const toast = page.locator('[data-sonner-toast]', { hasText: 'Heads-up off' })
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await stateOf(page, id)).heads_up).toBe(true)
    await expect(row).toBeVisible()
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
  }
})

test("the main list bar's ⋯ offers it too, and Turn on when it is off", async ({ page }) => {
  const id = await tomorrowTask(page, 'HU list')
  try {
    await page.goto('/')
    const row = page.locator(`#task-row-${id}`)
    await row.getByText(/^HU list/).click({ modifiers: ['ControlOrMeta'] })
    const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
    await bar.locator('[data-bar-more]').click()
    await moreItem(page, /^Turn off heads-up/).click()
    await expect.poll(async () => (await stateOf(page, id)).heads_up).toBe(false)
    await row.getByText(/^HU list/).click({ modifiers: ['ControlOrMeta'] })
    await bar.locator('[data-bar-more]').click()
    const on = moreItem(page, /^Turn on heads-up/)
    await expect(on).toBeVisible()
    await page.screenshot({
      path: '.tmp/screens/heads-up-more-list-402.png',
      animations: 'disabled',
    })
    await on.click()
    await expect.poll(async () => (await stateOf(page, id)).heads_up).toBe(true)
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
  }
})
