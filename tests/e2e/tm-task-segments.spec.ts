/**
 * Task segments on the reminders screen, and the dashboard's over-target marks
 * (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * A task created today waits for its segment's next day (creating it counts as
 * seeing it), so each spec makes its tasks with a `days` horizon and moves
 * their `created_at` back a day (`backdateCreated`) — a days segment comes
 * round every day, so they are waiting today at any hour.
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`. Checks read the server back over the API rather than trusting a
 * row leaving the screen.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, backdateCreated, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data as Record<string, unknown>
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const segmentRow = (page: Page, id: number) =>
  page.locator('[data-task-segments]').locator(`[data-segment-task="${id}"]`)

test.describe('Task segments', () => {
  test('sit under the slots on /reminders; circle considers, Today targets, Defer all defers', async ({
    authenticatedPage: page,
  }) => {
    const titles = ['A', 'B', 'C'].map((s) => uniqueTitle(`TM seg ${s}`))
    const ids: number[] = []
    for (const title of titles) ids.push(await create(page, { title, horizon: 'days' }))
    backdateCreated(ids, { inSegments: true })
    try {
      await page.goto('/reminders')
      const days = page.locator('[data-task-segment="days"]')
      await expect(days).toBeVisible()
      for (const id of ids) await expect(segmentRow(page, id)).toBeVisible()

      // Under the reminder slots (Trent, 10-11): below the last slot card.
      const slot = page.locator('[data-slot-key]').last()
      if (await slot.count()) {
        const segBox = await days.boundingBox()
        const slotBox = await slot.boundingBox()
        expect(segBox!.y).toBeGreaterThan(slotBox!.y)
      }

      // Circle → considered (never a completion).
      await segmentRow(page, ids[0])
        .getByRole('button', { name: /as considered/ })
        .click()
      // It leaves the list, like a considered reminder, so the next row moves
      // up under the pointer.
      await expect(segmentRow(page, ids[0])).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, ids[0])).last_considered_at).not.toBeNull()
      expect((await stateOf(page, ids[0])).done).toBe(false)

      // Today → a target today; the row leaves the segment.
      await segmentRow(page, ids[1])
        .getByRole('button', { name: /^Target .* today$/ })
        .click()
      await expect(segmentRow(page, ids[1])).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, ids[1])).target_at).not.toBeNull()

      // Defer all → off today's list, not considered.
      await days.getByRole('button', { name: 'Defer all' }).click()
      await expect(segmentRow(page, ids[2])).toHaveCount(0)
      await expect
        .poll(async () => (await stateOf(page, ids[2])).segment_deferred_at)
        .not.toBeNull()
      expect((await stateOf(page, ids[2])).last_considered_at).toBeNull()
      // Defer all never touches a row already considered.
      expect((await stateOf(page, ids[0])).segment_deferred_at).toBeNull()
    } finally {
      await trash(page, ids)
    }
  })

  test('counts "X of Y"; Show considered lists the considered rows and puts one back', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    for (const s of ['A', 'B']) {
      ids.push(await create(page, { title: uniqueTitle(`TM put back ${s}`), horizon: 'days' }))
    }
    backdateCreated(ids, { inSegments: true })
    try {
      await page.goto('/reminders')
      const days = page.locator('[data-task-segment="days"]')
      const count = days.getByLabel(/^\d+ of \d+ considered$/)
      await expect(count).toBeVisible()
      const before = (await count.getAttribute('aria-label'))!.match(/^(\d+) of (\d+)/)!
      await segmentRow(page, ids[0])
        .getByRole('button', { name: /as considered/ })
        .click()
      await expect(segmentRow(page, ids[0])).toHaveCount(0)
      // The considered count climbs; the segment's size stays put.
      await expect(count).toHaveAttribute(
        'aria-label',
        `${Number(before[1]) + 1} of ${before[2]} considered`,
      )

      // Folded by default; open it and put the row back.
      const considered = days.locator(`[data-considered-task-id="${ids[0]}"]`)
      await expect(considered).toHaveCount(0)
      await days.locator('[data-segment-considered-toggle]').click()
      await expect(considered).toBeVisible()
      await considered.getByRole('button', { name: /^Put back/ }).click()
      await expect(segmentRow(page, ids[0])).toBeVisible()
      await expect.poll(async () => (await stateOf(page, ids[0])).last_considered_at).toBeNull()
    } finally {
      await trash(page, ids)
    }
  })

  test('the horizon chip changes the horizon', async ({ authenticatedPage: page }) => {
    const id = await create(page, { title: uniqueTitle('TM horizon'), horizon: 'days' })
    backdateCreated([id], { inSegments: true })
    try {
      await page.goto('/reminders')
      await segmentRow(page, id).locator('[data-horizon-chip]').click()
      await page.getByRole('menuitemradio', { name: 'Months' }).click()
      await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('months')
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Dashboard over-target marks', () => {
  test('the age tab counts days since the first target; a passed deadline is marked', async ({
    authenticatedPage: page,
  }) => {
    const threeDaysAgo = new Date(Date.now() - 3 * DAY - 60_000).toISOString()
    const id = await create(page, {
      title: uniqueTitle('TM aged'),
      target_at: threeDaysAgo,
      deadline_at: new Date(Date.now() - DAY).toISOString(),
    })
    // On the list for a week: the age never counts from before the task
    // existed (2026-10-11), and the API can't create one in the past.
    const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
    try {
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 7 * DAY).toISOString(),
        id,
      )
    } finally {
      db.close()
    }
    try {
      await page.goto('/')
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      await expect(row.locator('[data-target-age]')).toHaveText(/^[34]d$/)
      await expect(row).toContainText('past deadline')
    } finally {
      await trash(page, [id])
    }
  })
})
