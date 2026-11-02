/**
 * CMD- AND SHIFT-CLICK PICK ON THE TASK QUEUE (Trent, 2026-11-02: "anytime
 * you're on the task queue, Shift-clicking or Command-clicking … should enable
 * select mode and select that, just like it does on tasks";
 * `QueueModifierPick` in src/components/QueueSelect.tsx): Cmd-click turns the
 * mode on with the row picked, or toggles it; Shift-click picks the range
 * from the last-clicked row in the page on screen; a selection a modifier
 * started is one action, then out (the list's rule); the row's own buttons
 * keep their clicks; a plain click still considers.
 *
 * Its own user (`queue@opentask.local`): the switch on, lean rows, 1280.
 * Unique titles; every task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

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

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

/** `days` one-offs made yesterday: they wait in today's Days segment at any hour. */
async function daysTasks(page: Page, n: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueTitle(`MS row ${i}`), horizon: 'days' },
    })
    ids.push((await res.json()).data.id as number)
  }
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    )
    for (const id of ids) stmt.run(id)
  } finally {
    db.close()
  }
  return ids
}

const card = (page: Page) => page.locator('[data-tasks-panel]')
const row = (page: Page, id: number) => card(page).locator(`[data-segment-task="${id}"]`)
const queueBar = (page: Page) => page.locator('[data-queue-selection-bar]')

test.describe.configure({ mode: 'serial' })

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

const picked = (page: Page, id: number) => row(page, id).locator('[data-pick-box]')
const title = (page: Page, id: number) => row(page, id).getByText(/^MS row /)

test.use({ viewport: { width: 1280, height: 860 } })

test('Cmd-click turns the mode on with the row picked; again, it toggles off and the mode leaves', async ({
  page,
}) => {
  const ids = await daysTasks(page, 3)
  try {
    await page.goto('/?tasks=days')
    await expect(row(page, ids[0])).toBeVisible()
    await title(page, ids[0]).click({ modifiers: ['ControlOrMeta'] })
    await expect(picked(page, ids[0])).toHaveAttribute('aria-checked', 'true')
    await expect(card(page).locator('[data-queue-select-toggle]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(queueBar(page)).toContainText('1 selected')
    // Not considered: a modifier never considers.
    expect((await stateOf(page, ids[0])).last_considered_at ?? null).toBeNull()
    await page.screenshot({ path: '.tmp/screens/queue-cmd-click-1280.png', animations: 'disabled' })
    // Another Cmd-click adds; one on a picked row takes it off.
    await title(page, ids[1]).click({ modifiers: ['ControlOrMeta'] })
    await expect(queueBar(page)).toContainText('2 selected')
    await title(page, ids[1]).click({ modifiers: ['ControlOrMeta'] })
    await title(page, ids[0]).click({ modifiers: ['ControlOrMeta'] })
    // The last one off: a modifier's selection leaves the mode.
    await expect(queueBar(page)).toHaveCount(0)
    await expect(row(page, ids[0]).locator('[data-pick-box]')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('Shift-click picks the range from the last-clicked row; one bar action, then out', async ({
  page,
}) => {
  const ids = await daysTasks(page, 4)
  try {
    await page.goto('/?tasks=days')
    await expect(row(page, ids[0])).toBeVisible()
    // The rows' drawn order (the segment's sort), to know what lies between.
    const order = await card(page)
      .locator('[data-segment-task][data-segment-state="waiting"]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-segment-task'))))
    const mine = order.filter((id) => ids.includes(id))
    const [first, last] = [mine[0], mine[mine.length - 1]]
    const between = order.slice(order.indexOf(first), order.indexOf(last) + 1)
    await title(page, first).click({ modifiers: ['ControlOrMeta'] })
    await title(page, last).click({ modifiers: ['Shift'] })
    for (const id of between) await expect(picked(page, id)).toHaveAttribute('aria-checked', 'true')
    await expect(queueBar(page)).toContainText(`${between.length} selected`)
    // One action (Consider), then out: the list's rule for a modifier's selection.
    await queueBar(page).locator('[data-bar-consider]').click()
    await expect(queueBar(page)).toHaveCount(0)
    await expect(card(page).locator('[data-queue-select-toggle]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await expect.poll(async () => (await stateOf(page, last)).last_considered_at).toBeTruthy()
  } finally {
    await trash(page, ids)
  }
})

test("a modifier-click on the row's own buttons is the button's; a plain click still considers", async ({
  page,
}) => {
  const ids = await daysTasks(page, 2)
  try {
    await page.goto('/?tasks=days')
    await expect(row(page, ids[0])).toBeVisible()
    // Cmd-click on the done square: done, no select mode.
    await row(page, ids[0])
      .getByRole('button', { name: /^Done:/ })
      .click({ modifiers: ['ControlOrMeta'] })
    await expect.poll(async () => (await stateOf(page, ids[0])).done).toBe(true)
    await expect(queueBar(page)).toHaveCount(0)
    await expect(card(page).locator('[data-queue-select-toggle]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    // A plain click: considered, as ever.
    await title(page, ids[1]).click()
    await expect.poll(async () => (await stateOf(page, ids[1])).last_considered_at).toBeTruthy()
    await expect(queueBar(page)).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})
