/**
 * THE TASK QUEUE'S SELECT MODE AND THE U1 BAR (Trent, 2026-10-30;
 * `src/components/QueueSelect.tsx`, `SelectionBarShell`): "Select" in the
 * queue card's header turns it on; the rows trade their circles for
 * checkboxes; the bar comes up only once something is picked — Consider ·
 * Done · Target · Not today · Deck · Details · Delete · More, in ONE row at a
 * 375 phone; Not today takes the picked rows off today with one Undo; Cancel
 * leaves the mode. The list's own bar is the same object with its six verbs.
 *
 * Its own user (`queue@opentask.local`, as rp-row-peek): the switch on, lean
 * rows. Unique titles; every task trashed in `finally`.
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
      data: { title: uniqueTitle(`SM row ${i}`), horizon: 'days' },
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

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('Select: checkboxes, a bar only once picked, eight verbs in one row; Not today with Undo; Cancel leaves', async ({
    page,
  }) => {
    const ids = await daysTasks(page, 3)
    try {
      await page.goto('/')
      await expect(row(page, ids[0])).toBeVisible()
      const toggle = card(page).locator('[data-queue-select-toggle]')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      // Checkboxes for circles, no buttons; no bar with nothing picked.
      await expect(row(page, ids[0]).locator('[data-pick-box]')).toBeVisible()
      await expect(row(page, ids[0]).locator('[data-segment-actions]')).toHaveCount(0)
      await expect(queueBar(page)).toHaveCount(0)

      // Pick two (a tap on the row, and on its box).
      await row(page, ids[0])
        .getByText(/^SM row 0/)
        .click()
      await row(page, ids[1]).locator('[data-pick-box]').click()
      await expect(row(page, ids[0]).locator('[data-pick-box]')).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await expect(queueBar(page)).toContainText('2 selected')
      const verbs = queueBar(page).locator(
        '[data-selection-actions] > button, [data-selection-actions] > div > button',
      )
      await expect(verbs).toHaveText([
        'Consider',
        'Done',
        'Target',
        'Not today',
        'Deck',
        'Details',
        'Delete',
      ])
      await expect(queueBar(page).locator('[data-bar-more]')).toBeVisible()
      // One row at 375: every verb on the same line, none past the screen.
      const boxes = await verbs.evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect()
          return { top: Math.round(r.top), right: r.right, label: e.textContent }
        }),
      )
      expect(new Set(boxes.map((b) => b.top)).size).toBe(1)
      for (const b of boxes) expect(b.right, b.label ?? '').toBeLessThanOrEqual(375)
      // Each word inside its own button: none runs into its neighbour.
      const overflow = await verbs.evaluateAll((els) =>
        els
          .filter((e) => {
            const word = e.querySelector('span')!.getBoundingClientRect()
            const own = e.getBoundingClientRect()
            return word.left < own.left - 0.5 || word.right > own.right + 0.5
          })
          .map((e) => e.textContent),
      )
      expect(overflow).toEqual([])
      await page.screenshot({
        path: '.tmp/screens/select-bar-queue-375.png',
        animations: 'disabled',
      })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({
        path: '.tmp/screens/select-bar-queue-375-dark.png',
        animations: 'disabled',
      })
      await page.emulateMedia({ colorScheme: 'light' })

      // Not today: both leave today's list, one Undo puts them back.
      await queueBar(page).getByRole('button', { name: 'Not today' }).click()
      await expect(row(page, ids[0])).toHaveCount(0)
      await expect(row(page, ids[1])).toHaveCount(0)
      await expect
        .poll(async () => (await stateOf(page, ids[0])).segment_deferred_at)
        .not.toBeNull()
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Not today: 2 tasks' })
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(row(page, ids[0])).toBeVisible()
      await expect.poll(async () => (await stateOf(page, ids[0])).segment_deferred_at).toBeNull()

      // Still in the mode after a verb: pick one and Consider it.
      await row(page, ids[2]).locator('[data-pick-box]').click()
      await queueBar(page).getByRole('button', { name: 'Consider' }).click()
      await expect.poll(async () => (await stateOf(page, ids[2])).last_considered_at).not.toBeNull()

      // Cancel leaves the mode: circles and buttons back.
      await row(page, ids[0]).locator('[data-pick-box]').click()
      await queueBar(page).getByRole('button', { name: 'Cancel selection' }).click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'false')
      await expect(card(page).locator('[data-pick-box]')).toHaveCount(0)
      await expect(queueBar(page)).toHaveCount(0)
    } finally {
      await trash(page, ids)
    }
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test("the list's bar: Done · Target · Deck · Details · Delete · More, Cancel leaves", async ({
    page,
  }) => {
    const ids = await daysTasks(page, 2)
    try {
      await page.goto('/')
      // A lean row: Cmd-click its title (the fixture's spot is the horizon square).
      for (const id of ids) {
        await page
          .locator(`#task-row-${id}`)
          .getByText(/^SM row/)
          .click({ modifiers: ['ControlOrMeta'] })
      }
      const bar = page.locator('[data-selection-sheet]')
      await expect(bar).toContainText('2 selected')
      const verbs = bar.locator(
        '[data-selection-actions] > button, [data-selection-actions] > div > button',
      )
      await expect(verbs).toHaveText(['Done', 'Target', 'Deck', 'Details', 'Delete'])
      // More: the "⋯" beside Cancel, on the count's line.
      await expect(bar.locator('[data-bar-more]')).toBeVisible()
      await page.screenshot({
        path: '.tmp/screens/select-bar-list-1280.png',
        animations: 'disabled',
      })
      await page.setViewportSize({ width: 375, height: 812 })
      await page.screenshot({
        path: '.tmp/screens/select-bar-list-375.png',
        animations: 'disabled',
      })
      await page.setViewportSize({ width: 1280, height: 800 })
      // Target: T1's menu, titled for the selection.
      await bar.getByRole('button', { name: 'Target' }).click()
      await expect(page.getByRole('menu', { name: 'Target · 2 tasks options' })).toBeVisible()
      await page.keyboard.press('Escape')
      await bar.getByRole('button', { name: 'Cancel selection' }).click()
      await expect(bar).toHaveCount(0)
    } finally {
      await trash(page, ids)
    }
  })
})

test.describe("Trent's phone", () => {
  // An iPhone 16 Pro at the app's 119% text (ios/OpenTask/WebView.swift).
  test.use({ viewport: { width: 402, height: 874 } })

  test('select mode never widens the page: the sweeps step aside, nothing scrolls sideways', async ({
    page,
  }) => {
    const ids = await daysTasks(page, 13)
    try {
      await page.request.post('/api/task-segments/consider', { data: { ids: ids.slice(0, 2) } })
      await page.goto('/')
      await page.evaluate(() => (document.documentElement.style.fontSize = '19.04px'))
      await expect(row(page, ids[5])).toBeVisible()
      // Open the header: its sweeps (Considered all, Not today, all) show.
      await card(page).locator('[data-slot-header-toggle]').click()
      const sweeps = card(page).getByRole('button', { name: /^(Mark all|Not today: all)/ })
      await expect(sweeps).toHaveCount(2)
      await card(page).locator('[data-queue-select-toggle]').click()
      // Selecting: the bar has Consider and Not today; the header drops its sweeps.
      await expect(sweeps).toHaveCount(0)
      await row(page, ids[5]).locator('[data-pick-box]').click()
      await row(page, ids[6]).locator('[data-pick-box]').click()
      await expect(queueBar(page)).toContainText('2 selected')
      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        header: Math.round(
          document
            .querySelector('[data-tasks-panel] [data-slot-header-toggle]')!
            .parentElement!.getBoundingClientRect().right,
        ),
      }))
      expect(width.scroll).toBeLessThanOrEqual(width.client)
      expect(width.header).toBeLessThanOrEqual(width.client)
      await page.setViewportSize({ width: 375, height: 812 })
      // "TASK QUEUE" on one line at 375 and 119% text: the header's gaps give
      // way in select mode (`compact`), the title is never truncated.
      const titleLines = await card(page)
        .locator('[data-slot-header-toggle] span span')
        .first()
        .evaluate((e) => e.getClientRects().length)
      expect(titleLines).toBe(1)
      await page.screenshot({ path: '.tmp/screens/select-header-375.png', animations: 'disabled' })
    } finally {
      await trash(page, ids)
    }
  })
})
