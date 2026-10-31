/**
 * "QUEUE TOMORROW" (Trent, 2026-10-31; src/lib/queue-tomorrow.ts): a defer
 * that lands past the next rollover moves the target to the rollover moment
 * and marks the task for tomorrow's queue (B1). Every surface that draws the
 * target says "Queue tomorrow" instead of "Tomorrow 3:00 AM", in the plain
 * target style:
 * - the lean row's chip (blue `target`, never `over`), its menu's Remove
 *   target taking the mark off with the target;
 * - the select bar's meta line, and the details sheet's Target line.
 * A marked task is never in Upcoming (the defer stamps its target as set
 * today, for tomorrow: too short a wait for a heads-up), so the Upcoming
 * row's words are pinned in tests/behavioral/tq-queue-tomorrow.test.ts only.
 *
 * Its own user (`queue@opentask.local`, as qr-select-detail): the switch on,
 * lean rows, All in Newest order. The mark is made the way the defer FAB
 * makes it — a sweep `POST /api/tasks/bulk/snooze` to tomorrow morning.
 * Unique titles; every task trashed in `finally`.
 */
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle, withPreferences } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const QUEUE_TOMORROW = 'Queue tomorrow'

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

/** A Medium one-off over target since yesterday, swept to tomorrow 9:00 AM: marked. */
async function markedTask(page: Page, title: string): Promise<number> {
  const yesterday = await openTaskDay(page, -1)
  const tomorrow = await openTaskDay(page, 1)
  const res = await page.request.post('/api/tasks', {
    data: {
      title: uniqueTitle(title),
      priority: 2,
      due_at: DateTime.fromISO(`${yesterday}T18:00`, { zone: TZ }).toUTC().toISO(),
    },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  const sweep = await page.request.post('/api/tasks/bulk/snooze', {
    data: {
      ids: [id],
      until: DateTime.fromISO(`${tomorrow}T09:00`, { zone: TZ }).toUTC().toISO(),
      source: 'sweep',
    },
  })
  expect(sweep.ok(), await sweep.text()).toBeTruthy()
  expect((await stateOf(page, id)).queue_mark).toBe(true)
  return id
}

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

for (const width of [375, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 812 : 800 } })

    test('the row, the select bar and the details sheet say Queue tomorrow', async ({ page }) => {
      const id = await markedTask(page, 'QT row')
      try {
        await withPreferences(page, { default_grouping: 'new' }, async () => {
          await page.goto('/')
          const row = page.locator(`#task-row-${id}`)
          const chip = row.locator('[data-target-time]')
          await expect(chip).toHaveText(QUEUE_TOMORROW)
          await expect(chip).toHaveAttribute('data-time-chip', 'target')
          await expect(row).not.toHaveAttribute('data-over-target', '')
          await expect(row).not.toContainText('3:00 AM')
          await page.screenshot({
            path: `.tmp/screens/queue-tomorrow-row-${width}.png`,
            animations: 'disabled',
          })

          const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
          await row.getByText(/^QT row/).click({ modifiers: ['ControlOrMeta'] })
          await expect(bar.locator('[data-selection-detail-target]')).toHaveText(QUEUE_TOMORROW)
          await page.screenshot({
            path: `.tmp/screens/queue-tomorrow-bar-${width}.png`,
            animations: 'disabled',
          })

          await bar.locator('[data-selection-open]').click()
          const target = page.locator('[data-quick-panel-date]')
          await expect(target).toContainText(QUEUE_TOMORROW)
          await expect(target).not.toContainText('3:00 AM')
          await page.screenshot({
            path: `.tmp/screens/queue-tomorrow-details-${width}.png`,
            animations: 'disabled',
          })
        })
      } finally {
        await trash(page, [id])
      }
    })
  })
}

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("the chip menu's Remove target takes the mark off with the target", async ({ page }) => {
    const id = await markedTask(page, 'QT remove')
    try {
      await withPreferences(page, { default_grouping: 'new' }, async () => {
        await page.goto('/')
        const row = page.locator(`#task-row-${id}`)
        await row.locator('[data-target-time]').click()
        await page.getByRole('menu').locator('[data-remove-target]').click()
        await expect(row.locator('[data-target-time]')).toHaveCount(0)
        await expect.poll(async () => (await stateOf(page, id)).queue_mark).toBe(false)
        expect((await stateOf(page, id)).due_at).toBeNull()
      })
    } finally {
      await trash(page, [id])
    }
  })
})
